import 'dotenv/config';
import { resolve } from 'node:path';

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};
const optional = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const productionSecret = (key:string,nodeEnv:string):string|undefined => {
  const value=optional(key);
  if(!value&&nodeEnv==='production')return required(key);
  if(value&&value.length<32)throw new Error(`Environment variable ${key} must be at least 32 characters`);
  return value;
};
export const booleanEnvironment = (key:string,fallback:boolean):boolean => {
  const raw=optional(key)?.toLowerCase();
  if(raw===undefined)return fallback;
  if(raw==='true')return true;
  if(raw==='false')return false;
  throw new Error(`Environment variable ${key} must be true or false`);
};
const positiveInt = (key:string, fallback:number): number => {
  const raw = optional(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Environment variable ${key} must be a positive integer`);
  return parsed;
};
const tcpPort = (key:string, fallback:number):number => {
  const parsed=positiveInt(key,fallback);
  if(parsed>65_535)throw new Error(`Environment variable ${key} must be a valid TCP port`);
  return parsed;
};
const applicationOrigin=(nodeEnv:string):string=>{
  const raw=optional('APP_ORIGIN')??(nodeEnv==='production'?required('APP_ORIGIN'):'http://localhost:5173');
  let parsed:URL;try{parsed=new URL(raw)}catch{throw new Error('APP_ORIGIN must be an absolute http(s) origin')}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw new Error('APP_ORIGIN must be an absolute http(s) origin with no path, query, or fragment');
  return parsed.origin;
};

export interface SmtpConfig {
  readonly host:string; readonly port:number; readonly from:string;
  readonly auth:{readonly user:string;readonly pass:string}|null;
}

export interface Config {
  nodeEnv:string; host:string; port:number; dbPath:string; uploadDir:string; jwtSecret:string;
  appOrigin:string; auditKey:string; providerCredentialKey:string; providerCredentialKeyVersion:number;
  providerCredentialPreviousKeys:Readonly<Record<number,string>>;
  proxySharedSecret:string|undefined;
  retentionEnforcementEnabled:boolean;
  smtp:SmtpConfig|null;
}

// Null, not a half-filled object: a host without a From produces messages every relay rejects, and
// Callers ask this one question ("can we send mail?") before offering email-based recovery.
function smtpSettings():SmtpConfig|null {
  const host=optional('SMTP_HOST'),from=optional('SMTP_FROM'),port=optional('SMTP_PORT');
  const user=optional('SMTP_USER'),pass=optional('SMTP_PASS');
  if (!host&&!from&&!port&&!user&&!pass) return null;
  if (!host||!from) throw new Error('SMTP_HOST and SMTP_FROM must be configured together');
  if (Boolean(user)!==Boolean(pass)) throw new Error('SMTP_USER and SMTP_PASS must be configured together');
  return {host,port:tcpPort('SMTP_PORT',587),from,auth:user&&pass?{user,pass}:null};
}

export function loadConfig(): Config {
  const nodeEnv=optional('NODE_ENV')??'development';
  const previousRaw=optional('PROVIDER_CREDENTIAL_PREVIOUS_KEYS');
  let providerCredentialPreviousKeys:Record<number,string>={};
  if(previousRaw){
    let parsed:unknown;try{parsed=JSON.parse(previousRaw);}catch{throw new Error('PROVIDER_CREDENTIAL_PREVIOUS_KEYS must be a JSON object');}
    if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('PROVIDER_CREDENTIAL_PREVIOUS_KEYS must be a JSON object');
    for(const [version,value] of Object.entries(parsed)){
      const number=Number(version);if(!Number.isSafeInteger(number)||number<=0||typeof value!=='string'||!value.trim())throw new Error('PROVIDER_CREDENTIAL_PREVIOUS_KEYS must map positive integer versions to non-empty keys');
      providerCredentialPreviousKeys[number]=value.trim();
    }
  }
  return {
    nodeEnv,
    host: optional('HOST') ?? '127.0.0.1',
    port: tcpPort('PORT',3010),
    dbPath: optional('DB_PATH')===':memory:'?':memory:':resolve(optional('DB_PATH') ?? './data/app.db'),
    uploadDir: resolve(optional('UPLOAD_DIR') ?? './data/uploads'),
    jwtSecret: required('JWT_SECRET'),
    appOrigin: applicationOrigin(nodeEnv),
    auditKey: optional('AUDIT_KEY') ?? (nodeEnv === 'production' ? required('AUDIT_KEY') : 'development-only-audit-key-change-before-production'),
    providerCredentialKey:optional('PROVIDER_CREDENTIAL_KEY')??(nodeEnv==='production'?required('PROVIDER_CREDENTIAL_KEY'):'development-only-provider-credential-key-change-before-production'),
    providerCredentialKeyVersion:positiveInt('PROVIDER_CREDENTIAL_KEY_VERSION',1),
    providerCredentialPreviousKeys:Object.freeze(providerCredentialPreviousKeys),
    proxySharedSecret:productionSecret('PROXY_SHARED_SECRET',nodeEnv),
    // An upgraded deployment does not have this variable. Defaulting absent to false prevents a
    // newly installed worker from silently deleting a pre-existing 90-day backlog on first boot.
    retentionEnforcementEnabled:booleanEnvironment('RETENTION_ENFORCEMENT_ENABLED',false),
    smtp:smtpSettings(),
  };
}

export const config = loadConfig();
