import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import type { AppVariables, TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { ChatProvider, ChatRequest } from '../../lib/providers/types.js';
import type { RouteRequest } from '../../routes/types.js';
import type { GateAction, TenantId } from '../../shared/api.js';
import { createChatRoutes } from '../../routes/chat.js';
import { createAuditRouteAdapter } from '../audit/adapters.js';
import { MessageRepository } from '../repositories/messages.js';
import { openApprovalEnvelope } from './approval-envelope.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,7,9,15,0,0),APPROVAL_KEY=Buffer.alloc(32,9);

interface Seed {
  tenantId:TenantId;userId:string;colleagueId:string;groupId:string;modelId:string;
  projectId:string;otherProjectId:string;context:TenantContext;
}

function seed(database:Database.Database,label:string):Seed {
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),colleagueId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),providerId=randomUUID(),projectId=randomUUID(),otherProjectId=randomUUID();
  const run=(sql:string,...params:unknown[])=>database.prepare(sql).run(...params);
  const platform=database.prepare<[],{id:string;provider_key:string;model_key:string;display_name:string;context_window:number;max_output_tokens:number;input_microusd_per_million:number;output_microusd_per_million:number;capabilities_json:string}>(`SELECT id,provider_key,model_key,display_name,context_window,max_output_tokens,
    input_microusd_per_million,output_microusd_per_million,capabilities_json FROM platform_model_versions
    WHERE provider_key='openai' AND model_key='gpt-5.6-luna' AND authoritative=1`).get();
  assert.ok(platform);database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(platform.id);
  run("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)",tenantId,`${label}-${tenantId.slice(0,8)}`,label,NOW,NOW);
  run('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)',tenantId,NOW);
  for(const [id,email,name] of [[userId,`${label}@example.test`,'Owner'],[colleagueId,`colleague-${label}@example.test`,'Colleague']] as const)
    run("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)",id,tenantId,email,name,'x',NOW,NOW);
  run('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',groupId,tenantId,'Members',NOW,NOW);
  for(const id of [userId,colleagueId])run("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)",tenantId,groupId,id,NOW);
  run(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,
    input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at)
    VALUES(?,?,?,?,?,1,1,?,?,?,?,?,?,?,?)`,modelId,tenantId,platform.provider_key,platform.model_key,platform.display_name,
    platform.context_window,platform.max_output_tokens,platform.input_microusd_per_million,platform.output_microusd_per_million,
    platform.capabilities_json,platform.id,NOW,NOW);
  run("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at) VALUES(?,?,?,1,'encrypted','fixture',1,'{}',?,?)",providerId,tenantId,platform.provider_key,NOW,NOW);
  run('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)',groupId,modelId);
  run('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)',groupId,providerId);
  for(const [id,name] of [[projectId,'Governed files'],[otherProjectId,'Other project']] as const)
    run('INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)',id,tenantId,userId,name,NOW,NOW);
  const context={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  return {tenantId,userId,colleagueId,groupId,modelId,projectId,otherProjectId,context};
}

function addFile(database:Database.Database,tenant:Seed,input:{projectId?:string;ownerId?:string;text?:string|null;status?:string;name?:string}={}):string {
  const id=randomUUID(),text=input.text===undefined?'TOP_SECRET acquisition plan':input.text,status=input.status??'ready',owner=input.ownerId??tenant.userId,project=input.projectId??tenant.projectId;
  if(owner!==tenant.userId){const exists=database.prepare('SELECT 1 FROM projects WHERE id=?').get(project);if(!exists)database.prepare('INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(project,tenant.tenantId,owner,'Colleague files',NOW,NOW);}
  const digest=createHash('sha256').update(`${id}:${text??''}`).digest('hex');
  database.prepare('INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,extraction_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,tenant.tenantId,project,owner,input.name??'evidence.txt',`${tenant.tenantId}/${project}/${id}`,'text/plain',Math.max(1,Buffer.byteLength(text??'x')),digest,status,text,status==='ready'?null:'CORRUPT_FILE',NOW);
  return id;
}

function fixture(options:{waitingRunTtlMs?:number;warningSweepRetryBaseMs?:number;warningSweepRetryMaxMs?:number;logger?:Pick<Console,'error'>}={}){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const primary=seed(database,'primary'),foreign=seed(database,'foreign');
  let fileAction:GateAction='allow',outboundAction:GateAction='allow',providerCalls=0;const providerTexts:string[]=[],contexts:GateContext[]=[],fileRuleId=randomUUID(),outboundRuleId=randomUUID();
  const gate:GateEngine={async evaluate(context:GateContext):Promise<GateVerdict>{
    contexts.push(context);const isFile=context.pass==='preflight'&&context.parts.some(part=>part.source==='file_extraction'),action=isFile?fileAction:context.pass==='preflight'?outboundAction:'allow';
    const confirmed=action==='warn'&&Boolean(context.confirmedWarningToken),allowed=action==='allow'||action==='flag'||action==='redact'||confirmed;
    const providerParts=allowed?context.parts.map(part=>{
      if(action==='redact')return {...part,text:part.text.replaceAll('TOP_SECRET','[FILE_REDACTED]')};
      if(action==='warn'&&confirmed&&!isFile)return {...part,text:part.text.replaceAll('PROMPT_SECRET','[PROMPT_REDACTED]')};
      return part;
    }):null;
    const matchedPart=isFile?context.parts[0]:context.parts.at(-1),matches=action==='allow'||!matchedPart?[]:[{matchId:randomUUID(),detectorId:isFile?'file-test':'outbound-test',detectorKind:'keyword' as const,ruleId:isFile?fileRuleId:outboundRuleId,ruleRevision:1,partId:matchedPart.id,category:'test',action,confidence:'high' as const,span:null,normalizedFingerprint:'opaque',safeExcerpt:'[RESTRICTED]',replacementLabel:null,metadata:{}}];
    return {evaluationId:context.evaluationId,pass:context.pass,action,
      disposition:context.pass==='postflight'?'release_to_user':action==='warn'&&!confirmed?'await_user_confirmation':action==='block'?'blocked':action==='require_approval'?'pending_approval':'allow_provider_call',
      matches,providerParts,displayParts:context.pass==='postflight'?context.parts:null,redactions:[],masks:[],warningToken:action==='warn'&&!confirmed?`warning-${isFile?'file':'outbound'}-${context.evaluationId}`:null,
      approvalRequestId:action==='require_approval'?randomUUID():null,policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:context.policySnapshot.fingerprint,
      degraded:false,failureCodes:[],timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};
  },createPostflightStream(){throw new Error('unused');}};
  const provider:ChatProvider={id:'openai',protocols:['openai_responses'],configured:true,supports:()=>true,health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),async *stream(request:ChatRequest){
    providerCalls++;providerTexts.push(request.messages.flatMap(message=>message.content).filter(part=>part.type==='text').map(part=>part.text).join('\n'));
    yield{type:'start',requestId:'provider-request',model:request.model,createdAt:NOW};yield{type:'text_delta',index:0,delta:'safe answer'};
    yield{type:'usage',usage:{inputTokens:12,outputTokens:2,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:14,estimated:false,source:'provider'}};yield{type:'finish',reason:'stop'};
  }};
  const clock={now:NOW};let auditNow=NOW;const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>auditNow++});
  const serviceOptions={...(options.waitingRunTtlMs===undefined?{}:{waitingRunTtlMs:options.waitingRunTtlMs}),...(options.warningSweepRetryBaseMs===undefined?{}:{warningSweepRetryBaseMs:options.warningSweepRetryBaseMs}),...(options.warningSweepRetryMaxMs===undefined?{}:{warningSweepRetryMaxMs:options.warningSweepRetryMaxMs}),...(options.logger===undefined?{}:{logger:options.logger})};
  const providers={get:()=>provider},service=new GovernedChatApplication({database,gate,providers,audit,approvalPayloadKey:APPROVAL_KEY,now:()=>clock.now,...serviceOptions});
  const restartService=()=>new GovernedChatApplication({database,gate,providers,audit,approvalPayloadKey:APPROVAL_KEY,now:()=>clock.now,...serviceOptions});
  const routeFor=(tenant:Seed)=>{const app=new Hono<{Variables:AppVariables}>();app.use('*',async(c,next)=>{c.set('requestId',tenant.context.requestId);c.set('principal',tenant.context.principal);c.set('tenant',tenant.context);await next();});app.route('/',createChatRoutes(service));return app;};
  const setFileAction=(action:GateAction)=>{fileAction=action;};
  const setOutboundAction=(action:GateAction)=>{outboundAction=action;};
  const changePolicyFingerprint=()=>{const policyId=randomUUID(),detectorId=randomUUID();database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Changed policy',?,?)").run(policyId,primary.tenantId,NOW,NOW);database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detectorId,primary.tenantId,`changed-${detectorId}`,'b'.repeat(64),NOW,NOW);database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'tenant',NULL,'outbound','warn','high','{}',1,900,?,?)").run(randomUUID(),primary.tenantId,policyId,detectorId,NOW,NOW+1);};
  return {database,primary,foreign,service,restartService,audit,clock,routeFor,setFileAction,setOutboundAction,changePolicyFingerprint,contexts,providerTexts,providerCalls:()=>providerCalls};
}

const request=(modelId:string,fileIds:readonly string[],content='')=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({content,modelId,fileIds,clientRequestId:randomUUID()})});
const claim=()=>({key:randomUUID(),requestHash:randomUUID().replaceAll('-','').padEnd(64,'0'),method:'POST',path:'/chat/runs'});

test('file-only chat scans full extracted text, sends only authorized context, and persists provenance',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary);f.setFileAction('redact');
  const response=await f.routeFor(f.primary).request('/chat/runs',request(f.primary.modelId,[fileId]));const events=await response.text();
  assert.equal(response.status,200);assert.match(events,/event: run.completed/);assert.equal(f.providerCalls(),1);
  assert.match(f.providerTexts[0]!,/\[FILE_REDACTED\] acquisition plan/);assert.doesNotMatch(f.providerTexts[0]!,/TOP_SECRET/);
  assert.match(f.providerTexts[0]!,/untrusted reference data/);assert.match(f.providerTexts[0]!,/BEGIN ATTACHMENT 1/);
  const fileContext=f.contexts.find(context=>context.parts.some(part=>part.source==='file_extraction'))!;
  assert.equal(fileContext.parts[0]?.text,'TOP_SECRET acquisition plan','the complete extraction is gated before context clipping');
  const directions=f.database.prepare('SELECT direction FROM gate_decisions WHERE tenant_id=? ORDER BY decided_at,id').pluck().all(f.primary.tenantId);
  assert.ok(directions.includes('file'));assert.ok(directions.includes('outbound'));
  const part=f.database.prepare("SELECT kind,file_id,metadata_json FROM message_parts WHERE tenant_id=? AND file_id=?").get(f.primary.tenantId,fileId) as {kind:string;file_id:string;metadata_json:string};
  assert.equal(part.kind,'file_ref');assert.equal(part.file_id,fileId);assert.equal(JSON.parse(part.metadata_json).gateAction,'redact');
  assert.equal(f.database.prepare('SELECT project_id FROM project_conversations WHERE conversation_id=(SELECT conversation_id FROM messages WHERE id=(SELECT message_id FROM message_parts WHERE file_id=?))').pluck().get(fileId),f.primary.projectId);
  const fileRow=f.database.prepare('SELECT sha256,extracted_text FROM project_files WHERE id=?').get(fileId) as {sha256:string;extracted_text:string};
  const auditMetadata=f.database.prepare("SELECT metadata_json FROM audit_events WHERE target_id=? AND action='chat.file_extracted'").pluck().all(fileId).map(String);
  assert.ok(auditMetadata.length>0);for(const metadata of auditMetadata){assert.doesNotMatch(metadata,new RegExp(fileRow.sha256));assert.doesNotMatch(metadata,/TOP_SECRET|acquisition plan/);}
  const incident=f.database.prepare("SELECT project_id FROM audit_events WHERE action='gate.content_redacted' AND message_id=(SELECT message_id FROM message_parts WHERE file_id=?) AND json_extract(metadata_json,'$.direction')='file'").get(fileId) as {project_id:string};
  assert.equal(incident.project_id,f.primary.projectId,'the incident event must carry the project used by the violation projection');
  const queue=createAuditRouteAdapter({database:f.database,cursorKey:Buffer.alloc(32,3),ipHmacKey:Buffer.alloc(32,1),idempotencyHmacKey:Buffer.alloc(32,4),exportDirectory:'/tmp/gateway-file-gate-audit',audit:f.audit,
    approvalReleaseAvailable:true,approvalReleaseQueue:{wake(){}},now:()=>NOW});
  const queueRequest=(project:string):RouteRequest=>({tenant:f.primary.context,requestId:f.primary.context.requestId,params:{},query:{direction:'file',project},headers:new Headers(),body:null,rawBody:null});
  const matching=await queue.execute('admin.violations',queueRequest('Governed files'));
  assert.equal(matching.status,undefined);const items=(matching.body as {items:Array<Record<string,unknown>>}).items;
  assert.equal(items.length,1);assert.deepEqual({project:items[0]?.project,projectId:items[0]?.projectId,direction:items[0]?.direction},{project:'Governed files',projectId:f.primary.projectId,direction:'file'});
  const excluded=await queue.execute('admin.violations',queueRequest('Other project'));
  assert.deepEqual((excluded.body as {items:unknown[]}).items,[],'the project filter must exclude a file incident from another project');
  f.database.close();
});

test('file block, warning, and approval are terminal and never call the provider',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary);
  for(const action of ['block','warn','require_approval'] as const){
    f.setFileAction(action);const response=await f.routeFor(f.primary).request('/chat/runs',request(f.primary.modelId,[fileId],'Review the attachment'));const body=await response.text();
    assert.match(body,new RegExp(`\"action\":\"${action}\"`));assert.match(body,/\"direction\":\"file\"/);assert.doesNotMatch(body,/event: run.completed/);
  }
  assert.equal(f.providerCalls(),0,'no terminal file verdict may reach a provider');
  assert.deepEqual(f.database.prepare('SELECT gate_action FROM policy_violations WHERE tenant_id=? AND direction=? ORDER BY created_at_ms,id').pluck().all(f.primary.tenantId,'file').sort(),['block','require_approval','warn']);
  const approval=f.database.prepare('SELECT * FROM policy_approval_requests WHERE tenant_id=?').get(f.primary.tenantId) as Record<string,unknown>;
  const opened=openApprovalEnvelope(APPROVAL_KEY,{tenantId:f.primary.tenantId,approvalId:String(approval.id),violationId:String(approval.violation_id),ciphertext:approval.payload_ciphertext as Buffer,nonce:approval.payload_nonce as Buffer,keyVersion:Number(approval.key_version),cryptoScheme:approval.payload_crypto_scheme as 'dek_v2',wrappedDek:approval.payload_wrapped_dek as Buffer,wrapNonce:approval.payload_wrap_nonce as Buffer,kekVersion:Number(approval.payload_kek_version)});
  assert.equal(opened.messages.at(-1)?.content[0]?.type,'text');assert.equal((opened.messages.at(-1)?.content[0] as {text:string}).text,'Review the attachment');
  assert.equal(opened.attachments?.length,1);assert.equal(opened.attachments?.[0]?.fileId,fileId);assert.equal(opened.attachments?.[0]?.extractedText,'TOP_SECRET acquisition plan');
  assert.doesNotMatch(JSON.stringify(opened.messages),/TOP_SECRET/,'attachments must remain structured for release-time file re-gating');
  f.database.close();
});

