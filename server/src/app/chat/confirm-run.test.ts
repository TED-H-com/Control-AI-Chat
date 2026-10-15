import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService, type AuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { DefaultGateEngine, deterministicDetectors, resolvePolicy } from '../../lib/gate/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { GateContext, ResolvedRule } from '../../lib/gate/index.js';
import type { TenantContext } from '../../lib/http/index.js';
import type { ChatGateResult, ChatPipelineServices } from '../../routes/chat.js';
import type { ChatRun, GateAction, Message, StreamEvent } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { beginWarningConfirmation, resumeConfirmedRun, type ConfirmRunDependencies, type PreparedRun, type WarnedRunPipeline } from './confirm-run.js';

/**
 * The warned pass is produced by the real engine and persisted in the shape `#persistDecision`
 * writes, so the token and the decision row under test are the ones production actually creates.
 */
const SECRET=Buffer.alloc(32,7),NOW=Date.UTC(2026,7,9,12,0,0),OUTBOUND='Send the company confidential roadmap',PLACEHOLDER='Confirmation is required';
const engine=new DefaultGateEngine({detectors:deterministicDetectors(),warningSecret:SECRET});
const auditDeps=(database:Database.Database)=>({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
  retentionPolicy:(tenantId:TenantId)=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});

function rule(tenantId:string,action:GateAction):ResolvedRule {
  return {id:'rule-sensitive-terms',revision:1,name:'sensitive terms',detectorKind:'keyword',action,passMask:'preflight',priority:100,
    scopeType:'org',scopeId:tenantId,config:{terms:['company confidential'],regexes:[],wholeWord:false,maxMatches:20},failureMode:'closed',sourceOrder:0};
}
function gateContext(input:{tenantId:string;userId:string;rules:readonly ResolvedRule[];text:string;pass:'preflight'|'postflight';evaluationId?:string;token?:string}):GateContext {
  const subject={tenantId:input.tenantId,userId:input.userId,groupIds:[],roles:['member'] as const};
  return {evaluationId:input.evaluationId??randomUUID(),requestId:randomUUID(),pass:input.pass,subject,conversationId:null,messageId:null,projectId:null,
    providerId:'openai',modelId:'model',locale:'en',nowMs:NOW,
    parts:[{id:'part',source:input.pass==='preflight'?'user_prompt':'provider_response',text:input.text,mimeType:'text/plain',fileId:null,provenance:{}}],
    policySnapshot:resolvePolicy({tenantId:input.tenantId,modelId:'test',subject,pass:input.pass,policyVersion:1,rules:input.rules,nowMs:NOW}),
    abortSignal:new AbortController().signal,confirmedWarningToken:input.token??null,metadata:{}};
}

interface Harness { deps:ConfirmRunDependencies; tenant:TenantContext; token:string; evaluationId:string; prepared:PreparedRun;
  database:Database.Database; calls:string[]; audited:{outcome:string;metadata:Readonly<Record<string,unknown>>}[]; sent:string[];
  decision:()=>{status:string;reviewed_by_user_id:string|null}; part:()=>{text_content:string|null;kind:string};
  changePolicy:(action:GateAction,revision?:number)=>void }

