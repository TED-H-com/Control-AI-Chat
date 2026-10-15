import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService, type AuditService, type AuditTransaction } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import type { TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { GATE_ACTION_RANK } from '../../lib/gate/action.js';
import { GovernanceLedger } from '../../lib/governance/index.js';
import type { ChatProvider, ChatRequest, StreamEvent } from '../../lib/providers/types.js';
import type { TenantId } from '../../shared/types.js';
import { analyticsBreakdown, prepareAnalyticsStatements } from '../admin/analytics.js';
import { ApprovalReleaseWorker } from './approval-release.js';
import { openApprovalEnvelope, openApprovalResult, sealApprovalEnvelope } from './approval-envelope.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,7,9,12),KEY=Buffer.alloc(32,19);

function verdict(context:GateContext):GateVerdict {
  const rules=context.policySnapshot.rules,action=rules.reduce((result,rule)=>GATE_ACTION_RANK[rule.action]>GATE_ACTION_RANK[result]?rule.action:result,'allow' as GateVerdict['action']),matches=rules.map(rule=>({matchId:randomUUID(),detectorId:'release-test',detectorKind:rule.detectorKind,ruleId:rule.id,ruleRevision:rule.revision,partId:context.parts[0]!.id,category:'test',action:rule.action,confidence:'high' as const,span:null,normalizedFingerprint:'opaque',safeExcerpt:'[RESTRICTED]',replacementLabel:null,metadata:{}}));
  const confirmed=action==='warn'&&Boolean(context.confirmedWarningToken),allowed=['allow','flag','redact','mask'].includes(action)||confirmed;
  return {evaluationId:context.evaluationId,pass:context.pass,action,disposition:action==='require_approval'?'pending_approval':action==='warn'&&!confirmed?'await_user_confirmation':action==='block'?'blocked':context.pass==='preflight'?'allow_provider_call':'release_to_user',matches,providerParts:allowed&&context.pass==='preflight'?context.parts:null,displayParts:allowed&&context.pass==='postflight'?context.parts:null,redactions:[],masks:[],warningToken:action==='warn'&&!confirmed?'warning-token':null,approvalRequestId:action==='require_approval'?randomUUID():null,policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:context.policySnapshot.fingerprint,degraded:false,failureCodes:[],timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};
}

interface Fixture {database:Database.Database;tenantId:TenantId;userId:string;modelId:string;ruleId:string;fileWarnRuleId:string|null;approvalId:string;runId:string;sourceMessageId:string;sourceAssistantId:string;attachment:{fileId:string;projectId:string;text:string}|null;providerState:{calls:number;returns:number;active:number;maxActive:number;mode:'success'|'hang'|'oversize'|'throw';blockedTenants:Set<string>;errors:string[];requests:ChatRequest[];afterOutput:()=>void};gateState:{hangRelease:boolean;afterPhase:(phase:string)=>void};gateContexts:GateContext[];clock:{now:number};audit:AuditService;app:GovernedChatApplication;restartApp():GovernedChatApplication;context:TenantContext;request:{content:string;key:string;hash:string};worker(options?:{audit?:AuditService;providerTimeoutMs?:number;maxResponseCodePoints?:number;concurrency?:number;pollMs?:number}):ApprovalReleaseWorker}

async function fixture(options:{warnOverlap?:boolean;attachment?:boolean;outboundMatchesApprovedFileRule?:boolean;fileWarnThenApproval?:boolean;modelScope?:boolean;routedMode?:'single'|'multi_model';credentialSource?:'platform'|'byok';content?:string;tone?:'default'|'concise'|'detailed'|'formal'|'friendly';role?:'default'|'coach'|'creative'|'critic'|'debate'|'support'}={}):Promise<Fixture>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const routedMode=options.routedMode??'single';
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),providerConfigId=randomUUID(),policyId=randomUUID(),detectorId=randomUUID(),ruleId=randomUUID(),budgetId=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Release test','active',?,?)").run(tenantId,`release-${tenantId.slice(0,8)}`,NOW,NOW);
  database.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantId,NOW);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)").run(userId,tenantId,'release@example.test','Release User','x',NOW,NOW);
  let attachment:Fixture['attachment']=null;const withAttachment=options.attachment||options.fileWarnThenApproval;
  if(withAttachment){
    const projectId=randomUUID(),fileId=randomUUID(),text='employee secret in an attached document',sha256=createHash('sha256').update(text).digest('hex');
    database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Release project',?,?)").run(projectId,tenantId,userId,NOW,NOW);
    database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at) VALUES(?,?,?,?,? ,?,'text/plain',?,?, 'ready',?,?)").run(fileId,tenantId,projectId,userId,'approval.txt',`release/${fileId}`,Buffer.byteLength(text),sha256,text,NOW);
    attachment={fileId,projectId,text};
  }
  database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(groupId,tenantId,'Members',NOW,NOW);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,userId,NOW);
  database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai','release-model','Release model',1,1,4096,128,1000,2000,'[]',?,?)").run(modelId,tenantId,NOW,NOW);
  let floorModelId:string|null=null;
  if(routedMode){
    const selectedKey=routedMode==='single'?'gpt-5.6-sol':'gpt-5.6-luna';
    const selectedVersion=database.prepare("SELECT id FROM platform_model_versions WHERE provider_key='openai' AND model_key=? AND authoritative=1").pluck().get(selectedKey) as string;
    database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(selectedVersion);
    database.prepare('UPDATE model_catalog SET model_key=?,platform_model_version_id=? WHERE tenant_id=? AND id=?').run(selectedKey,selectedVersion,tenantId,modelId);
    if(routedMode==='single'){
      floorModelId=randomUUID();const floorVersion=database.prepare("SELECT id FROM platform_model_versions WHERE provider_key='openai' AND model_key='gpt-5.6-luna' AND authoritative=1").pluck().get() as string;
      database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(floorVersion);
      database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'openai','gpt-5.6-luna','Fast floor',1,0,4096,128,1,1,'[]',?,?,?)").run(floorModelId,tenantId,floorVersion,NOW,NOW);
    }
  }
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'openai',1,'encrypted','fixture',1,?,?)").run(providerConfigId,tenantId,NOW,NOW);
  database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,modelId);
  if(floorModelId)database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,floorModelId);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,providerConfigId);
  if(routedMode==='multi_model'){
    const anthropicModel=randomUUID(),anthropicConfig=randomUUID(),version=database.prepare("SELECT id FROM platform_model_versions WHERE provider_key='anthropic' AND model_key='claude-haiku-4-5-20251001' AND authoritative=1").pluck().get() as string;
    database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(version);
    database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'anthropic','claude-haiku-4-5-20251001','Fast B',1,0,4096,128,1,1,'[]',?,?,?)").run(anthropicModel,tenantId,version,NOW,NOW);
    database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'anthropic',1,'encrypted','fixture',1,?,?)").run(anthropicConfig,tenantId,NOW,NOW);
    database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,anthropicModel);
    database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,anthropicConfig);
  }
  database.prepare('INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(policyId,tenantId,'Release policy',NOW,NOW);
  database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detectorId,tenantId,'release-test','a'.repeat(64),NOW,NOW);
  database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,'outbound','require_approval','critical','{}',1,100,?,?)").run(ruleId,tenantId,policyId,detectorId,options.modelScope?'model':'group',options.modelScope?modelId:groupId,NOW,NOW);
  const fileWarnRuleId=options.fileWarnThenApproval?randomUUID():null;
  if(fileWarnRuleId)database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'file','warn','medium','{}',1,90,?,?)").run(fileWarnRuleId,tenantId,policyId,detectorId,groupId,NOW,NOW);
  if(options.warnOverlap)database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'outbound','warn','medium','{}',1,90,?,?)").run(randomUUID(),tenantId,policyId,detectorId,groupId,NOW,NOW);
  database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,hard_limit,timezone,created_at,updated_at) VALUES(?,?,'tenant',NULL,'daily','tokens',10000,'UTC',?,?)").run(budgetId,tenantId,NOW,NOW);
  const gateContexts:GateContext[]=[],gateState:{hangRelease:boolean;afterPhase:(phase:string)=>void}={hangRelease:false,afterPhase:()=>{}};
  const gate:GateEngine={async evaluate(context){gateContexts.push(context);const phase=typeof context.metadata.approvalReleasePhase==='string'?context.metadata.approvalReleasePhase:'';if(gateState.hangRelease&&phase)await new Promise<void>(()=>{});if(phase)gateState.afterPhase(phase);if(withAttachment&&phase==='outbound_recheck'&&!options.outboundMatchesApprovedFileRule&&!options.fileWarnThenApproval){const allowed=verdict({...context,policySnapshot:{...context.policySnapshot,rules:[]}});return{...allowed,policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:context.policySnapshot.fingerprint};}return verdict(context);},createPostflightStream(){throw new Error('unused');}};
  const clock={now:NOW};
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>clock.now});
  const providerState:{calls:number;returns:number;active:number;maxActive:number;mode:'success'|'hang'|'oversize'|'throw';blockedTenants:Set<string>;errors:string[];requests:ChatRequest[];afterOutput:()=>void}={calls:0,returns:0,active:0,maxActive:0,mode:'success',blockedTenants:new Set(),errors:[],requests:[],afterOutput:()=>{}};
  const provider:ChatProvider={id:'openai',protocols:['openai_responses'],configured:true,supports(){return true;},stream(_request:ChatRequest):AsyncGenerator<StreamEvent>{
    providerState.calls++;providerState.active++;providerState.maxActive=Math.max(providerState.maxActive,providerState.active);providerState.requests.push(_request);
    let closed=false;const close=()=>{if(closed)return;closed=true;providerState.active--;};
    if(providerState.mode==='hang'||providerState.blockedTenants.has(_request.context.tenantId)){
      const hanging={next:()=>new Promise<IteratorResult<StreamEvent>>(()=>{}),return:async()=>{providerState.returns++;close();return{done:true,value:undefined};},throw:async(error?:unknown)=>{close();throw error;},[Symbol.asyncIterator](){return this;}};
      return hanging as AsyncGenerator<StreamEvent>;
    }
    return (async function*(){try{yield{type:'start',requestId:'release-request',providerRequestId:'provider-release',model:'release-model',createdAt:clock.now};if(providerState.mode==='throw')throw new Error('upstream failed with private detail');yield{type:'text_delta',index:0,delta:providerState.mode==='oversize'?'0123456789':'Released response'};providerState.afterOutput();yield{type:'usage',usage:{inputTokens:12,outputTokens:3,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:15,estimated:false,source:'provider'}};yield{type:'finish',reason:'stop'};}finally{close();}})();
  },health(){return{configured:true,circuit:'closed',recentFailureRate:0};}};
  const providers={get:()=>provider};
  const tenantProviders={resolve:()=>({provider,credentialSource:options.credentialSource??(database.prepare("SELECT credential_source FROM provider_config WHERE tenant_id=? AND provider_key='openai'").pluck().get(tenantId)==='encrypted'?'byok':'platform')})};
  const context={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  const app=new GovernedChatApplication({database,gate,providers,tenantProviders,audit,approvalPayloadKey:KEY,now:()=>NOW});
  const content=options.content??'employee secret requiring approval',key=randomUUID(),hash=createHash('sha256').update(content).digest('hex');
  const prepared=await app.createRun(context,{content,...(routedMode==='multi_model'?{mode:'multi_model' as const}:{modelId}),clientRequestId:randomUUID(),tone:options.tone??'default',role:options.role??'default',...(attachment?{projectId:attachment.projectId,fileIds:[attachment.fileId]}:{})},'create',{key,requestHash:hash,method:'POST',path:'/chat/runs'});
  let gated=await app.gate(context,{direction:'outbound',text:content,runId:prepared.run.id},new AbortController().signal);
  if(options.fileWarnThenApproval){assert.equal(gated.action,'warn');assert.equal(gated.direction,'file');assert.ok(gated.confirmationToken);assert.ok(await app.authorizeWarnedRun(context,gated.decisionId,{token:gated.confirmationToken,policyFingerprint:app.policyFingerprint(context)}));gated=await app.gate(context,{direction:'outbound',text:content,runId:prepared.run.id},new AbortController().signal);}
  assert.equal(gated.action,'require_approval');assert.ok(gated.approvalId);
  const approvalId=gated.approvalId;
  database.prepare("UPDATE policy_approval_requests SET status='approved',decision_by_user_id=?,decision_reason_code='approved',decision_note='Reviewed',decided_at_ms=?,release_phase='queued',release_next_attempt_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?").run(userId,NOW,NOW,tenantId,approvalId);
  database.prepare("UPDATE gate_decisions SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note='Reviewed' WHERE tenant_id=? AND id=?").run(userId,NOW,tenantId,gated.decisionId);
  const worker=(workerOptions:{audit?:AuditService;providerTimeoutMs?:number;maxResponseCodePoints?:number;concurrency?:number;pollMs?:number}={})=>new ApprovalReleaseWorker({database,gate,providers,tenantProviders,audit:workerOptions.audit??audit,approvalPayloadKey:KEY,now:()=>clock.now,logger:{error(...values){providerState.errors.push(values.map(String).join(' '));},warn(){}},...(workerOptions.providerTimeoutMs===undefined?{}:{providerTimeoutMs:workerOptions.providerTimeoutMs}),...(workerOptions.maxResponseCodePoints===undefined?{}:{maxResponseCodePoints:workerOptions.maxResponseCodePoints}),...(workerOptions.concurrency===undefined?{}:{concurrency:workerOptions.concurrency}),...(workerOptions.pollMs===undefined?{}:{pollMs:workerOptions.pollMs})});
  const restartApp=()=>new GovernedChatApplication({database,gate,providers,tenantProviders,audit,approvalPayloadKey:KEY,now:()=>clock.now});
  return{database,tenantId,userId,modelId,ruleId,fileWarnRuleId,approvalId,runId:prepared.run.id,sourceMessageId:prepared.run.userMessageId,sourceAssistantId:prepared.run.assistantMessageId!,attachment,providerState,gateState,gateContexts,clock,audit,app,restartApp,context,request:{content,key,hash},worker};
}