test('file and outbound warnings require separate confirmations before provider dispatch',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary);f.setFileAction('warn');f.setOutboundAction('warn');
  const prepared=await f.service.createRun(f.primary.context,{content:'PROMPT_SECRET request',modelId:f.primary.modelId,fileIds:[fileId],clientRequestId:randomUUID()},'create',claim());
  const evaluate=()=>f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
  const fingerprint=f.service.policyFingerprint(f.primary.context);
  const refreshed=()=>new MessageRepository(f.database).all(f.primary.context,prepared.run.conversationId).find(message=>message.id===prepared.run.userMessageId);

  const fileWarning=await evaluate();
  assert.equal(fileWarning.direction,'file');assert.ok(fileWarning.confirmationToken);
  assert.equal(refreshed()?.content,'Confirmation is required','the unconfirmed prompt must never be written to the transcript');
  assert.ok(await f.service.authorizeWarnedRun(f.primary.context,fileWarning.decisionId,{token:fileWarning.confirmationToken!,policyFingerprint:fingerprint}));

  const beforeOutbound=f.contexts.length,outboundWarning=await evaluate(),secondPass=f.contexts.slice(beforeOutbound);
  assert.equal(outboundWarning.direction,'outbound');assert.ok(outboundWarning.confirmationToken,'the prompt warning must still be shown after the file warning was confirmed');
  assert.match(secondPass[0]?.confirmedWarningToken??'',/^warning-file-/);
  assert.equal(secondPass[1]?.confirmedWarningToken,null,'file consent must never authorize a prompt warning');
  assert.equal(refreshed()?.content,'Confirmation is required','confirming only the file must leave the prompt withheld');
  assert.ok(await f.service.authorizeWarnedRun(f.primary.context,outboundWarning.decisionId,{token:outboundWarning.confirmationToken!,policyFingerprint:fingerprint}));

  const beforeAuthorized=f.contexts.length,authorized=await evaluate(),thirdPass=f.contexts.slice(beforeAuthorized);
  assert.equal(authorized.action,'warn');assert.equal(authorized.confirmationToken,undefined);
  assert.match(thirdPass[0]?.confirmedWarningToken??'',/^warning-file-/);
  assert.match(thirdPass[1]?.confirmedWarningToken??'',/^warning-outbound-/,'the second confirmation must not loop back to the file warning');
  assert.equal(authorized.effectiveText,'[PROMPT_REDACTED] request');
  assert.deepEqual(refreshed()&&{content:refreshed()!.content,role:refreshed()!.role},{content:'[PROMPT_REDACTED] request',role:'user'},
    'a fresh repository read must return the exact outbound provider part only after both warnings are authorized');
  assert.equal(f.database.prepare('SELECT kind FROM message_parts WHERE message_id=? AND ordinal=0').pluck().get(prepared.run.userMessageId),'redacted_text');
  const reservation=await f.service.reserveBudget(f.primary.context,prepared.run);
  await f.service.dispatchStarted(f.primary.context,prepared.run,reservation);
  for await(const _ of f.service.streamProvider(f.primary.context,prepared.providerRequest,{preflightDecisionId:authorized.decisionId,reservationId:reservation.id,effectiveText:authorized.effectiveText},new AbortController().signal)){}
  assert.equal(f.providerCalls(),1,'the provider is called only after both direction-scoped warnings are confirmed');
  assert.match(f.providerTexts[0]!,/\[PROMPT_REDACTED\] request/);assert.doesNotMatch(f.providerTexts[0]!,/PROMPT_SECRET/);
  f.database.close();
});