async function harness(options:{confirmedAction?:GateAction;policyChangedBeforeConfirmation?:boolean;resumable?:boolean;audit?:(database:Database.Database)=>AuditService}={}):Promise<Harness> {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),assistantId=randomUUID(),runId=randomUUID(),modelId=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Test','active',?,?)").run(tenantId,`t-${tenantId.slice(0,8)}`,NOW,NOW);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','x','active',?,?)").run(userId,tenantId,`u-${userId.slice(0,8)}@example.test`,NOW,NOW);
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)").run(conversationId,tenantId,userId,PLACEHOLDER,NOW,NOW);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,NULL,?,'user','complete',0,?)").run(messageId,tenantId,conversationId,userId,NOW);
  // The warned pass stored the gate's stand-in text, not what the user typed; the confirmed pass has to fix that.
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text',?,'{}',?)").run(randomUUID(),tenantId,messageId,PLACEHOLDER,NOW);

  const evaluationId=randomUUID();
  const warned=await engine.evaluate(gateContext({tenantId,userId,rules:[rule(tenantId,'warn')],text:OUTBOUND,pass:'preflight',evaluationId}));
  assert.equal(warned.disposition,'await_user_confirmation');assert.ok(warned.warningToken);
  database.prepare("INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,redacted_excerpt,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,'outbound','warn','awaiting_confirmation',?,?,?,?,3,0,?)")
    .run(evaluationId,tenantId,userId,conversationId,messageId,'a'.repeat(64),JSON.stringify(warned.matches.map(x=>x.ruleId)),JSON.stringify(warned.matches.map(x=>x.detectorKind)),warned.matches[0]?.safeExcerpt??null,NOW);

  const run:ChatRun={id:runId,conversationId,userMessageId:messageId,assistantMessageId:assistantId,status:'gating',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:new Date(NOW).toISOString()};
  const assistant:Message={id:assistantId,conversationId,parentMessageId:messageId,role:'assistant',content:'',modelId,provider:'openai',
    createdAt:new Date(NOW).toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};
  const prepared:PreparedRun={run,assistant,providerRequest:{runId},outboundText:OUTBOUND};
  const calls:string[]=[],sent:string[]=[],audited:{outcome:string;metadata:Readonly<Record<string,unknown>>}[]=[];
  let confirmedRules=[rule(tenantId,options.confirmedAction??'warn')];
  let acceptedFingerprint:string|null=null;

  const chat:WarnedRunPipeline={
    async authorizeWarnedRun(_tenant,id,confirmation){calls.push('authorize');acceptedFingerprint=confirmation.policyFingerprint;
      return options.resumable===false||id!==evaluationId?null:{...prepared,outboundText:confirmation.token?OUTBOUND:''};},
    policyFingerprint(){return warned.policyFingerprint;},
    // Stands in for the one thing the chat service must add: the run's confirmation reaching the gate
    // context, so the engine can turn an accepted `warn` into `allow_provider_call`.
    async gate(_tenant,input):Promise<ChatGateResult>{
      calls.push(`gate:${input.direction}`);
      const preflight=input.direction==='outbound';
      const context=gateContext({tenantId,userId,rules:preflight?confirmedRules:[],text:input.text,pass:preflight?'preflight':'postflight'});
      const verdict=await engine.evaluate({...context,confirmedWarningToken:preflight&&acceptedFingerprint===context.policySnapshot.fingerprint?token:null});
      return {decisionId:verdict.evaluationId,action:verdict.action,protectedItemCount:verdict.redactions.length+verdict.masks.length,message:'gate',
        effectiveText:(preflight?verdict.providerParts?.at(-1)?.text:verdict.displayParts?.[0]?.text)??'',
        ...(verdict.warningToken?{confirmationToken:verdict.warningToken}:{}),
        ...(verdict.approvalRequestId?{approvalId:verdict.approvalRequestId}:{})};
    },
    async reserveBudget(){calls.push('reserve');return {id:'reservation-1'};},
    async dispatchStarted(){calls.push('dispatch');},
    async *streamProvider(_tenant,_request,authorized){calls.push('stream');sent.push(authorized.effectiveText);
      yield {type:'text',text:'Roadmap noted.'};yield {type:'usage',inputTokens:9,outputTokens:3,costUsd:0.01};},
    async persistEvent(){},
    async complete(_tenant,_run,message,text){calls.push('complete');return {...message,content:text};},
    async fail(){calls.push('fail');},
    async audit(_tenant,_run,outcome,metadata){calls.push(`audit:${outcome}`);audited.push({outcome,metadata});},
    async getRun(){return run;},
    async *replay(){},
    async cancel(){return 'accepted';},
    async createRun(){throw new Error('a confirmed run must not fork a second run');},
  };
  const token=warned.warningToken;
  const currentFingerprint=gateContext({tenantId,userId,rules:confirmedRules,text:OUTBOUND,pass:'preflight'}).policySnapshot.fingerprint;
  const deps:ConfirmRunDependencies={database,chat,audit:(options.audit??((db:Database.Database)=>createAuditService(auditDeps(db))))(database),
    // Existing resume tests model a policy change after token verification; the dedicated regression
    // below changes it before verification and exercises the fingerprint refusal itself.
    warningSecret:SECRET,policyFingerprint:()=>options.policyChangedBeforeConfirmation?currentFingerprint:warned.policyFingerprint,now:()=>NOW};
  const tenant={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['member'],permissions:new Set(['chat:use'])},
    db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  return {deps,tenant,token,evaluationId,prepared,database,calls,audited,sent,
    decision:()=>database.prepare('SELECT status,reviewed_by_user_id FROM gate_decisions WHERE id=?').get(evaluationId) as {status:string;reviewed_by_user_id:string|null},
    part:()=>database.prepare('SELECT text_content,kind FROM message_parts WHERE message_id=?').get(messageId) as {text_content:string|null;kind:string},
    changePolicy:(action,revision=2)=>{confirmedRules=[{...rule(tenantId,action),revision}];}};
}
const collect=async(events:AsyncGenerator<StreamEvent>)=>{const out:StreamEvent[]=[];for await(const event of events)out.push(event);return out;};
const names=(events:readonly StreamEvent[])=>events.map(event=>event.event);