async function addApprovedRun(f:Fixture,label:string):Promise<{tenantId:TenantId;approvalId:string;runId:string}> {
  const content=`${label} employee secret requiring approval`,prepared=await f.app.createRun(f.context,{content,modelId:f.modelId,clientRequestId:randomUUID()},'create',{key:randomUUID(),requestHash:createHash('sha256').update(content).digest('hex'),method:'POST',path:'/chat/runs'});
  const gated=await f.app.gate(f.context,{direction:'outbound',text:content,runId:prepared.run.id},new AbortController().signal);assert.equal(gated.action,'require_approval');assert.ok(gated.approvalId);
  f.database.prepare("UPDATE policy_approval_requests SET status='approved',decision_by_user_id=?,decision_reason_code='approved',decision_note='Reviewed',decided_at_ms=?,release_phase='queued',release_next_attempt_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?").run(f.userId,f.clock.now,f.clock.now,f.tenantId,gated.approvalId);
  f.database.prepare("UPDATE gate_decisions SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note='Reviewed' WHERE tenant_id=? AND id=?").run(f.userId,f.clock.now,f.tenantId,gated.decisionId);
  return{tenantId:f.tenantId,approvalId:gated.approvalId,runId:prepared.run.id};
}

interface ApprovedTenantRun {tenantId:TenantId;approvalId:string;runId:string;userId:string;modelId:string;context:TenantContext}

async function addApprovedSubjectRun(f:Fixture,subject:Pick<ApprovedTenantRun,'tenantId'|'userId'|'modelId'|'context'>,label:string):Promise<{tenantId:TenantId;approvalId:string;runId:string}> {
  const content=`${label} employee secret requiring approval`,key=randomUUID(),hash=createHash('sha256').update(content).digest('hex');
  const prepared=await f.app.createRun(subject.context,{content,modelId:subject.modelId,clientRequestId:randomUUID()},'create',{key,requestHash:hash,method:'POST',path:'/chat/runs'});
  const gated=await f.app.gate(subject.context,{direction:'outbound',text:content,runId:prepared.run.id},new AbortController().signal);assert.equal(gated.action,'require_approval');assert.ok(gated.approvalId);
  f.database.prepare("UPDATE policy_approval_requests SET status='approved',decision_by_user_id=?,decision_reason_code='approved',decision_note='Reviewed',decided_at_ms=?,release_phase='queued',release_next_attempt_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?").run(subject.userId,f.clock.now,f.clock.now,subject.tenantId,gated.approvalId);
  f.database.prepare("UPDATE gate_decisions SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note='Reviewed' WHERE tenant_id=? AND id=?").run(subject.userId,f.clock.now,subject.tenantId,gated.decisionId);
  return{tenantId:subject.tenantId,approvalId:gated.approvalId,runId:prepared.run.id};
}

async function addApprovedTenantRun(f:Fixture,label:string):Promise<ApprovedTenantRun> {
  const at=f.clock.now,tenantId=randomUUID() as TenantId,userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),floorModelId=randomUUID(),providerConfigId=randomUUID(),policyId=randomUUID(),detectorId=randomUUID(),ruleId=randomUUID(),budgetId=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,`release-${label}-${tenantId.slice(0,8)}`,`Release ${label}`,at,at);
  f.database.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantId,at);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)").run(userId,tenantId,`${label}-${userId.slice(0,8)}@example.test`,`${label} user`,'x',at,at);
  f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(groupId,tenantId,`${label} members`,at,at);
  f.database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,userId,at);
  const premiumVersion=f.database.prepare("SELECT id FROM platform_model_versions WHERE provider_key='openai' AND model_key='gpt-5.6-sol' AND authoritative=1").pluck().get() as string;
  const floorVersion=f.database.prepare("SELECT id FROM platform_model_versions WHERE provider_key='openai' AND model_key='gpt-5.6-luna' AND authoritative=1").pluck().get() as string;
  f.database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id IN (?,?)').run(premiumVersion,floorVersion);
  f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'openai','gpt-5.6-sol','Release model',1,1,4096,128,1000,2000,'[]',?,?,?)").run(modelId,tenantId,premiumVersion,at,at);
  f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'openai','gpt-5.6-luna','Release floor',1,0,4096,128,1000,2000,'[]',?,?,?)").run(floorModelId,tenantId,floorVersion,at,at);
  f.database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'openai',1,'encrypted','fixture',1,?,?)").run(providerConfigId,tenantId,at,at);
  f.database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,modelId);
  f.database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,floorModelId);
  f.database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,providerConfigId);
  f.database.prepare('INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(policyId,tenantId,`${label} policy`,at,at);
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detectorId,tenantId,`release-${label}`,'b'.repeat(64),at,at);
  f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'outbound','require_approval','critical','{}',1,100,?,?)").run(ruleId,tenantId,policyId,detectorId,groupId,at,at);
  f.database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,hard_limit,timezone,created_at,updated_at) VALUES(?,?,'tenant',NULL,'daily','tokens',10000,'UTC',?,?)").run(budgetId,tenantId,at,at);
  const context={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(at)} as TenantContext;
  const content=`${label} employee secret requiring approval`,key=randomUUID(),hash=createHash('sha256').update(content).digest('hex');
  const prepared=await f.app.createRun(context,{content,modelId,clientRequestId:randomUUID()},'create',{key,requestHash:hash,method:'POST',path:'/chat/runs'});
  const gated=await f.app.gate(context,{direction:'outbound',text:content,runId:prepared.run.id},new AbortController().signal);assert.equal(gated.action,'require_approval');assert.ok(gated.approvalId);
  f.database.prepare("UPDATE policy_approval_requests SET status='approved',decision_by_user_id=?,decision_reason_code='approved',decision_note='Reviewed',decided_at_ms=?,release_phase='queued',release_next_attempt_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?").run(userId,at,at,tenantId,gated.approvalId);
  f.database.prepare("UPDATE gate_decisions SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note='Reviewed' WHERE tenant_id=? AND id=?").run(userId,at,tenantId,gated.decisionId);
  return{tenantId,approvalId:gated.approvalId,runId:prepared.run.id,userId,modelId,context};
}

function failAuditOnce(base:AuditService,action:string):AuditService{
  let failed=false;
  return {append:base.append.bind(base),enqueue:base.enqueue.bind(base),transact<T>(work:(tx:AuditTransaction)=>T):T{return base.transact(tx=>work({append(input){if(!failed&&input.action===action){failed=true;throw new Error(`forced ${action} audit failure`);}return tx.append(input);}}));}};
}
async function spinUntil(predicate:()=>boolean):Promise<void>{for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(predicate(),true,'worker did not reach the expected stage');}

test('approval release honors a model-scoped rule in its second resolver',async()=>{
  const f=await fixture({modelScope:true}),worker=f.worker();assert.equal(await worker.drainOnce(),1);assert.equal(f.providerState.calls,1);
  const releaseRechecks=f.gateContexts.filter(context=>typeof context.metadata.approvalReleasePhase==='string');
  assert.ok(releaseRechecks.some(context=>context.modelId===f.modelId&&context.policySnapshot.rules.some(rule=>rule.id===f.ruleId&&rule.scopeType==='model')));
});