test('confirmed warning text and its re-evaluated decisions commit atomically',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary);f.setFileAction('warn');f.setOutboundAction('allow');
  const prepared=await f.service.createRun(f.primary.context,{content:'Review the attachment',modelId:f.primary.modelId,fileIds:[fileId],clientRequestId:randomUUID()},'create',claim());
  const evaluate=()=>f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
  const warned=await evaluate(),fingerprint=f.service.policyFingerprint(f.primary.context);
  assert.ok(warned.confirmationToken);assert.ok(await f.service.authorizeWarnedRun(f.primary.context,warned.decisionId,{token:warned.confirmationToken!,policyFingerprint:fingerprint}));
  const before=f.database.prepare('SELECT COUNT(*) count FROM gate_decisions WHERE tenant_id=?').pluck().get(f.primary.tenantId);
  f.database.exec("CREATE TRIGGER refuse_warning_finalize BEFORE UPDATE OF text_content ON message_parts BEGIN SELECT RAISE(ABORT,'finalize refused'); END");
  await assert.rejects(evaluate,/finalize refused/);
  assert.equal(f.database.prepare('SELECT text_content FROM message_parts WHERE message_id=? AND ordinal=0').pluck().get(prepared.run.userMessageId),'Confirmation is required');
  assert.equal(f.database.prepare('SELECT COUNT(*) count FROM gate_decisions WHERE tenant_id=?').pluck().get(f.primary.tenantId),before,'re-evaluated decisions must roll back with the transcript update');
  assert.equal(f.database.prepare("SELECT status FROM policy_violations WHERE tenant_id=? AND message_id=? AND direction='file'").pluck().get(f.primary.tenantId,prepared.run.userMessageId),'open');
  f.database.exec('DROP TRIGGER refuse_warning_finalize');
  const authorized=await evaluate();assert.equal(authorized.effectiveText,'Review the attachment');
  assert.equal(new MessageRepository(f.database).all(f.primary.context,prepared.run.conversationId).find(message=>message.id===prepared.run.userMessageId)?.content,'Review the attachment');
  f.database.close();
});