test('a confirmed warning resumes the run through the same pipeline instead of stopping it again',async()=>{
  const h=await harness();
  const begun=await beginWarningConfirmation(h.deps,h.tenant,h.token);
  assert.equal(begun.ok,true);
  const events=await collect(resumeConfirmedRun(h.deps,h.tenant,h.prepared,new AbortController().signal));
  assert.deepEqual(names(events),['run.created','run.status','run.status','message.created','assistant.delta','usage.summary','run.completed']);
  // Re-announcing the warn would reopen the dialog the user just dismissed.
  assert.ok(!events.some(event=>event.event==='gate.notice'),'an accepted warning must not be raised again');
  assert.deepEqual(h.calls,['authorize','gate:outbound','reserve','dispatch','stream','gate:inbound','gate:inbound','complete','audit:success']);
  assert.deepEqual(h.sent,[OUTBOUND],'the provider receives the text the gate authorized on the confirmed pass');
  const completed=events.at(-1);
  assert.equal(completed?.event==='run.completed'&&completed.data.message.content,'Roadmap noted.');
  assert.equal(completed?.event==='run.completed'&&completed.data.runId,h.prepared.run.id,'the confirmed run keeps its run id');
  h.database.close();
});

test('a security-relevant policy edit invalidates a pending warning before it claims the run',async()=>{
  const h=await harness({confirmedAction:'block',policyChangedBeforeConfirmation:true});
  const begun=await beginWarningConfirmation(h.deps,h.tenant,h.token);
  assert.deepEqual(begun.ok?null:{reason:begun.reason,status:begun.status},{reason:'policy_changed',status:409});
  assert.deepEqual(h.calls,[],'a stale warning must be rejected before the run or token is claimed');
  assert.equal(h.decision().status,'awaiting_confirmation');
  h.database.close();
});

test('a policy edit after confirmation begins cannot reuse consent on the resumed gate pass',async()=>{
  const h=await harness();
  assert.equal((await beginWarningConfirmation(h.deps,h.tenant,h.token)).ok,true);
  h.changePolicy('warn');
  const events=await collect(resumeConfirmedRun(h.deps,h.tenant,h.prepared,new AbortController().signal));
  assert.deepEqual(names(events),['run.created','run.status','gate.notice','run.status']);
  const notice=events[2];
  assert.equal(notice?.event==='gate.notice'&&notice.data.action,'warn');
  assert.ok(notice?.event==='gate.notice'&&notice.data.confirmationToken,'the changed snapshot must mint a fresh confirmation');
  const last=events.at(-1);
  assert.equal(last?.event==='run.status'&&last.data.status,'awaiting_confirmation');
  assert.deepEqual(h.calls,['authorize','gate:outbound']);
  assert.deepEqual(h.sent,[],'stale consent must not reach a provider');
  h.database.close();
});

test('a block on the confirmed pass still stops the run',async()=>{
  const h=await harness({confirmedAction:'block'});
  assert.equal((await beginWarningConfirmation(h.deps,h.tenant,h.token)).ok,true);
  const events=await collect(resumeConfirmedRun(h.deps,h.tenant,h.prepared,new AbortController().signal));
  assert.deepEqual(names(events),['run.created','run.status','gate.notice','run.failed']);
  assert.deepEqual(h.calls,['authorize','gate:outbound','fail','audit:denied']);
  assert.equal(h.part().text_content,PLACEHOLDER,'a blocked confirmation must not write the outbound text');
  h.database.close();
});