test('an approved run releases once after restart and becomes replayable',async()=>{
  const f=await fixture();
  assert.equal(f.database.prepare('SELECT status FROM idempotency_records WHERE tenant_id=? AND run_id=?').pluck().get(f.tenantId,f.runId),'claimed');
  assert.equal((await f.app.getRun(f.context,f.runId))?.status,'awaiting_approval');
  assert.equal((await f.restartApp().getRun(f.context,f.runId))?.status,'awaiting_approval','a restarted process reconstructs a durable waiting run');
  const waiting=[];for await(const event of f.restartApp().replay(f.context,f.runId,0,new AbortController().signal))waiting.push(event.event);
  const waitingStatus=waiting.at(-1);assert.equal(waitingStatus?.event,'run.status');assert.equal(waitingStatus?.event==='run.status'?waitingStatus.data.status:null,'awaiting_approval');
  const worker=f.worker();assert.equal(await worker.drainOnce(),1);
  const approval=f.database.prepare('SELECT status,release_phase,release_reservation_id,release_message_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(f.tenantId,f.approvalId) as {status:string;release_phase:string;release_reservation_id:string|null;release_message_id:string};
  assert.equal(approval.status,'released');assert.equal(approval.release_phase,'completed');assert.equal(f.providerState.calls,1);
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM messages WHERE tenant_id=? AND approval_id=? AND role='assistant' AND status='complete'").pluck().get(f.tenantId,f.approvalId),1);
  assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE tenant_id=? AND id=?').get(f.tenantId,f.sourceAssistantId),{status:'blocked',error_code:'APPROVAL_RELEASED'});
  const idempotency=f.database.prepare('SELECT status,response_json,user_message_id,assistant_message_id FROM idempotency_records WHERE tenant_id=? AND run_id=?').get(f.tenantId,f.runId) as {status:string;response_json:string;user_message_id:string;assistant_message_id:string};
  assert.equal(idempotency.status,'completed');assert.ok(idempotency.response_json);assert.equal(idempotency.assistant_message_id,approval.release_message_id);
  assert.equal((JSON.parse(idempotency.response_json) as {run:{status:string}}).run.status,'completed');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);
  assert.deepEqual(f.database.prepare('SELECT conversation_id,message_id FROM usage_records WHERE tenant_id=?').get(f.tenantId),{conversation_id:f.database.prepare('SELECT conversation_id FROM messages WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,approval.release_message_id),message_id:approval.release_message_id});
  const providerAnalytics=analyticsBreakdown(f.context.db,{dimension:'provider',range:'24h'},prepareAnalyticsStatements(f.database),()=>f.clock.now).items.find(item=>item.id==='openai');assert.equal(providerAnalytics?.violations,1,'approval usage links to its exact original require-approval decision');
  assert.equal((await f.app.getRun(f.context,f.runId))?.status,'completed','durable release must override the same-process in-memory awaiting state');
  const replayed=await f.app.createRun(f.context,{content:f.request.content,modelId:f.modelId,clientRequestId:randomUUID()},'create',{key:f.request.key,requestHash:f.request.hash,method:'POST',path:'/chat/runs'});
  assert.equal(replayed.replay,true);assert.equal(replayed.run.status,'completed');assert.equal(replayed.assistant.id,approval.release_message_id);
  const events=[];for await(const event of f.app.replay(f.context,f.runId,0,new AbortController().signal))events.push(event);
  assert.equal(events.at(-1)?.event.event,'run.completed');
  assert.equal(await f.worker().drainOnce(),0);assert.equal(f.providerState.calls,1);
  f.database.close();
});

test('approval release re-gates and sends the authoritative conversation persona',async()=>{
  const persona='Adopt a warm, approachable tone. Use plain language and a supportive, encouraging style while staying accurate.';
  const f=await fixture({tone:'friendly'});await f.worker().drainOnce();
  const recheck=f.gateContexts.find(context=>context.metadata.approvalReleasePhase==='outbound_recheck');
  assert.deepEqual(recheck?.parts.find(part=>part.source==='system_persona'),{id:'system:persona',source:'system_persona',text:persona,mimeType:'text/plain',fileId:null,provenance:{role:'default',tone:'friendly'}});
  assert.deepEqual(f.providerState.requests[0]?.messages[0],{role:'system',content:[{type:'text',text:persona}]});
  f.database.close();
});

test('approval release preserves the role persona through approve and release',async()=>{
  const persona='Act as a supportive coach and mentor. Ask clarifying questions when useful, encourage the user, and guide them toward their own solutions with constructive, actionable feedback.';
  const f=await fixture({role:'coach'});await f.worker().drainOnce();
  const recheck=f.gateContexts.find(context=>context.metadata.approvalReleasePhase==='outbound_recheck');
  assert.equal(recheck?.parts.find(part=>part.source==='system_persona')?.text,persona);
  assert.deepEqual(f.providerState.requests[0]?.messages[0],{role:'system',content:[{type:'text',text:persona}]});
  f.database.close();
});

test('two workers racing an approval dispatch the provider once',async()=>{
  const f=await fixture(),a=f.worker(),b=f.worker();
  await Promise.all([a.drainOnce(),b.drainOnce()]);
  assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE tenant_id=?').pluck().get(f.tenantId),1);
  f.database.close();
});

test('a blocked provider release does not hold up another tenant',async()=>{
  const f=await fixture(),second=await addApprovedTenantRun(f,'second'),third=await addApprovedTenantRun(f,'third');f.providerState.blockedTenants.add(f.tenantId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-2,f.approvalId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-1,second.approvalId);
  const worker=f.worker({concurrency:2,providerTimeoutMs:120_000}),drain=worker.drainOnce(3);
  await spinUntil(()=>f.providerState.calls===3);
  assert.equal(f.providerState.requests[0]?.context.tenantId,f.tenantId,'the deliberately blocked tenant must enter the provider first');
  await spinUntil(()=>f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(second.tenantId,second.approvalId)==='released');
  await spinUntil(()=>f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(third.tenantId,third.approvalId)==='released');
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId),'releasing');
  assert.equal(f.database.prepare('SELECT status FROM idempotency_records WHERE tenant_id=? AND run_id=?').pluck().get(second.tenantId,second.runId),'completed');
  await worker.stop();assert.equal(await drain,3);assert.equal(f.providerState.calls,3);assert.equal(f.providerState.active,0);
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId),'release_indeterminate');
  f.database.close();
});

test('wake admits a late approval into an empty slot while an earlier provider is blocked',async()=>{
  const f=await fixture();f.providerState.blockedTenants.add(f.tenantId);
  const worker=f.worker({concurrency:2,providerTimeoutMs:120_000}),drain=worker.drainOnce(2);
  await spinUntil(()=>f.providerState.calls===1);
  const late=await addApprovedTenantRun(f,'late-arrival');worker.wake();assert.strictEqual(worker.drainOnce(99),drain);
  await spinUntil(()=>f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(late.tenantId,late.approvalId)==='released');
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId),'releasing');
  assert.equal(f.providerState.calls,2);await worker.stop();assert.equal(await drain,2);assert.equal(f.providerState.active,0);f.database.close();
});

test('an empty slot polls future-due work while another release remains blocked',async()=>{
  const f=await fixture(),due=await addApprovedTenantRun(f,'future-due');f.providerState.blockedTenants.add(f.tenantId);
  f.database.prepare('UPDATE policy_approval_requests SET release_next_attempt_at_ms=? WHERE tenant_id=? AND id=?').run(NOW+1_000,due.tenantId,due.approvalId);
  const worker=f.worker({concurrency:2,pollMs:5,providerTimeoutMs:120_000}),drain=worker.drainOnce(2);await spinUntil(()=>f.providerState.calls===1);
  f.clock.now+=1_001;await new Promise(resolve=>setTimeout(resolve,20));
  await spinUntil(()=>f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(due.tenantId,due.approvalId)==='released');
  assert.equal(f.providerState.calls,2);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId),'releasing');
  await worker.stop();assert.equal(await drain,2);assert.equal(f.providerState.active,0);f.database.close();
});

test('one tenant cannot consume every release slot while another tenant is ready',async()=>{
  const f=await fixture(),secondA=await addApprovedRun(f,'same-tenant-second'),tenantB=await addApprovedTenantRun(f,'fair-tenant');f.providerState.blockedTenants.add(f.tenantId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-3,f.approvalId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-2,secondA.approvalId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-1,tenantB.approvalId);
  const worker=f.worker({concurrency:2,providerTimeoutMs:120_000}),drain=worker.drainOnce(3);
  await spinUntil(()=>f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(tenantB.tenantId,tenantB.approvalId)==='released');
  await spinUntil(()=>f.providerState.calls===3);
  assert.deepEqual(f.providerState.requests.slice(0,2).map(request=>request.context.tenantId),[f.tenantId,tenantB.tenantId],'the first scheduling wave must admit distinct tenants');
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId),'releasing');
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(secondA.tenantId,secondA.approvalId),'releasing');
  await worker.stop();assert.equal(await drain,3);assert.equal(f.providerState.calls,3);assert.equal(f.providerState.active,0);
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_approval_requests WHERE tenant_id=? AND status='release_indeterminate'").pluck().get(f.tenantId),2);
  f.database.close();
});

test('tenant fairness includes active leases held by another worker',async()=>{
  const f=await fixture(),secondA=await addApprovedRun(f,'leased-by-peer'),tenantB=await addApprovedTenantRun(f,'peer-fair-tenant');f.providerState.blockedTenants.add(f.tenantId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-3,f.approvalId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-2,secondA.approvalId);
  f.database.prepare('UPDATE policy_approval_requests SET created_at_ms=? WHERE id=?').run(NOW-1,tenantB.approvalId);
  const first=f.worker({concurrency:1,providerTimeoutMs:120_000}),peer=f.worker({concurrency:1,providerTimeoutMs:120_000}),firstDrain=first.drainOnce(1);
  await spinUntil(()=>f.providerState.calls===1);
  assert.equal(f.providerState.requests[0]?.context.tenantId,f.tenantId);
  assert.equal(await peer.drainOnce(1),1);assert.equal(f.providerState.requests[1]?.context.tenantId,tenantB.tenantId);
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(tenantB.tenantId,tenantB.approvalId),'released');
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(secondA.tenantId,secondA.approvalId),'approved','the peer must not preclaim the noisy tenant backlog');
  await first.stop();await peer.stop();assert.equal(await firstDrain,1);assert.equal(f.providerState.active,0);f.database.close();
});