test('a policy fingerprint change invalidates every direction-scoped warning confirmation',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary);f.setFileAction('warn');f.setOutboundAction('warn');
  const prepared=await f.service.createRun(f.primary.context,{content:'Review the attachment',modelId:f.primary.modelId,fileIds:[fileId],clientRequestId:randomUUID()},'create',claim());
  const evaluate=()=>f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
  const fingerprint=f.service.policyFingerprint(f.primary.context),fileWarning=await evaluate();
  await f.service.authorizeWarnedRun(f.primary.context,fileWarning.decisionId,{token:fileWarning.confirmationToken!,policyFingerprint:fingerprint});
  const outboundWarning=await evaluate();
  await f.service.authorizeWarnedRun(f.primary.context,outboundWarning.decisionId,{token:outboundWarning.confirmationToken!,policyFingerprint:fingerprint});

  f.changePolicyFingerprint();assert.notEqual(f.service.policyFingerprint(f.primary.context),fingerprint);
  f.setOutboundAction('allow');const beforeFile=f.contexts.length,renewedFile=await evaluate();
  assert.equal(renewedFile.direction,'file');assert.equal(f.contexts.slice(beforeFile)[0]?.confirmedWarningToken,null);
  f.setFileAction('allow');f.setOutboundAction('warn');const beforeOutbound=f.contexts.length,renewedOutbound=await evaluate();
  assert.equal(renewedOutbound.direction,'outbound');assert.equal(f.contexts.slice(beforeOutbound).at(-1)?.confirmedWarningToken,null);
  assert.equal(f.providerCalls(),0);
  f.database.close();
});

