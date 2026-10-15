import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

type StoredDetectorKind='keyword'|'pii'|'secret'|'source_code'|'classification'|'injection'|'semantic'|'institution';
type Direction='outbound'|'inbound';
type Action='flag'|'redact'|'warn'|'block';
type Severity='low'|'medium'|'high'|'critical';
interface DefaultRule {readonly direction:Direction;readonly action:Action;readonly severity:Severity;readonly enabled?:boolean}
interface DefaultDetector {readonly key:string;readonly kind:StoredDetectorKind;readonly config:Readonly<Record<string,unknown>>;readonly enabled?:boolean;readonly rules:readonly DefaultRule[]}

export const defaultPolicy={
  name:'Default enterprise protection',
  description:'Balanced baseline protection for sensitive data, credentials, classified content, source code, and prompt injection',
  detectors:[
    // A warning makes broad business labels visible without training users to disable the gateway over routine internal prose.
    {key:'default-sensitive-terms',kind:'keyword',config:{terms:['company confidential','do not distribute'],regexes:[],wholeWord:false,maxMatches:20},rules:[{direction:'outbound',action:'warn',severity:'high'},{direction:'inbound',action:'flag',severity:'medium'}]},
    // Structured identifiers can be replaced precisely, preserving the conversation while keeping the original out of transport and display.
    {key:'default-pii',kind:'pii',config:{categories:['email','phone','credit_card','iban','passport','date_of_birth','postal_address','vin','ip_address','drivers_license_us','jp_drivers_license','jp_residence_card'],minimumConfidence:'medium'},rules:[{direction:'outbound',action:'redact',severity:'high'},{direction:'inbound',action:'redact',severity:'high'}]},
    // National identity numbers should not leave the organisation at all, and Japan restricts collecting Individual Numbers outright.
    {key:'default-national-ids',kind:'pii',config:{categories:['national_id','ssn_us','tw_national_id','tw_resident_id','jp_my_number'],minimumConfidence:'medium'},rules:[{direction:'outbound',action:'block',severity:'critical'},{direction:'inbound',action:'redact',severity:'high'}]},
    // Business registry numbers are public but can reveal a customer list, so they are recorded without interrupting work.
    {key:'default-business-ids',kind:'pii',config:{categories:['tw_business_id','jp_corporate_number'],minimumConfidence:'medium'},rules:[{direction:'outbound',action:'flag',severity:'low'}]},
    // Transmitting or displaying a live credential is itself an incident, so secrets fail closed in either direction.
    {key:'default-secrets',kind:'secret',config:{categories:['aws_access_key','aws_secret_key','gcp_credential','azure_credential','private_key','connection_string','jwt','api_token','high_entropy'],minimumTokenLength:20,entropyThresholdBitsPerChar:3.5},rules:[{direction:'outbound',action:'block',severity:'critical'},{direction:'inbound',action:'block',severity:'critical'}]},
    // Code detection is heuristic and legitimate coding use is common, so the baseline records it without interrupting work.
    {key:'default-source-code',kind:'source_code',config:{minimumLines:5,minimumScore:6,proprietaryMarkers:[]},rules:[{direction:'outbound',action:'flag',severity:'medium'},{direction:'inbound',action:'flag',severity:'low'}]},
    // An explicit RESTRICTED or CONFIDENTIAL header is an intentional handling instruction; crossing the gateway must stop.
    {key:'default-classification',kind:'classification',config:{blockedLevels:['confidential','restricted'],documentHeaderLines:10},rules:[{direction:'outbound',action:'block',severity:'critical'},{direction:'inbound',action:'block',severity:'critical'}]},
    // Injection can compromise provider instructions outbound or smuggle hostile instructions back inbound, so both paths block.
    {key:'default-prompt-injection',kind:'injection',config:{threshold:6,includeFileContent:true},rules:[{direction:'outbound',action:'block',severity:'critical'},{direction:'inbound',action:'block',severity:'critical'}]},
    // Semantic classification adds provider latency and cost; disabled rows make the capability discoverable without silently enabling either.
    {key:'default-semantic',kind:'semantic',config:{policyText:'Detect organization-specific sensitive content.'},enabled:false,rules:[{direction:'outbound',action:'flag',severity:'medium',enabled:false}]},
    {key:'default-institution-names',kind:'institution',config:{categories:['medical_facility','educational_institution']},rules:[{direction:'outbound',action:'flag',severity:'low'}]},
  ] satisfies readonly DefaultDetector[],
} as const;

function uuidv7(now:number):string {const bytes=randomBytes(16),time=BigInt(now);for(let index=5;index>=0;index--){bytes[index]=Number(time>>BigInt((5-index)*8)&255n)}bytes[6]=(bytes[6]!&15)|112;bytes[8]=(bytes[8]!&63)|128;const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}

export function seedDefaultPolicy(database:Database.Database,input:{tenantId:string;createdByUserId:string;now:number;id?:(label:string)=>string}):void {
  const id=input.id??(()=>uuidv7(input.now)),policyId=id('default-policy');
  database.prepare('INSERT INTO policies(id,tenant_id,name,description,enabled,priority,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,1000,?,?,?)').run(policyId,input.tenantId,defaultPolicy.name,defaultPolicy.description,input.createdByUserId,input.now,input.now);
  const insertDetector=database.prepare('INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)');
  const insertRule=database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,?,?,?,?,?,1000,?,?)");
  for(const detector of defaultPolicy.detectors){const detectorId=id(`default-detector-${detector.key}`),config=JSON.stringify(detector.config),enabled=detector.enabled===false?0:1;insertDetector.run(detectorId,input.tenantId,detector.key,detector.kind,config,createHash('sha256').update(config).digest('hex'),enabled,input.now,input.now);detector.rules.forEach((rule,index)=>insertRule.run(id(`default-rule-${detector.key}-${rule.direction}-${index}`),input.tenantId,policyId,detectorId,rule.direction,rule.action,rule.severity,config,'enabled' in rule&&rule.enabled===false?0:1,input.now,input.now));}
}