test('local tenant waves never override a lower global active-lease count',async()=>{
  const f=await fixture();await addApprovedRun(f,'global-fair-a');const tenantB=await addApprovedTenantRun(f,'global-fair-b-peer-one'),peerB=await addApprovedSubjectRun(f,tenantB,'global-fair-b-peer-two'),readyB=await addApprovedSubjectRun(f,tenantB,'global-fair-b-ready');
  for(const approvalId of [tenantB.approvalId,peerB.approvalId])f.database.prepare("UPDATE policy_approval_requests SET status='releasing',release_lease_owner='peer-worker',release_lease_expires_at_ms=?,release_phase='claimed',release_next_attempt_at_ms=NULL,version=version+1 WHERE tenant_id=? AND id=?").run(NOW+60_000,tenantB.tenantId,approvalId);
  f.providerState.blockedTenants.add(f.tenantId);const worker=f.worker({concurrency:2,providerTimeoutMs:120_000}),drain=worker.drainOnce(2);
  await spinUntil(()=>f.providerState.calls===2);
  assert.deepEqual(f.providerState.requests.map(request=>request.context.tenantId),[f.tenantId,f.tenantId]);
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(readyB.tenantId,readyB.approvalId),'approved');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_approval_requests WHERE tenant_id=? AND status='releasing'").pluck().get(f.tenantId),2);
  await worker.stop();assert.equal(await drain,2);assert.equal(f.providerState.active,0);f.database.close();
});

test('release concurrency is bounded at the default and configured limits without preclaiming',async()=>{
  for(const [configured,capacity] of [[undefined,4],[2,2]] as const){
    const f=await fixture(),runs=[{tenantId:f.tenantId,approvalId:f.approvalId}];
    for(let index=1;index<=capacity;index++)runs.push(await addApprovedTenantRun(f,`capacity-${capacity}-${index}`));
    for(const run of runs)f.providerState.blockedTenants.add(run.tenantId);
    assert.throws(()=>f.worker({concurrency:configured===undefined?0:17}),/integer from 1 to 16/);
    const worker=f.worker(configured===undefined?{}:{concurrency:configured}),drain=worker.drainOnce(runs.length);
    await spinUntil(()=>f.providerState.calls===capacity);
    for(let turn=0;turn<10;turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.providerState.calls,capacity);assert.equal(f.providerState.active,capacity);assert.equal(f.providerState.maxActive,capacity);
    assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_approval_requests WHERE status='releasing'").pluck().get(),capacity);
    assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_approval_requests WHERE status='approved'").pluck().get(),1,'work beyond capacity must remain unclaimed');
    await worker.stop();assert.equal(await drain,capacity);assert.equal(f.providerState.active,0);f.database.close();
  }
});

test('concurrent drainOnce calls share the one in-flight promise',async()=>{
  const f=await fixture();f.providerState.blockedTenants.add(f.tenantId);const worker=f.worker({concurrency:1,providerTimeoutMs:120_000});
  const first=worker.drainOnce(1),second=worker.drainOnce(10);assert.strictEqual(second,first);
  await spinUntil(()=>f.providerState.calls===1);await worker.stop();assert.equal(await first,1);assert.equal(f.providerState.calls,1);f.database.close();
});

test('stop aborts and waits for every active release process',async()=>{
  const f=await fixture(),second=await addApprovedTenantRun(f,'stop-second');f.providerState.blockedTenants.add(f.tenantId);f.providerState.blockedTenants.add(second.tenantId);
  const worker=f.worker({concurrency:2,providerTimeoutMs:120_000}),drain=worker.drainOnce(2);let drainSettled=false;void drain.finally(()=>{drainSettled=true;});
  await spinUntil(()=>f.providerState.calls===2);await worker.stop();
  assert.equal(drainSettled,true);assert.equal(await drain,2);assert.equal(f.providerState.active,0);assert.equal(f.providerState.returns,2);
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_approval_requests WHERE status='release_indeterminate'").pluck().get(),2);
  f.database.close();
});