test('an unconfirmed warning expires to one durable terminal run across timer and restart',async()=>{
  const f=fixture({waitingRunTtlMs:5});f.setOutboundAction('warn');
  const prepared=await f.service.createRun(f.primary.context,{content:'Confirm this send',modelId:f.primary.modelId,clientRequestId:randomUUID()},'create',claim());
  const warned=await f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);assert.ok(warned.confirmationToken);
  await f.service.persistEvent(f.primary.context,prepared.run.id,1,{event:'run.status',data:{runId:prepared.run.id,status:'awaiting_confirmation'}});
  assert.equal((await f.service.getRun(f.primary.context,prepared.run.id))?.status,'awaiting_confirmation');
  f.clock.now+=6;await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await f.service.getRun(f.primary.context,prepared.run.id))?.status,'cancelled');assert.equal(await f.service.cancel(f.primary.context,prepared.run.id),'terminal');
  const restarted=f.restartService();assert.equal((await restarted.getRun(f.primary.context,prepared.run.id))?.status,'cancelled');
  const replay=[];for await(const event of restarted.replay(f.primary.context,prepared.run.id,0,new AbortController().signal))replay.push(event.event.event);
  assert.equal(replay.at(-1),'run.cancelled');assert.equal(await restarted.authorizeWarnedRun(f.primary.context,warned.decisionId,{token:warned.confirmationToken!,policyFingerprint:restarted.policyFingerprint(f.primary.context)}),null);
  assert.deepEqual(f.database.prepare('SELECT status FROM gate_decisions WHERE id=?').get(warned.decisionId),{status:'denied'});
  assert.equal(f.database.prepare("SELECT status FROM policy_violations WHERE message_id=? AND gate_action='warn'").pluck().get(prepared.run.userMessageId),'expired');
  assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(prepared.assistant.id),{status:'blocked',error_code:'WARNING_EXPIRED'});
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.warning_declined'").pluck().get(f.primary.tenantId),1);assert.equal(f.providerCalls(),0);f.database.close();
});