test('an inbound block after Send anyway ends as non-retryable GATE_BLOCKED',async()=>{
  const h=await harness();
  assert.equal((await beginWarningConfirmation(h.deps,h.tenant,h.token)).ok,true);
  const originalGate=h.deps.chat.gate.bind(h.deps.chat);
  Object.assign(h.deps.chat,{async gate(tenant:TenantContext,input:{direction:'outbound'|'inbound'|'file';text:string;runId:string},signal:AbortSignal):Promise<ChatGateResult>{
    if(input.direction!=='inbound')return originalGate(tenant,input,signal);
    return{decisionId:'inbound-block',action:'block',direction:'inbound',protectedItemCount:0,effectiveText:'',message:'SERVER-TEXT-SENTINEL'};
  }});
  const events=await collect(resumeConfirmedRun(h.deps,h.tenant,h.prepared,new AbortController().signal)),failure=events.at(-1);
  assert.equal(failure?.event,'run.failed');
  if(failure?.event==='run.failed')assert.deepEqual({code:failure.data.error.code,retryable:failure.data.error.retryable},{code:'GATE_BLOCKED',retryable:false});
  h.database.close();
});

test('a rule that now needs an approver still stops the run',async()=>{
  const h=await harness({confirmedAction:'require_approval'});
  assert.equal((await beginWarningConfirmation(h.deps,h.tenant,h.token)).ok,true);
  const events=await collect(resumeConfirmedRun(h.deps,h.tenant,h.prepared,new AbortController().signal));
  assert.deepEqual(names(events),['run.created','run.status','gate.notice','run.status']);
  const last=events.at(-1);
  assert.equal(last?.event==='run.status'&&last.data.status,'awaiting_approval');
  assert.deepEqual(h.calls,['authorize','gate:outbound']);
  h.database.close();
});

test('the override lands in the audit log with the rule and detector that fired',async()=>{
  const h=await harness();
  await beginWarningConfirmation(h.deps,h.tenant,h.token);
  const event=h.database.prepare("SELECT action,outcome,gate_action,detector,message_id,conversation_id,actor_id,metadata_json FROM audit_events WHERE action='gate.warning_confirmed'")
    .get() as {action:string;outcome:string;gate_action:string;detector:string;message_id:string;actor_id:string;metadata_json:string};
  assert.equal(event.outcome,'success');assert.equal(event.gate_action,'warn');assert.equal(event.detector,'keyword');
  assert.equal(event.actor_id,h.tenant.principal.userId);assert.equal(event.message_id,h.prepared.run.userMessageId);
  assert.deepEqual(JSON.parse(event.metadata_json) as Record<string,unknown>,
    {evaluationId:h.evaluationId,runId:h.prepared.run.id,ruleIds:['rule-sensitive-terms'],detectors:['keyword']});
  h.database.close();
});

test('a confirmation is spent once, and a run that cannot be resumed does not spend it',async()=>{
  const h=await harness();
  assert.equal((await beginWarningConfirmation(h.deps,h.tenant,h.token)).ok,true);
  assert.equal(h.decision().status,'approved');
  const replay=await beginWarningConfirmation(h.deps,h.tenant,h.token);
  assert.deepEqual(replay.ok?null:{reason:replay.reason,status:replay.status},{reason:'already_confirmed',status:409});
  h.database.close();

  const gone=await harness({resumable:false});
  const refused=await beginWarningConfirmation(gone.deps,gone.tenant,gone.token);
  assert.deepEqual(refused.ok?null:{reason:refused.reason,status:refused.status},{reason:'run_expired',status:409});
  // Burning the token here would leave an audited override for a send that never happened, and no
  // way for the user to get the message out.
  assert.equal(gone.decision().status,'awaiting_confirmation');
  assert.equal((gone.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='gate.warning_confirmed'").get() as {n:number}).n,0);
  gone.database.close();
});

test('an override that cannot be audited is not granted',async()=>{
  const broken=(database:Database.Database)=>({append(){throw new Error('unused');},enqueue(){},
    transact:<T>(work:(tx:{append:()=>never})=>T):T=>database.transaction(()=>work({append:()=>{throw new Error('audit chain unavailable');}})).immediate(),
  } as unknown as AuditService);
  const h=await harness({audit:broken});
  await assert.rejects(()=>beginWarningConfirmation(h.deps,h.tenant,h.token),/audit chain unavailable/);
  assert.equal(h.decision().status,'awaiting_confirmation','the claim must roll back with the audit append');
  h.database.close();
});