test('an approved request expiring before dispatch closes every linked governance state',async()=>{
  const f=await fixture(),decisionId=f.database.prepare('SELECT gate_decision_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;
  f.clock.now=(f.database.prepare('SELECT expires_at_ms FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as number)+1;
  assert.equal(await f.worker().drainOnce(),0);
  assert.equal(f.providerState.calls,0);
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'expired');
  assert.equal(f.database.prepare('SELECT status FROM policy_violations WHERE approval_id=?').pluck().get(f.approvalId),'expired');
  assert.equal(f.database.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(decisionId),'denied');
  assert.equal((JSON.parse(f.database.prepare('SELECT response_json FROM idempotency_records WHERE run_id=?').pluck().get(f.runId) as string) as {run:{status:string}}).run.status,'cancelled');
  const events=[];for await(const event of f.app.replay(f.context,f.runId,0,new AbortController().signal))events.push(event.event.event);
  assert.equal(events.at(-1),'run.cancelled');assert.equal(events.includes('run.completed'),false);
  f.database.close();
});

test('the worker expires an unread pending approval exactly once',async()=>{
  const f=await fixture(),decisionId=f.database.prepare('SELECT gate_decision_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;
  f.database.prepare("UPDATE policy_approval_requests SET status='pending',release_phase=NULL,release_next_attempt_at_ms=NULL,version=version+1 WHERE id=?").run(f.approvalId);
  f.database.prepare("UPDATE gate_decisions SET status='pending_approval',reviewed_by_user_id=NULL,reviewed_at=NULL,review_note=NULL WHERE id=?").run(decisionId);
  f.clock.now=(f.database.prepare('SELECT expires_at_ms FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as number)+1;
  await f.worker().drainOnce();await f.worker().drainOnce();
  assert.deepEqual(f.database.prepare('SELECT status,release_phase FROM policy_approval_requests WHERE id=?').get(f.approvalId),{status:'expired',release_phase:'terminal'});
  assert.equal(f.database.prepare('SELECT status FROM policy_violations WHERE approval_id=?').pluck().get(f.approvalId),'expired');
  assert.equal(f.database.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(decisionId),'denied');
  assert.equal((JSON.parse(f.database.prepare('SELECT response_json FROM idempotency_records WHERE run_id=?').pluck().get(f.runId) as string) as {run:{status:string}}).run.status,'cancelled');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.approval_expired'").pluck().get(f.tenantId),1);
  assert.equal(f.providerState.calls,0);f.database.close();
});

test('an attachment release uses only file rules for file text and checkpoints governed provenance',async()=>{
  const f=await fixture({attachment:true});assert.ok(f.attachment);
  f.database.exec("CREATE TRIGGER hold_attachment_result BEFORE INSERT ON audit_events WHEN NEW.action='gate.approval_released' BEGIN SELECT RAISE(ABORT,'inspect attachment result'); END");
  await f.worker().drainOnce();assert.equal(f.providerState.calls,1);
  const requestText=f.providerState.requests[0]!.messages.flatMap(message=>message.content).filter(part=>part.type==='text').map(part=>part.text).join('\n');
  assert.match(requestText,/untrusted reference data/);assert.match(requestText,new RegExp(f.attachment.text));
  const fileContext=f.gateContexts.find(context=>context.metadata.approvalReleasePhase==='file_recheck');assert.ok(fileContext);
  assert.deepEqual(fileContext.policySnapshot.rules.map(rule=>rule.id),[],'an outbound-only rule must not evaluate attachment text as a file rule');
  const outboundContext=f.gateContexts.find(context=>context.metadata.approvalReleasePhase==='outbound_recheck');assert.ok(outboundContext?.policySnapshot.rules.some(rule=>rule.id===f.ruleId));
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM message_parts WHERE message_id=(SELECT release_user_message_id FROM policy_approval_requests WHERE id=?) AND kind='file_ref' AND file_id=?").pluck().get(f.approvalId,f.attachment.fileId),1);
  const row=f.database.prepare('SELECT result_ciphertext,result_nonce,key_version,payload_crypto_scheme,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {result_ciphertext:Buffer;result_nonce:Buffer;key_version:number;payload_crypto_scheme:'dek_v2';payload_wrapped_dek:Buffer;payload_wrap_nonce:Buffer;payload_kek_version:number};
  const result=openApprovalResult(KEY,{tenantId:f.tenantId,approvalId:f.approvalId,ciphertext:row.result_ciphertext,nonce:row.result_nonce,keyVersion:row.key_version,cryptoScheme:row.payload_crypto_scheme,wrappedDek:row.payload_wrapped_dek,wrapNonce:row.payload_wrap_nonce,kekVersion:row.payload_kek_version});
  assert.deepEqual(result.files.map(file=>({fileId:file.fileId,projectId:file.projectId})),[{fileId:f.attachment.fileId,projectId:f.attachment.projectId}]);
  f.database.exec('DROP TRIGGER hold_attachment_result');f.clock.now+=1_001;await f.worker().drainOnce();assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released');
  f.database.close();
});

test('a confirmed file warning survives outbound approval only while its exact rule set is unchanged',async()=>{
  const released=await fixture({fileWarnThenApproval:true});assert.ok(released.fileWarnRuleId);
  const envelopeRow=released.database.prepare('SELECT violation_id,payload_ciphertext,payload_nonce,key_version,payload_crypto_scheme,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version FROM policy_approval_requests WHERE id=?').get(released.approvalId) as {violation_id:string;payload_ciphertext:Buffer;payload_nonce:Buffer;key_version:number;payload_crypto_scheme:'dek_v2';payload_wrapped_dek:Buffer;payload_wrap_nonce:Buffer;payload_kek_version:number};
  const envelope=openApprovalEnvelope(KEY,{tenantId:released.tenantId,approvalId:released.approvalId,violationId:envelopeRow.violation_id,ciphertext:envelopeRow.payload_ciphertext,nonce:envelopeRow.payload_nonce,keyVersion:envelopeRow.key_version,cryptoScheme:envelopeRow.payload_crypto_scheme,wrappedDek:envelopeRow.payload_wrapped_dek,wrapNonce:envelopeRow.payload_wrap_nonce,kekVersion:envelopeRow.payload_kek_version});
  assert.deepEqual(envelope.confirmedWarnings?.map(item=>({direction:item.direction,ruleIds:item.ruleIds})),[{direction:'file',ruleIds:[released.fileWarnRuleId]}]);
  assert.deepEqual(JSON.parse(released.database.prepare('SELECT rule_ids_json FROM policy_violations WHERE approval_id=?').pluck().get(released.approvalId) as string),[released.ruleId],'the outbound incident must not absorb file-warning rule ids');
  await released.worker().drainOnce();assert.equal(released.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(released.approvalId),'released');assert.equal(released.providerState.calls,1);released.database.close();

  for(const change of ['new','edited'] as const){
    const f=await fixture({fileWarnThenApproval:true}),scope=f.database.prepare('SELECT policy_id,detector_id,scope_id FROM policy_rules WHERE id=?').get(f.fileWarnRuleId!) as {policy_id:string;detector_id:string;scope_id:string};
    if(change==='new')f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'file','warn','high','{}',1,95,?,?)").run(randomUUID(),f.tenantId,scope.policy_id,scope.detector_id,scope.scope_id,NOW,NOW+1);
    else f.database.prepare('UPDATE policy_rules SET updated_at=? WHERE tenant_id=? AND id=?').run(NOW+1,f.tenantId,f.fileWarnRuleId);
    await f.worker().drainOnce();assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'rejected',change);assert.equal(f.providerState.calls,0,change);f.database.close();
  }
});

test('attachment state and project binding are fenced again after release rechecks',async()=>{
  for(const mutation of ['purge','detach'] as const){
    const f=await fixture({attachment:true});assert.ok(f.attachment);let changed=false;
    f.gateState.afterPhase=phase=>{if(changed||phase!=='outbound_recheck')return;changed=true;if(mutation==='purge')f.database.prepare('UPDATE project_files SET content_purged_at=? WHERE id=?').run(NOW,f.attachment!.fileId);else f.database.prepare('DELETE FROM project_conversations WHERE conversation_id=(SELECT conversation_id FROM policy_violations WHERE approval_id=?)').run(f.approvalId);};
    await f.worker().drainOnce();assert.equal(f.providerState.calls,0,mutation);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'cancelled',mutation);assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE id IN (SELECT release_user_message_id FROM policy_approval_requests WHERE id=?) OR approval_id=?').pluck().get(f.approvalId,f.approvalId),0,mutation);assert.notEqual(f.database.prepare('SELECT error_code FROM messages WHERE id=?').pluck().get(f.sourceAssistantId),'APPROVAL_RELEASED',mutation);assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0,mutation);f.database.close();
  }
});

test('the dispatch transaction catches an attachment change after preparation commits',async()=>{
  const f=await fixture({attachment:true});assert.ok(f.attachment);let mutated=false;
  const dispatchRaceAudit:AuditService={append:f.audit.append.bind(f.audit),enqueue:f.audit.enqueue.bind(f.audit),transact<T>(work:(tx:AuditTransaction)=>T):T{
    const phase=f.database.prepare('SELECT release_phase FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId);
    if(!mutated&&phase==='prepared'){mutated=true;f.database.prepare('UPDATE project_files SET content_purged_at=? WHERE id=?').run(NOW,f.attachment!.fileId);}
    return f.audit.transact(work);
  }};
  await f.worker({audit:dispatchRaceAudit}).drainOnce();assert.equal(mutated,true);assert.equal(f.providerState.calls,0);
  assert.deepEqual(f.database.prepare('SELECT status,provider_started_at_ms FROM policy_approval_requests WHERE id=?').get(f.approvalId),{status:'cancelled',provider_started_at_ms:null});
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE id=(SELECT release_user_message_id FROM policy_approval_requests WHERE id=?) OR approval_id=?').pluck().get(f.approvalId,f.approvalId),0);
  assert.notEqual(f.database.prepare('SELECT error_code FROM messages WHERE id=?').pluck().get(f.sourceAssistantId),'APPROVAL_RELEASED');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);f.database.close();
});

test('expiry crossing during an asynchronous release gate leaves no prompt or provider call',async()=>{
  const f=await fixture(),expires=f.database.prepare('SELECT expires_at_ms FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as number;let crossed=false;
  f.gateState.afterPhase=phase=>{if(!crossed&&phase==='outbound_recheck'){crossed=true;f.clock.now=expires+1;}};
  await f.worker().drainOnce();assert.equal(crossed,true);assert.equal(f.providerState.calls,0);
  const row=f.database.prepare('SELECT status,release_user_message_id,release_message_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_user_message_id:string;release_message_id:string};
  assert.equal(row.status,'expired');assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE id IN (?,?)').pluck().get(row.release_user_message_id,row.release_message_id),0);
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM message_parts WHERE text_content=?').pluck().get(f.request.content),0);assert.notEqual(f.database.prepare('SELECT error_code FROM messages WHERE id=?').pluck().get(f.sourceAssistantId),'APPROVAL_RELEASED');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);f.database.close();
});

test('dispatch revalidates every mutable authorization input in its message transaction',async()=>{
  for(const mutation of ['conversation','group','role','model','provider','policy','violation'] as const){
    const f=await fixture();
    let changed=false;const dispatchRaceAudit:AuditService={append:f.audit.append.bind(f.audit),enqueue:f.audit.enqueue.bind(f.audit),transact<T>(work:(tx:AuditTransaction)=>T):T{
      const phase=f.database.prepare('SELECT release_phase FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId);
      if(!changed&&phase==='prepared'){
        changed=true;
        if(mutation==='conversation')f.database.prepare("UPDATE conversations SET status='deleted',deleted_at=? WHERE id=(SELECT conversation_id FROM policy_violations WHERE approval_id=?)").run(NOW,f.approvalId);
        else if(mutation==='group')f.database.prepare('DELETE FROM group_members WHERE tenant_id=? AND user_id=?').run(f.tenantId,f.userId);
        else if(mutation==='role'){const role=randomUUID();f.database.prepare("INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'admin','Admin',0,?)").run(role,f.tenantId,NOW);f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,f.userId,role,NOW);}
        else if(mutation==='model')f.database.prepare('UPDATE model_catalog SET enabled=0 WHERE tenant_id=? AND id=?').run(f.tenantId,f.modelId);
        else if(mutation==='provider')f.database.prepare("UPDATE provider_config SET enabled=0 WHERE tenant_id=? AND provider_key='openai'").run(f.tenantId);
        else if(mutation==='policy')f.database.prepare('UPDATE policy_rules SET updated_at=updated_at+1 WHERE tenant_id=? AND id=?').run(f.tenantId,f.ruleId);
        else f.database.prepare("UPDATE policy_violations SET status='dismissed',version=version+1,updated_at_ms=? WHERE approval_id=?").run(NOW+1,f.approvalId);
      }
      return f.audit.transact(work);
    }};
    await f.worker({audit:dispatchRaceAudit}).drainOnce();assert.equal(changed,true,mutation);assert.equal(f.providerState.calls,0,mutation);
    const row=f.database.prepare('SELECT status,release_user_message_id,release_message_id,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_user_message_id:string;release_message_id:string;release_reservation_id:string};
    assert.equal(row.status,'cancelled',mutation);assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE id IN (?,?)').pluck().get(row.release_user_message_id,row.release_message_id),0,mutation);assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(row.release_reservation_id),'released',mutation);assert.notEqual(f.database.prepare('SELECT error_code FROM messages WHERE id=?').pluck().get(f.sourceAssistantId),'APPROVAL_RELEASED',mutation);f.database.close();
  }
});

test('a provider-start CAS miss rolls back both release messages and the authorized prompt',async()=>{
  const f=await fixture();f.database.exec("CREATE TRIGGER ignore_approval_provider_start BEFORE UPDATE OF provider_started_at_ms ON policy_approval_requests WHEN NEW.provider_started_at_ms IS NOT NULL BEGIN SELECT RAISE(IGNORE); END");
  await f.worker().drainOnce();assert.equal(f.providerState.calls,0);
  const row=f.database.prepare('SELECT status,release_user_message_id,release_message_id,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_user_message_id:string;release_message_id:string;release_reservation_id:string};
  assert.equal(row.status,'release_failed');assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE id IN (?,?)').pluck().get(row.release_user_message_id,row.release_message_id),0);assert.equal(f.database.prepare('SELECT COUNT(*) FROM message_parts WHERE text_content=?').pluck().get(f.request.content),0);
  assert.notEqual(f.database.prepare('SELECT error_code FROM messages WHERE id=?').pluck().get(f.sourceAssistantId),'APPROVAL_RELEASED');assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(row.release_reservation_id),'released');f.database.close();
});

test('nonterminal violation triage metadata does not revoke approved release consent',async()=>{
  for(const mutation of ['note','assign','due'] as const){
    const f=await fixture(),violationId=f.database.prepare('SELECT violation_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;
    if(mutation==='note'){f.database.prepare('INSERT INTO policy_violation_comments(id,tenant_id,violation_id,author_user_id,body,created_at_ms) VALUES(?,?,?,?,?,?)').run(randomUUID(),f.tenantId,violationId,f.userId,'Reviewer context only',NOW+1);f.database.prepare('UPDATE policy_violations SET version=version+1,updated_at_ms=? WHERE id=?').run(NOW+1,violationId);}
    else if(mutation==='assign')f.database.prepare("UPDATE policy_violations SET assignee_user_id=?,status='triaged',version=version+1,updated_at_ms=? WHERE id=?").run(f.userId,NOW+1,violationId);
    else f.database.prepare('UPDATE policy_violations SET due_at_ms=?,version=version+1,updated_at_ms=? WHERE id=?').run(NOW+60_000,NOW+1,violationId);
    await f.worker().drainOnce();assert.equal(f.providerState.calls,1,mutation);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released',mutation);assert.equal(f.database.prepare('SELECT status FROM policy_violations WHERE id=?').pluck().get(violationId),'approved',mutation);f.database.close();
  }
});

test('release gate marks only the final user turn as user_prompt',async()=>{
  const f=await fixture(),row=f.database.prepare('SELECT violation_id,payload_ciphertext,payload_nonce,key_version,payload_crypto_scheme,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {violation_id:string;payload_ciphertext:Buffer;payload_nonce:Buffer;key_version:number;payload_crypto_scheme:'dek_v2';payload_wrapped_dek:Buffer;payload_wrap_nonce:Buffer;payload_kek_version:number};
  const opened=openApprovalEnvelope(KEY,{tenantId:f.tenantId,approvalId:f.approvalId,violationId:row.violation_id,ciphertext:row.payload_ciphertext,nonce:row.payload_nonce,keyVersion:row.key_version,cryptoScheme:row.payload_crypto_scheme,wrappedDek:row.payload_wrapped_dek,wrapNonce:row.payload_wrap_nonce,kekVersion:row.payload_kek_version});
  const sealed=sealApprovalEnvelope(KEY,{...opened,messages:[{role:'assistant',content:[{type:'text',text:'prior history'}]},...opened.messages]});
  f.database.prepare('UPDATE policy_approval_requests SET payload_ciphertext=?,payload_nonce=?,key_version=?,payload_digest=?,payload_wrapped_dek=?,payload_wrap_nonce=?,payload_kek_version=? WHERE id=?').run(sealed.ciphertext,sealed.nonce,sealed.keyVersion,sealed.digest,sealed.wrappedDek,sealed.wrapNonce,sealed.kekVersion,f.approvalId);
  await f.worker().drainOnce();
  const context=f.gateContexts.find(item=>item.metadata.approvalReleasePhase==='outbound_recheck');assert.ok(context);
  assert.deepEqual(context.parts.map(part=>part.source),['conversation_history','user_prompt']);f.database.close();
});

test('postflight reloads live groups before applying inbound policy',async()=>{
  const f=await fixture();f.providerState.afterOutput=()=>{
    const group=randomUUID(),policy=randomUUID(),detector=randomUUID();
    f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Strict response',?,?)").run(group,f.tenantId,NOW+1,NOW+1);
    f.database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(f.tenantId,group,f.userId,NOW+1);
    f.database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Inbound response policy',?,?)").run(policy,f.tenantId,NOW+1,NOW+1);
    f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detector,f.tenantId,`inbound-${detector}`,'f'.repeat(64),NOW+1,NOW+1);
    f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'group',?,'inbound','block','high','{}',1,1000,?,?)").run(randomUUID(),f.tenantId,policy,detector,group,NOW+1,NOW+1);
  };
  await f.worker().drainOnce();assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released',`${f.providerState.errors.join('\n')} ${JSON.stringify(f.database.prepare('SELECT status,release_phase,release_error_code,release_finalize_attempts FROM policy_approval_requests WHERE id=?').get(f.approvalId))}`);
  const released=f.database.prepare("SELECT m.status,p.text_content FROM messages m JOIN message_parts p ON p.message_id=m.id AND p.ordinal=0 WHERE m.id=(SELECT release_message_id FROM policy_approval_requests WHERE id=?)").get(f.approvalId);
  assert.deepEqual(released,{status:'blocked',text_content:'Response withheld by policy'});assert.equal(f.database.prepare("SELECT COUNT(*) FROM policy_violations WHERE tenant_id=? AND direction='inbound' AND status='open'").pluck().get(f.tenantId),1);f.database.close();
});

test('a stale reaper during provider output is reconciled to one actual usage charge',async()=>{
  const f=await fixture();f.providerState.afterOutput=()=>{const reservation=f.database.prepare('SELECT release_reservation_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;f.database.prepare('UPDATE budget_reservations SET expires_at=? WHERE id=?').run(f.clock.now-1,reservation);assert.equal(new GovernanceLedger(f.database).expireStale(f.clock.now,10),1);};
  await f.worker().drainOnce();assert.equal(f.providerState.calls,1);
  const reservation=f.database.prepare('SELECT release_reservation_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(reservation),'settled');assert.deepEqual(f.database.prepare('SELECT input_tokens,output_tokens FROM usage_records WHERE tenant_id=?').get(f.tenantId),{input_tokens:12,output_tokens:3});
  assert.deepEqual(f.database.prepare("SELECT kind,COUNT(*) count FROM budget_ledger WHERE json_extract(metadata_json,'$.reservationId')=? AND kind IN ('release','settle') GROUP BY kind ORDER BY kind").all(reservation),[{kind:'release',count:1},{kind:'settle',count:1}]);f.database.close();
});

test('unchanged lower warning is covered by approval but a newly added warning is not',async()=>{
  const unchanged=await fixture({warnOverlap:true});
  assert.equal((JSON.parse(unchanged.database.prepare('SELECT rule_ids_json FROM policy_violations WHERE approval_id=?').pluck().get(unchanged.approvalId) as string) as string[]).length,2);
  await unchanged.worker().drainOnce();assert.equal(unchanged.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(unchanged.approvalId),'released');assert.equal(unchanged.providerState.calls,1);unchanged.database.close();
  const changed=await fixture(),scope=changed.database.prepare('SELECT policy_id,detector_id,scope_id FROM policy_rules WHERE id=?').get(changed.ruleId) as {policy_id:string;detector_id:string;scope_id:string};
  changed.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'outbound','warn','medium','{}',1,90,?,?)").run(randomUUID(),changed.tenantId,scope.policy_id,scope.detector_id,scope.scope_id,NOW,NOW+1);
  await changed.worker().drainOnce();assert.equal(changed.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(changed.approvalId),'rejected');assert.equal(changed.providerState.calls,0);changed.database.close();
});

test('an audit failure during message preparation leaves no orphan or reservation and retries safely',async()=>{
  const f=await fixture(),failing=failAuditOnce(f.audit,'gate.released_content_rechecked');
  await f.worker({audit:failing}).drainOnce();
  assert.equal(f.providerState.calls,0);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'release_failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE tenant_id=? AND approval_id=?').pluck().get(f.tenantId,f.approvalId),0);
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);
  f.clock.now+=1_001;await f.worker().drainOnce();
  assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE tenant_id=? AND approval_id=?').pluck().get(f.tenantId,f.approvalId),1);
  f.database.close();
});

test('unknown failures never persist or log raw error messages',async()=>{
  const secret='sk-live-SYNTHETIC-EMPLOYEE-SECRET';
  const persisted=await fixture();persisted.gateState.afterPhase=()=>{throw new Error(secret);};await persisted.worker().drainOnce();
  assert.equal(persisted.database.prepare('SELECT release_error_code FROM policy_approval_requests WHERE id=?').pluck().get(persisted.approvalId),'approval_release_failed');
  const failureMetadata=persisted.database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='gate.approval_released' AND outcome='failure' ORDER BY sequence DESC LIMIT 1").pluck().get(persisted.tenantId) as string;
  assert.equal((JSON.parse(failureMetadata) as {failureCode:string}).failureCode,'approval_release_failed');assert.doesNotMatch(failureMetadata,new RegExp(secret));persisted.database.close();

  const logged=await fixture();logged.database.exec(`CREATE TRIGGER leak_shaped_finalize_error BEFORE INSERT ON audit_events WHEN NEW.action='gate.approval_released' BEGIN SELECT RAISE(ABORT,'${secret}'); END`);
  await logged.worker().drainOnce();const journal=logged.providerState.errors.join('\n');assert.match(journal,/approval_release_failed/);assert.doesNotMatch(journal,new RegExp(secret));logged.database.close();
});

test('a checkpoint survives final audit failure and finalizes without another provider call',async()=>{
  const f=await fixture({credentialSource:'byok'});
  f.database.exec("CREATE TRIGGER fail_release_audit BEFORE INSERT ON audit_events WHEN NEW.action='gate.approval_released' BEGIN SELECT RAISE(ABORT,'forced finalize audit failure'); END");
  await f.worker().drainOnce();
  const checkpoint=f.database.prepare('SELECT status,release_phase,result_ciphertext FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_phase:string;result_ciphertext:Buffer|null};
  assert.equal(checkpoint.status,'releasing');assert.equal(checkpoint.release_phase,'finalize_retry');assert.ok(checkpoint.result_ciphertext);assert.equal(f.providerState.calls,1);
  const settled=f.database.prepare('SELECT u.id,u.conversation_id,u.message_id FROM usage_records u WHERE u.tenant_id=?').get(f.tenantId) as {id:string;conversation_id:string;message_id:string};assert.ok(settled.conversation_id);assert.ok(settled.message_id);
  assert.deepEqual(f.database.prepare('SELECT credential_source,customer_charge_microusd FROM usage_records WHERE tenant_id=?').get(f.tenantId),{credential_source:'byok',customer_charge_microusd:0});
  f.database.prepare('UPDATE usage_records SET conversation_id=NULL,message_id=NULL WHERE id=?').run(settled.id);
  f.database.exec('DROP TRIGGER fail_release_audit');f.clock.now+=1_001;assert.equal(f.database.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='fail_release_audit'").pluck().get(),0);const resumed=await f.worker().drainOnce();assert.equal(resumed,1,JSON.stringify(f.database.prepare('SELECT status,release_lease_expires_at_ms,result_ciphertext IS NOT NULL checkpointed FROM policy_approval_requests WHERE id=?').get(f.approvalId)));
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released',f.providerState.errors.join('\n'));assert.equal(f.providerState.calls,1);
  assert.deepEqual(f.database.prepare('SELECT id,conversation_id,message_id FROM usage_records WHERE tenant_id=?').get(f.tenantId),settled);
  assert.deepEqual(f.database.prepare('SELECT credential_source,customer_charge_microusd FROM usage_records WHERE tenant_id=?').get(f.tenantId),{credential_source:'byok',customer_charge_microusd:0},'finalize retry recovers billing source from the durable provider-start event');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.approval_released' AND outcome='success'").pluck().get(f.tenantId),1);
  f.database.close();
});

test('a violation terminal race after provider dispatch becomes one bounded indeterminate result',async()=>{
  const f=await fixture();let changed=false;f.gateState.afterPhase=phase=>{if(!changed&&phase==='postflight'){changed=true;f.database.prepare("UPDATE policy_violations SET status='dismissed',version=version+1,updated_at_ms=? WHERE approval_id=?").run(NOW+1,f.approvalId);}};
  await f.worker().drainOnce();assert.equal(changed,true);assert.equal(f.providerState.calls,1);assert.deepEqual(f.database.prepare('SELECT status,release_phase,result_ciphertext FROM policy_approval_requests WHERE id=?').get(f.approvalId),{status:'release_indeterminate',release_phase:'finalize_state_changed',result_ciphertext:null});assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE tenant_id=?').pluck().get(f.tenantId),1);assert.equal(await f.worker().drainOnce(),0);assert.equal(f.providerState.calls,1);f.database.close();
});

test('finalize withholds output when the postflight subject or inbound policy changes after evaluation',async()=>{
  for(const mutation of ['group-and-rule','group-only','rule-only'] as const){
    const f=await fixture(),scope=f.database.prepare('SELECT policy_id,detector_id,scope_id FROM policy_rules WHERE id=?').get(f.ruleId) as {policy_id:string;detector_id:string;scope_id:string};let changed=false;
    f.gateState.afterPhase=phase=>{
      if(changed||phase!=='postflight')return;changed=true;let scopeId=scope.scope_id;
      if(mutation!=='rule-only'){
        scopeId=randomUUID();f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(scopeId,f.tenantId,`Late group ${mutation}`,NOW,NOW);
        f.database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(f.tenantId,scopeId,f.userId,NOW);
      }
      if(mutation!=='group-only')f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'inbound','block','critical','{}',1,200,?,?)").run(randomUUID(),f.tenantId,scope.policy_id,scope.detector_id,scopeId,NOW,NOW+1);
    };
    await f.worker().drainOnce();assert.equal(changed,true,mutation);assert.equal(f.providerState.calls,1,mutation);
    const approval=f.database.prepare('SELECT status,release_phase,release_error_code,result_ciphertext,release_reservation_id,release_message_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_phase:string;release_error_code:string;result_ciphertext:Buffer|null;release_reservation_id:string;release_message_id:string};
    assert.deepEqual({status:approval.status,phase:approval.release_phase,error:approval.release_error_code,checkpoint:approval.result_ciphertext},{status:'release_indeterminate',phase:'postflight_policy_changed',error:'postflight_policy_changed',checkpoint:null},mutation);
    assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(approval.release_reservation_id),'settled',mutation);
    assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0,mutation);
    assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE tenant_id=?').pluck().get(f.tenantId),1,mutation);
    for(const messageId of [approval.release_message_id,f.sourceAssistantId])assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(messageId),{status:'failed',error_code:'APPROVAL_RELEASE_INDETERMINATE'},mutation);
    const secret='Released response',parts=f.database.prepare('SELECT text_content FROM message_parts WHERE tenant_id=?').pluck().all(f.tenantId).map(String),response=f.database.prepare('SELECT response_json FROM idempotency_records WHERE tenant_id=? AND run_id=?').pluck().get(f.tenantId,f.runId) as string;
    assert.equal(parts.some(text=>text.includes(secret)),false,mutation);assert.doesNotMatch(response,new RegExp(secret),mutation);
    assert.equal(await f.worker().drainOnce(),0,mutation);assert.equal(f.providerState.calls,1,mutation);f.database.close();
  }
});

test('permanent finalization failure stops after three attempts without redispatch',async()=>{
  const f=await fixture();f.database.exec("CREATE TRIGGER fail_release_success_forever BEFORE INSERT ON audit_events WHEN NEW.action='gate.approval_released' BEGIN SELECT RAISE(ABORT,'forced permanent finalize failure'); END");
  await f.worker().drainOnce();let row=f.database.prepare('SELECT status,release_phase,release_finalize_attempts,result_ciphertext IS NOT NULL checkpointed FROM policy_approval_requests WHERE id=?').get(f.approvalId);assert.deepEqual(row,{status:'releasing',release_phase:'finalize_retry',release_finalize_attempts:1,checkpointed:1});
  f.clock.now+=1_001;await f.worker().drainOnce();row=f.database.prepare('SELECT status,release_phase,release_finalize_attempts,result_ciphertext IS NOT NULL checkpointed FROM policy_approval_requests WHERE id=?').get(f.approvalId);assert.deepEqual(row,{status:'releasing',release_phase:'finalize_retry',release_finalize_attempts:2,checkpointed:1});
  f.clock.now+=5_001;await f.worker().drainOnce();row=f.database.prepare('SELECT status,release_phase,release_finalize_attempts,result_ciphertext IS NOT NULL checkpointed FROM policy_approval_requests WHERE id=?').get(f.approvalId);assert.deepEqual(row,{status:'release_indeterminate',release_phase:'finalize_failed',release_finalize_attempts:3,checkpointed:0});assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE tenant_id=?').pluck().get(f.tenantId),1);f.clock.now+=60_000;assert.equal(await f.worker().drainOnce(),0);f.database.close();
});

test('an unavailable audit chain leaves checkpointed domain state untouched until recovery',async()=>{
  const f=await fixture();let providerMarked=false;const unavailable:AuditService={append:f.audit.append.bind(f.audit),enqueue:f.audit.enqueue.bind(f.audit),transact<T>(work:(tx:AuditTransaction)=>T):T{return f.audit.transact(tx=>work({append(input){if(providerMarked)throw new Error('audit unavailable');const receipt=tx.append(input);if(input.action==='chat.provider_called')providerMarked=true;return receipt;}}));}};
  await f.worker({audit:unavailable}).drainOnce();const held=f.database.prepare('SELECT status,release_phase,release_finalize_attempts,result_ciphertext IS NOT NULL checkpointed FROM policy_approval_requests WHERE id=?').get(f.approvalId);assert.deepEqual(held,{status:'releasing',release_phase:'result_checkpointed',release_finalize_attempts:1,checkpointed:1});assert.equal(f.database.prepare('SELECT status FROM idempotency_records WHERE run_id=?').pluck().get(f.runId),'claimed');assert.equal(f.providerState.calls,1);
  f.clock.now+=31_000;await f.worker().drainOnce();assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'released');assert.equal(f.providerState.calls,1);f.database.close();
});

test('indeterminate approval failures charge only observed provider usage',async()=>{
  for(const mode of ['hang','oversize'] as const){
    const f=await fixture();f.providerState.mode=mode;
    await f.worker({providerTimeoutMs:10,maxResponseCodePoints:5}).drainOnce();
    const approval=f.database.prepare('SELECT status,release_error_code FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_error_code:string};
    assert.equal(approval.status,'release_indeterminate');assert.equal(approval.release_error_code,mode==='hang'?'provider_timeout':'provider_response_too_large');
    if(mode==='hang')assert.equal(f.providerState.returns,1,'provider timeout must close the upstream iterator');
    assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);
    const usage=f.database.prepare('SELECT input_tokens,output_tokens,cost_microusd,provider_cost_microusd,customer_charge_microusd FROM usage_records WHERE tenant_id=?').get(f.tenantId) as {input_tokens:number;output_tokens:number;cost_microusd:number;provider_cost_microusd:number;customer_charge_microusd:number};
    if(mode==='hang')assert.deepEqual(usage,{input_tokens:0,output_tokens:0,cost_microusd:0,provider_cost_microusd:0,customer_charge_microusd:0},'a provider fence without request, text, or usage evidence must not be billed');
    else{
      const requestText=f.providerState.requests[0]!.messages.flatMap(message=>message.content).filter(part=>part.type==='text').map(part=>part.text).join('');
      assert.equal(usage.input_tokens,Math.ceil(Buffer.byteLength(requestText,'utf8')/3));
      assert.equal(usage.output_tokens,Math.ceil(Buffer.byteLength('0123456789','utf8')/3));
      assert.ok(usage.output_tokens<128,'observed output must not expand to the reservation maximum');
      assert.equal(usage.provider_cost_microusd,usage.cost_microusd);assert.equal(usage.customer_charge_microusd,0);
    }
    assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(f.sourceAssistantId),{status:'failed',error_code:'APPROVAL_RELEASE_INDETERMINATE'});
    f.database.close();
  }
});

test('stop aborts a provider or current-policy gate that ignores its signal',async()=>{
  const provider=await fixture();provider.providerState.mode='hang';const providerWorker=provider.worker({providerTimeoutMs:60_000}),providerDrain=providerWorker.drainOnce();await spinUntil(()=>provider.providerState.calls===1);await providerWorker.stop();await providerDrain;
  assert.equal(provider.providerState.returns,1,'worker shutdown must close the upstream iterator');assert.equal(provider.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(provider.approvalId),'release_indeterminate');assert.equal(provider.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(provider.tenantId),0);provider.database.close();
  const gate=await fixture();gate.gateState.hangRelease=true;const gateWorker=gate.worker(),gateDrain=gateWorker.drainOnce();await spinUntil(()=>gate.gateContexts.some(context=>typeof context.metadata.approvalReleasePhase==='string'));await gateWorker.stop();await gateDrain;
  assert.equal(gate.providerState.calls,0);assert.equal(gate.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(gate.approvalId),'release_failed');gate.database.close();
});

test('a stale lease after dispatch never redispatches or bills without a durable usage checkpoint',async()=>{
  const f=await fixture(),releaseMessageId=randomUUID(),releaseUserMessageId=randomUUID(),releaseRunId=randomUUID(),conversationId=f.database.prepare('SELECT conversation_id FROM policy_violations WHERE approval_id=?').pluck().get(f.approvalId) as string;
  const ledger=new GovernanceLedger(f.database),grant=ledger.reserve({idempotencyKey:`approval:${f.approvalId}:attempt:1`,tenantId:f.tenantId,userId:f.userId,groupIds:[],conversationId,messageId:releaseMessageId,modelId:f.modelId,provider:'openai',estimatedInputTokens:10,requestedMaxOutputTokens:128,now:NOW});
  f.database.prepare("INSERT INTO messages(tenant_id,id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,?,'user','complete',2,?)").run(f.tenantId,releaseUserMessageId,conversationId,f.sourceAssistantId,f.userId,NOW);
  f.database.prepare("INSERT INTO messages(tenant_id,id,conversation_id,parent_message_id,role,status,sequence_no,model_catalog_id,provider_key,created_at,approval_id) VALUES(?,?,?,?,'assistant','pending',3,?,'openai',?,?)").run(f.tenantId,releaseMessageId,conversationId,releaseUserMessageId,f.modelId,NOW,f.approvalId);
  f.database.prepare("INSERT INTO message_parts(tenant_id,id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','', '{}',?)").run(f.tenantId,randomUUID(),releaseMessageId,NOW);
  f.database.prepare("UPDATE policy_approval_requests SET status='releasing',release_attempts=1,release_run_id=?,release_user_message_id=?,release_message_id=?,release_reservation_id=?,release_lease_owner='lost-worker',release_lease_expires_at_ms=?,release_phase='dispatching',provider_started_at_ms=?,version=version+1 WHERE id=?").run(releaseRunId,releaseUserMessageId,releaseMessageId,grant.reservationId,NOW-1,NOW-10,f.approvalId);
  ledger.release(grant.reservationId,'reservation expired after provider dispatch',NOW-5);assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(grant.reservationId),'released');
  await f.worker().drainOnce();
  assert.equal(f.providerState.calls,0);assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId),'release_indeterminate');
  assert.equal(f.database.prepare('SELECT status FROM policy_violations WHERE approval_id=?').pluck().get(f.approvalId),'open','an indeterminate provider outcome remains visible for manual triage');
  assert.equal(f.database.prepare('SELECT status FROM gate_decisions WHERE id=(SELECT gate_decision_id FROM policy_approval_requests WHERE id=?)').pluck().get(f.approvalId),'approved','the reviewer approval remains recorded even when dispatch outcome is unknown');
  assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(grant.reservationId),'settled');
  assert.deepEqual(f.database.prepare('SELECT input_tokens,output_tokens,cost_microusd,provider_cost_microusd,customer_charge_microusd FROM usage_records WHERE tenant_id=?').get(f.tenantId),{input_tokens:0,output_tokens:0,cost_microusd:0,provider_cost_microusd:0,customer_charge_microusd:0});
  assert.deepEqual(f.database.prepare("SELECT kind,COUNT(*) count FROM budget_ledger WHERE json_extract(metadata_json,'$.reservationId')=? AND kind IN ('release','settle') GROUP BY kind ORDER BY kind").all(grant.reservationId),[{kind:'release',count:1},{kind:'settle',count:1}]);
  assert.equal((JSON.parse(f.database.prepare('SELECT response_json FROM idempotency_records WHERE run_id=?').pluck().get(f.runId) as string) as {run:{status:string}}).run.status,'failed');
  const replay=[];for await(const event of f.app.replay(f.context,f.runId,0,new AbortController().signal))replay.push(event.event.event);
  assert.equal(replay.at(-1),'run.failed');assert.equal(replay.includes('run.completed'),false);
  f.database.close();
});