test('warning expiry audit failures use bounded exponential retry instead of a zero-delay loop',async()=>{
  const errors:string[]=[],f=fixture({waitingRunTtlMs:5,warningSweepRetryBaseMs:10,warningSweepRetryMaxMs:20,logger:{error(...values:unknown[]){errors.push(values.map(String).join(' '));}}});f.setOutboundAction('warn');
  const prepared=await f.service.createRun(f.primary.context,{content:'Confirm this send',modelId:f.primary.modelId,clientRequestId:randomUUID()},'create',claim());const warned=await f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);assert.ok(warned.confirmationToken);await f.service.persistEvent(f.primary.context,prepared.run.id,1,{event:'run.status',data:{runId:prepared.run.id,status:'awaiting_confirmation'}});
  f.database.exec("CREATE TRIGGER fail_warning_expiry_audit BEFORE INSERT ON audit_events WHEN NEW.action='gate.warning_declined' BEGIN SELECT RAISE(ABORT,'warning audit unavailable'); END");f.clock.now+=6;await new Promise(resolve=>setTimeout(resolve,58));
  assert.ok(errors.length>=2&&errors.length<=5,`expected bounded retries, saw ${errors.length}`);assert.equal(f.database.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(warned.decisionId),'awaiting_confirmation','failed audit must roll back expiry state');
  f.database.exec('DROP TRIGGER fail_warning_expiry_audit');await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.database.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(warned.decisionId),'denied');assert.equal(f.database.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.warning_declined'").pluck().get(f.primary.tenantId),1);f.service.stop();f.database.close();
});

test('an existing conversation project change cannot be silently relinked during preflight persistence',async()=>{
  const f=fixture(),fileId=addFile(f.database,f.primary),conversationId=randomUUID();
  f.database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Existing','active',?,?)").run(conversationId,f.primary.tenantId,f.primary.userId,NOW,NOW);
  f.database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)').run(f.primary.projectId,conversationId,f.primary.userId,NOW);
  const prepared=await f.service.createRun(f.primary.context,{conversationId,content:'Review',modelId:f.primary.modelId,fileIds:[fileId],clientRequestId:randomUUID()},'create',claim());
  const before={messages:f.database.prepare('SELECT COUNT(*) FROM messages WHERE tenant_id=?').pluck().get(f.primary.tenantId),decisions:f.database.prepare('SELECT COUNT(*) FROM gate_decisions WHERE tenant_id=?').pluck().get(f.primary.tenantId),violations:f.database.prepare('SELECT COUNT(*) FROM policy_violations WHERE tenant_id=?').pluck().get(f.primary.tenantId),audit:f.database.prepare('SELECT COUNT(*) FROM audit_events WHERE tenant_id=?').pluck().get(f.primary.tenantId)};
  f.database.prepare('DELETE FROM project_conversations WHERE conversation_id=?').run(conversationId);f.database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)').run(f.primary.otherProjectId,conversationId,f.primary.userId,NOW+1);
  await assert.rejects(f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal),/Conversation project changed/);
  assert.deepEqual({messages:f.database.prepare('SELECT COUNT(*) FROM messages WHERE tenant_id=?').pluck().get(f.primary.tenantId),decisions:f.database.prepare('SELECT COUNT(*) FROM gate_decisions WHERE tenant_id=?').pluck().get(f.primary.tenantId),violations:f.database.prepare('SELECT COUNT(*) FROM policy_violations WHERE tenant_id=?').pluck().get(f.primary.tenantId),audit:f.database.prepare('SELECT COUNT(*) FROM audit_events WHERE tenant_id=?').pluck().get(f.primary.tenantId)},before);
  assert.equal(f.database.prepare('SELECT project_id FROM project_conversations WHERE conversation_id=?').pluck().get(conversationId),f.primary.otherProjectId);assert.equal(f.providerCalls(),0);f.database.close();
});