test('a released reservation from a crashed predispatch attempt is never reused',async()=>{
  const f=await fixture(),releaseMessageId=randomUUID(),releaseUserMessageId=randomUUID(),releaseRunId=randomUUID(),conversationId=f.database.prepare('SELECT conversation_id FROM policy_violations WHERE approval_id=?').pluck().get(f.approvalId) as string,ledger=new GovernanceLedger(f.database);
  const stale=ledger.reserve({idempotencyKey:`approval:${f.approvalId}:attempt:1`,tenantId:f.tenantId,userId:f.userId,groupIds:[],conversationId,messageId:releaseMessageId,modelId:f.modelId,provider:'openai',estimatedInputTokens:10,requestedMaxOutputTokens:128,now:NOW});ledger.release(stale.reservationId,'crashed preparation expired',NOW+1);
  f.database.prepare("UPDATE policy_approval_requests SET status='releasing',release_attempts=1,release_run_id=?,release_user_message_id=?,release_message_id=?,release_reservation_id=NULL,release_lease_owner='lost-worker',release_lease_expires_at_ms=?,release_phase='claimed',version=version+1 WHERE id=?").run(releaseRunId,releaseUserMessageId,releaseMessageId,NOW-1,f.approvalId);
  await f.worker().drainOnce();const row=f.database.prepare('SELECT status,release_attempts,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_attempts:number;release_reservation_id:string};assert.equal(row.status,'released');assert.equal(row.release_attempts,2);assert.notEqual(row.release_reservation_id,stale.reservationId);assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(stale.reservationId),'released');assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(row.release_reservation_id),'settled');assert.equal(f.providerState.calls,1);f.database.close();
});

test('a rate-limited prepared attempt releases its reservation and reuses stable message ids on retry',async()=>{
  const f=await fixture(),window=Math.floor(NOW/60_000)*60_000;
  f.database.prepare('UPDATE tenant_settings SET requests_per_minute=1 WHERE tenant_id=?').run(f.tenantId);
  f.database.prepare("INSERT INTO rate_limit_buckets(tenant_id,user_id,bucket_key,window_start,count,updated_at) VALUES(?,?,'requests',?,1,?)").run(f.tenantId,f.userId,window,NOW);
  await f.worker().drainOnce();
  const failed=f.database.prepare('SELECT status,release_user_message_id,release_message_id,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as {status:string;release_user_message_id:string;release_message_id:string;release_reservation_id:string};
  assert.equal(failed.status,'release_failed');assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(failed.release_reservation_id),'released');
  f.clock.now+=60_001;await f.worker().drainOnce();
  const released=f.database.prepare('SELECT status,release_user_message_id,release_message_id,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId) as typeof failed;
  assert.equal(released.status,'released');assert.equal(released.release_user_message_id,failed.release_user_message_id);assert.equal(released.release_message_id,failed.release_message_id);assert.notEqual(released.release_reservation_id,failed.release_reservation_id);
  assert.equal(f.providerState.calls,1);assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE approval_id=?').pluck().get(f.approvalId),1);
  f.database.close();
});

test('approval routing and reservation share the multilingual UTF-8 input estimate',async()=>{
  const f=await fixture({routedMode:'single',content:'請比較資料治理方案 🧑‍💻 with code `const 狀態 = true`'});
  await f.worker().drainOnce();
  const requestText=f.providerState.requests[0]!.messages.flatMap(message=>message.content).filter(part=>part.type==='text').map(part=>part.text).join('');
  const reservationId=f.database.prepare('SELECT release_reservation_id FROM policy_approval_requests WHERE id=?').pluck().get(f.approvalId) as string;
  const metadata=JSON.parse(f.database.prepare('SELECT metadata_json FROM budget_reservations WHERE id=?').pluck().get(reservationId) as string) as {input:number};
  assert.equal(metadata.input,Math.ceil(Buffer.byteLength(requestText,'utf8')/3));
  assert.notEqual(metadata.input,Math.ceil(requestText.length/3),'CJK and emoji must not use JavaScript UTF-16 length');
  f.database.close();
});

test('approval billing uses the durable provider-start credential source',async()=>{
  for(const credentialSource of ['platform','byok'] as const){
    const f=await fixture({credentialSource});await f.worker().drainOnce();
    const usage=f.database.prepare('SELECT provider_cost_microusd,customer_charge_microusd,credential_source FROM usage_records WHERE tenant_id=?').get(f.tenantId) as {provider_cost_microusd:number;customer_charge_microusd:number;credential_source:string};
    assert.ok(usage.provider_cost_microusd>0);assert.equal(usage.credential_source,credentialSource);assert.equal(usage.customer_charge_microusd,0);
    const messageCost=f.database.prepare('SELECT cost_microusd FROM messages WHERE tenant_id=? AND approval_id=?').pluck().get(f.tenantId,f.approvalId);assert.equal(messageCost,usage.provider_cost_microusd);
    const providerCall=JSON.parse(f.database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='chat.provider_called' AND message_id=(SELECT release_message_id FROM policy_approval_requests WHERE tenant_id=? AND id=?) ORDER BY sequence DESC LIMIT 1").pluck().get(f.tenantId,f.tenantId,f.approvalId) as string) as {credentialSource:string};assert.equal(providerCall.credentialSource,credentialSource);
    const messageCompleted=JSON.parse(f.database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='chat.message_completed' AND message_id=(SELECT release_message_id FROM policy_approval_requests WHERE tenant_id=? AND id=?) ORDER BY sequence DESC LIMIT 1").pluck().get(f.tenantId,f.tenantId,f.approvalId) as string) as {costUsdMicros:number;providerCostMicrousd:number};
    assert.equal(messageCompleted.costUsdMicros,usage.provider_cost_microusd);assert.equal(messageCompleted.providerCostMicrousd,usage.provider_cost_microusd);
    f.database.close();
  }
});

test('a route-less legacy approval with mutable zero pricing is cancelled before reservation or provider dispatch',async()=>{
  const f=await fixture(),routeId=f.database.prepare('SELECT routing_decision_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.approvalId) as string;
  f.database.prepare('UPDATE policy_approval_requests SET routing_decision_id=NULL WHERE tenant_id=? AND id=?').run(f.tenantId,f.approvalId);
  f.database.prepare("UPDATE model_catalog SET platform_model_version_id=NULL,provider_key='openrouter',model_key='tenant-zero-price',input_microusd_per_million=0,output_microusd_per_million=0 WHERE tenant_id=? AND id=?").run(f.tenantId,f.modelId);

  await f.worker().drainOnce();

  assert.equal(f.providerState.calls,0);
  assert.deepEqual(f.database.prepare('SELECT status,release_error_code,release_reservation_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(f.tenantId,f.approvalId),
    {status:'cancelled',release_error_code:'model_unavailable',release_reservation_id:null});
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=?').pluck().get(f.tenantId),0);
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE tenant_id=?').pluck().get(f.tenantId),0);
  assert.equal(f.database.prepare('SELECT status FROM routing_decisions WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,routeId),'selected');
  f.database.close();
});

test('a legacy queued multi-model approval terminates without collapsing into one provider call',async()=>{
  const f=await fixture({routedMode:'single'}),routeId=f.database.prepare('SELECT id FROM routing_decisions WHERE run_id=?').pluck().get(f.runId) as string;
  f.database.prepare("UPDATE routing_decisions SET mode='multi_model',selected_model_catalog_id=NULL,selected_platform_model_version_id=NULL,selected_provider=NULL WHERE tenant_id=? AND id=?").run(f.tenantId,routeId);
  await f.worker().drainOnce();
  assert.equal(f.providerState.calls,0);
  assert.deepEqual(f.database.prepare('SELECT status,release_error_code,release_reservation_id FROM policy_approval_requests WHERE id=?').get(f.approvalId),{status:'cancelled',release_error_code:'multi_model_approval_unsupported',release_reservation_id:null});
  assert.equal(f.database.prepare('SELECT status FROM routing_decisions WHERE id=?').pluck().get(routeId),'cancelled');
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE tenant_id=? AND status='active'").pluck().get(f.tenantId),0);
  f.database.close();
});

test('a credential switch during approval wait bills BYOK at zero while retaining shadow provider cost',async()=>{
  const f=await fixture({routedMode:'single'}),routeId=f.database.prepare('SELECT id FROM routing_decisions WHERE run_id=?').pluck().get(f.runId) as string;
  f.database.prepare("UPDATE model_catalog SET platform_model_version_id=NULL,model_key='tenant-approved-model' WHERE tenant_id=? AND id=?").run(f.tenantId,f.modelId);
  f.database.prepare('UPDATE routing_decisions SET selected_platform_model_version_id=NULL WHERE tenant_id=? AND id=?').run(f.tenantId,routeId);
  f.database.prepare("UPDATE provider_config SET credential_source='encrypted',credential_ciphertext='opaque-test-envelope',key_version=1 WHERE tenant_id=? AND provider_key='openai'").run(f.tenantId);
  await f.worker().drainOnce();
  assert.equal(f.providerState.calls,1);assert.equal(f.providerState.requests[0]?.model,'tenant-approved-model');
  assert.deepEqual(f.database.prepare('SELECT provider_cost_microusd,customer_charge_microusd,credential_source,routing_decision_id FROM usage_records WHERE routing_decision_id=?').get(routeId),{provider_cost_microusd:2,customer_charge_microusd:0,credential_source:'byok',routing_decision_id:routeId});
  assert.equal(f.database.prepare('SELECT cost_microusd FROM messages WHERE approval_id=?').pluck().get(f.approvalId),2);
  assert.equal(f.database.prepare('SELECT credential_source FROM routing_decisions WHERE id=?').pluck().get(routeId),'byok');
  f.database.close();
});