test('attachments are re-fenced before warning confirmation, budget reservation, and dispatch',async()=>{
  for(const point of ['confirm','reserve','dispatch'] as const){
    const f=fixture(),fileId=addFile(f.database,f.primary);f.setFileAction(point==='confirm'?'warn':'allow');
    const prepared=await f.service.createRun(f.primary.context,{content:'Review',modelId:f.primary.modelId,fileIds:[fileId],clientRequestId:randomUUID()},'create',claim());
    const gated=await f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
    if(point==='dispatch'){
      const reservation=await f.service.reserveBudget(f.primary.context,prepared.run);f.database.prepare('UPDATE project_files SET content_purged_at=? WHERE id=?').run(NOW,fileId);
      await assert.rejects(f.service.dispatchStarted(f.primary.context,prepared.run,reservation),error=>(error as {code?:string}).code==='VALIDATION_FAILED');
    }else{
      f.database.prepare('UPDATE project_files SET deleted_at=? WHERE id=?').run(NOW,fileId);
      if(point==='confirm')await assert.rejects(f.service.authorizeWarnedRun(f.primary.context,gated.decisionId,{token:gated.confirmationToken!,policyFingerprint:f.service.policyFingerprint(f.primary.context)}),error=>(error as {code?:string}).code==='RESOURCE_NOT_FOUND');
      else await assert.rejects(f.service.reserveBudget(f.primary.context,prepared.run),error=>(error as {code?:string}).code==='RESOURCE_NOT_FOUND');
    }
    assert.equal(f.providerCalls(),0,point);f.database.close();
  }
});

test('approval handoff releases in-memory run state while preserving durable waiting status',async()=>{
  const f=fixture();f.setOutboundAction('require_approval');
  const prepared=await f.service.createRun(f.primary.context,{content:'Needs review',modelId:f.primary.modelId,clientRequestId:randomUUID()},'create',claim());
  const gated=await f.service.gate(f.primary.context,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);assert.ok(gated.approvalId);
  await f.service.persistEvent(f.primary.context,prepared.run.id,1,{event:'run.status',data:{runId:prepared.run.id,status:'awaiting_approval'}});
  assert.equal(await f.service.cancel(f.primary.context,prepared.run.id),'missing');assert.equal((await f.service.getRun(f.primary.context,prepared.run.id))?.status,'awaiting_approval');assert.equal((await f.restartService().getRun(f.primary.context,prepared.run.id))?.status,'awaiting_approval');f.database.close();
});

test('real TenantDb rejects unsafe state, actor/tenant access, and project mismatch before gating',async()=>{
  const f=fixture(),ready=addFile(f.database,f.primary),failed=addFile(f.database,f.primary,{status:'failed',text:null,name:'broken.pdf'}),foreignFile=addFile(f.database,f.foreign);
  const colleagueProject=randomUUID();f.database.prepare('INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(colleagueProject,f.primary.tenantId,f.primary.colleagueId,'Colleague files',NOW,NOW);
  const colleagueFile=addFile(f.database,f.primary,{projectId:colleagueProject,ownerId:f.primary.colleagueId,text:'colleague private'});
  for(const id of [colleagueFile,foreignFile])await assert.rejects(f.service.createRun(f.primary.context,{content:'Review',modelId:f.primary.modelId,fileIds:[id],clientRequestId:randomUUID()},'create',claim()),error=>(error as {code?:string}).code==='RESOURCE_NOT_FOUND');
  await assert.rejects(f.service.createRun(f.primary.context,{content:'Review',modelId:f.primary.modelId,fileIds:[failed],clientRequestId:randomUUID()},'create',claim()),error=>(error as {code?:string}).code==='VALIDATION_FAILED');
  const conversation=randomUUID();f.database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Bound','active',?,?)").run(conversation,f.primary.tenantId,f.primary.userId,NOW,NOW);
  f.database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)').run(f.primary.projectId,conversation,f.primary.userId,NOW);
  const mismatched=addFile(f.database,f.primary,{projectId:f.primary.otherProjectId,text:'other project'});
  await assert.rejects(f.service.createRun(f.primary.context,{conversationId:conversation,content:'Review',modelId:f.primary.modelId,fileIds:[mismatched],clientRequestId:randomUUID()},'create',claim()),error=>(error as {code?:string}).code==='VALIDATION_FAILED');
  assert.equal(f.contexts.length,0,'ownership/state/project errors must occur before policy evaluation');assert.equal(f.providerCalls(),0);
  assert.ok(ready);
  f.database.close();
});
