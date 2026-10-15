import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { startAuditWorkers } from '../audit/workers.js';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { provisionTestTenant } from '../../test/tenant-fixture.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import type { TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { ChatProvider, ChatRequest, ProviderId, Usage } from '../../lib/providers/types.js';
import type { ChatInput, StreamEvent } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { recoverInterruptedSingleModelRuns, SINGLE_MODEL_RECOVERY_GRACE_MS } from './single-model-recovery.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,7,10,18);
const PROVIDERS=['openai','anthropic','google','xai'] as const;
type Source='platform'|'byok';

function gate():GateEngine {
  return{
    async evaluate(context:GateContext):Promise<GateVerdict>{
      const content=context.parts.map(part=>part.text).join('\n'),approval=context.pass==='preflight'&&content.includes('[approval]'),warning=context.pass==='preflight'&&content.includes('[warning]'),warningRule=context.policySnapshot.rules[0];
      return{evaluationId:context.evaluationId,pass:context.pass,action:approval?'require_approval':warning?'warn':'allow',
        disposition:approval?'pending_approval':warning?'await_user_confirmation':context.pass==='preflight'?'allow_provider_call':'release_to_user',matches:warning?[{matchId:randomUUID(),detectorId:'recovery-warning',detectorKind:'keyword',ruleId:warningRule?.id??'recovery-warning-rule',ruleRevision:warningRule?.revision??1,partId:context.parts.at(-1)!.id,category:'warning',action:'warn',confidence:'high',span:null,normalizedFingerprint:'warning',safeExcerpt:'[WARNING]',replacementLabel:null,metadata:{}}]:[],
        providerParts:context.pass==='preflight'&&!approval&&!warning?context.parts:null,displayParts:context.pass==='postflight'?context.parts:null,redactions:[],masks:[],
        warningToken:warning?'durable-warning-token':null,approvalRequestId:approval?randomUUID():null,policySnapshotId:context.policySnapshot.snapshotId,
        policyFingerprint:context.policySnapshot.fingerprint,degraded:false,failureCodes:[],timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};
    },
    createPostflightStream(){throw new Error('not used');},
  };
}

interface Fixture {
  database:Database.Database;
  audit:ReturnType<typeof createAuditService>;
  app:GovernedChatApplication;
  tenantA:TenantContext;
  tenantB:TenantContext;
  calls:{count:number};
  sources:Map<string,Source>;
  restart():GovernedChatApplication;
}

function fixture():Fixture {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW});
  const a=provisionTestTenant(database,{email:'owner@single-a.example',name:'Single A',now:NOW});
  const b=provisionTestTenant(database,{email:'owner@single-b.example',name:'Single B',now:NOW});
  const context=(workspace:typeof a):TenantContext=>{const tenantId=workspace.tenantId as TenantId;return{principal:{tenantId,userId:workspace.ownerUserId,membershipId:workspace.ownerUserId,
    sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;};
  const tenantA=context(a),tenantB=context(b),calls={count:0},sources=new Map<string,Source>([[tenantA.principal.tenantId,'platform'],[tenantB.principal.tenantId,'byok']]);
  const providers=new Map<ProviderId,ChatProvider>(PROVIDERS.map(id=>[id,{
    id,protocols:['openai_responses','openai_chat_completions','anthropic_messages','google_generate_content'],configured:true,supports:()=>true,
    health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),async *stream(request:ChatRequest){calls.count++;const usage:Usage={inputTokens:20,outputTokens:5,reasoningTokens:0,cachedInputTokens:0,
      cacheWriteTokens:0,toolInputTokens:0,totalTokens:25,estimated:false,source:'provider'};yield{type:'start',requestId:`request-${calls.count}`,providerRequestId:`provider-${calls.count}`,model:request.model,createdAt:NOW};
      yield{type:'text_delta',index:0,delta:'Recovered answer.'};yield{type:'usage',usage};yield{type:'finish',reason:'stop'};},
  } as ChatProvider]));
  const restart=()=>new GovernedChatApplication({database,gate:gate(),providers:{get(id){const provider=providers.get(id);if(!provider)throw new Error(`Missing ${id}`);return provider;}},
    tenantProviders:{resolve(tenantId,id){const provider=providers.get(id);if(!provider)throw new Error(`Missing ${id}`);return{provider,credentialSource:sources.get(tenantId)??'platform'};}},
    audit,approvalPayloadKey:Buffer.alloc(32,3),now:()=>NOW});
  const app=restart();return{database,audit,app,tenantA,tenantB,calls,sources,restart};
}

function input(content:string):ChatInput{return{content,mode:'auto',reasoningEffort:'medium',clientRequestId:randomUUID()};}
function claim(key:string,hash:string){return{key,requestHash:hash.repeat(64).slice(0,64),method:'POST',path:'/chat/runs'};}
async function prepare(f:Fixture,tenant:TenantContext,body:ChatInput,key:string,hash:string){
  const prepared=await f.app.createRun(tenant,body,'create',claim(key,hash));
  const preflight=await f.app.gate(tenant,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
  const reservation=await f.app.reserveBudget(tenant,prepared.run);return{prepared,preflight,reservation};
}
async function events(app:GovernedChatApplication,tenant:TenantContext,runId:string):Promise<StreamEvent[]> {
  const result:StreamEvent[]=[];for await(const item of app.replay(tenant,runId,0,new AbortController().signal))result.push(item.event);return result;
}

test('a confirmed multi-model run keeps its routing mode when it re-enters the pipeline',async()=>{
  const f=fixture(),body={...input('[warning] multi confirm mode'),mode:'multi_model' as const};
  try{
    const prepared=await f.app.createRun(f.tenantB,body,'create',claim('multi-confirm-mode','9'));
    const warning=await f.app.gate(f.tenantB,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
    assert.equal(warning.action,'warn');assert.ok(warning.confirmationToken);
    const confirmed=await f.app.authorizeWarnedRun(f.tenantB,warning.decisionId,{token:warning.confirmationToken,policyFingerprint:f.app.policyFingerprint(f.tenantB)});
    assert.equal(confirmed?.mode,'multi_model');
  }finally{f.app.stop();f.database.close();}
});

test('startup recovery terminalizes a pre-gate claim without stealing durable approval or warning waits',async()=>{
  const f=fixture(),ordinary=input('pre-gate crash'),approval=input('[approval] queued review'),warning=input('[warning] confirm first');
  const abandoned=await f.app.createRun(f.tenantA,ordinary,'create',claim('pre-gate','a'));
  const multiBefore={...input('multi crash before gate'),mode:'multi_model' as const};
  const abandonedMultiBefore=await f.app.createRun(f.tenantA,multiBefore,'create',claim('multi-before-gate','2'));
  const multiAfter={...input('multi crash after gate'),mode:'multi_model' as const};
  const abandonedMultiAfter=await f.app.createRun(f.tenantA,multiAfter,'create',claim('multi-after-gate','3'));
  await f.app.gate(f.tenantA,{direction:'outbound',text:abandonedMultiAfter.outboundText,runId:abandonedMultiAfter.run.id},new AbortController().signal);
  const pendingApproval=await f.app.createRun(f.tenantB,approval,'create',claim('held-approval','b'));
  await f.app.gate(f.tenantB,{direction:'outbound',text:pendingApproval.outboundText,runId:pendingApproval.run.id},new AbortController().signal);
  const heldWarning=await f.app.createRun(f.tenantB,warning,'create',claim('held-warning','c'));
  await f.app.gate(f.tenantB,{direction:'outbound',text:heldWarning.outboundText,runId:heldWarning.run.id},new AbortController().signal);
  const multiWarning={...input('[warning] multi confirm first'),mode:'multi_model' as const};
  const heldMultiWarning=await f.app.createRun(f.tenantB,multiWarning,'create',claim('held-multi-warning','4'));
  await f.app.gate(f.tenantB,{direction:'outbound',text:heldMultiWarning.outboundText,runId:heldMultiWarning.run.id},new AbortController().signal);

  assert.deepEqual(recoverInterruptedSingleModelRuns(f.database,{now:NOW,workerId:'startup',recoverAll:true}),
    {recovered:3,completed:0,cancelled:3,indeterminate:0,observedProviderCostMicrousd:0});
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM messages WHERE tenant_id=? AND id=?').pluck().get(f.tenantA.principal.tenantId,abandoned.assistant.id),0,'pre-gate recovery must not fabricate message rows');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM multi_model_workflows WHERE run_id IN (?,?)').pluck().get(abandonedMultiBefore.run.id,abandonedMultiAfter.run.id),0);
  assert.deepEqual(f.database.prepare("SELECT status FROM routing_decisions WHERE run_id IN (?,?) ORDER BY run_id").pluck().all(abandonedMultiBefore.run.id,abandonedMultiAfter.run.id),['cancelled','cancelled']);
  assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(abandonedMultiAfter.assistant.id),{status:'stopped',error_code:'CHAT_RECOVERY_PREDISPATCH'});
  assert.deepEqual(f.database.prepare('SELECT status,response_json IS NOT NULL saved FROM idempotency_records WHERE run_id IN (?,?) ORDER BY run_id').all(pendingApproval.run.id,heldWarning.run.id),
    [pendingApproval.run.id,heldWarning.run.id].sort().map(id=>({status:'claimed',saved:1})));
  assert.equal(f.database.prepare('SELECT status FROM policy_approval_requests WHERE tenant_id=? AND requesting_user_id=? ORDER BY created_at_ms DESC').pluck().get(f.tenantB.principal.tenantId,f.tenantB.principal.userId),'pending');
  assert.equal(f.database.prepare("SELECT status FROM gate_decisions WHERE tenant_id=? AND message_id=? AND final_action='warn'").pluck().get(f.tenantB.principal.tenantId,heldWarning.run.userMessageId),'awaiting_confirmation');
  assert.equal(f.database.prepare("SELECT status FROM gate_decisions WHERE tenant_id=? AND message_id=? AND final_action='warn'").pluck().get(f.tenantB.principal.tenantId,heldMultiWarning.run.userMessageId),'awaiting_confirmation');
  assert.deepEqual(recoverInterruptedSingleModelRuns(f.database,{now:NOW+1,workerId:'again',recoverAll:true}),
    {recovered:0,completed:0,cancelled:0,indeterminate:0,observedProviderCostMicrousd:0});

  f.app.stop();const restarted=f.restart(),replayed=await restarted.createRun(f.tenantA,ordinary,'create',claim('pre-gate','a'));
  assert.equal(replayed.replay,true);assert.deepEqual(Object.keys(replayed).filter(key=>key==='run'||key==='assistant').sort(),['assistant','run']);
  assert.equal((await restarted.getRun(f.tenantA,abandoned.run.id))?.status,'cancelled');
  assert.equal((await events(restarted,f.tenantA,abandoned.run.id)).at(-1)?.event,'run.cancelled');
  assert.equal(await restarted.cancel(f.tenantA,abandoned.run.id),'terminal');
  assert.equal(await restarted.getRun(f.tenantB,abandoned.run.id),null);assert.equal(await restarted.cancel(f.tenantB,abandoned.run.id),'missing');
  assert.equal((await restarted.getRun(f.tenantB,pendingApproval.run.id))?.status,'awaiting_approval');
  assert.equal((await restarted.getRun(f.tenantB,heldWarning.run.id))?.status,'awaiting_confirmation');assert.equal(f.calls.count,0);
  for(const [body,key,hash,runId] of [[multiBefore,'multi-before-gate','2',abandonedMultiBefore.run.id],[multiAfter,'multi-after-gate','3',abandonedMultiAfter.run.id]] as const){
    const replay=await restarted.createRun(f.tenantA,body,'create',claim(key,hash));assert.equal(replay.replay,true);assert.equal(replay.run.status,'cancelled');
    assert.equal((await events(restarted,f.tenantA,runId)).at(-1)?.event,'run.cancelled');
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE message_id IN (?,?)').pluck().get(abandonedMultiBefore.assistant.id,abandonedMultiAfter.assistant.id),0);
  restarted.stop();f.database.close();
});

test('periodic recovery respects a live reservation heartbeat and startup later cancels predispatch work',async()=>{
  const f=fixture(),body=input('reserved but not dispatched'),prepared=await prepare(f,f.tenantA,body,'predispatch','d');
  await f.app.heartbeatReservation(f.tenantA,prepared.prepared.run,prepared.reservation);
  const later=NOW+SINGLE_MODEL_RECOVERY_GRACE_MS+1;
  f.database.prepare("UPDATE budget_reservations SET expires_at=?,metadata_json=json_set(metadata_json,'$.expiresAt',?) WHERE id=?").run(later+SINGLE_MODEL_RECOVERY_GRACE_MS,later+SINGLE_MODEL_RECOVERY_GRACE_MS,prepared.reservation.id);
  assert.equal(recoverInterruptedSingleModelRuns(f.database,{now:later,workerId:'periodic'}).recovered,0,'periodic recovery must not steal a heartbeat-protected run');
  f.app.stop();const workers=startAuditWorkers({database:f.database,audit:f.audit,blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{}},now:()=>later,
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:later}),logger:{error(){},info(){}}});
  assert.deepEqual(f.database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(prepared.prepared.assistant.id),{status:'stopped',error_code:'CHAT_RECOVERY_PREDISPATCH'});
  assert.equal(f.database.prepare('SELECT status FROM routing_decisions WHERE run_id=?').pluck().get(prepared.prepared.run.id),'cancelled');
  assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(prepared.reservation.id),'released');
  assert.equal(f.calls.count,0);await workers.stop();f.database.close();
});

test('postdispatch recovery never resends, retains only durable usage, and restores platform versus BYOK billing',async()=>{
  const f=fixture();
  const ambiguous=await prepare(f,f.tenantA,input('ambiguous provider boundary'),'ambiguous','e');
  await f.app.dispatchStarted(f.tenantA,ambiguous.prepared.run,ambiguous.reservation);
  assert.equal(recoverInterruptedSingleModelRuns(f.database,{now:NOW,workerId:'startup-ambiguous',recoverAll:true}).indeterminate,1);
  assert.equal(f.calls.count,0);assert.equal(f.database.prepare('SELECT COUNT(*) FROM usage_records WHERE message_id=?').pluck().get(ambiguous.prepared.assistant.id),0);
  assert.equal(f.database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(ambiguous.reservation.id),'released');

  const completed:Array<{tenant:TenantContext;body:ChatInput;key:string;hash:string;runId:string;messageId:string}>=[];
  const cases=[
    {tenant:f.tenantA,key:'platform-checkpoint',hash:'f',dropCheckpoint:false,historicalCharge:null},
    {tenant:f.tenantB,key:'byok-checkpoint',hash:'1',dropCheckpoint:false,historicalCharge:null},
    {tenant:f.tenantA,key:'legacy-unknown-null',hash:'5',dropCheckpoint:true,historicalCharge:null},
    {tenant:f.tenantA,key:'legacy-unknown-history',hash:'6',dropCheckpoint:true,historicalCharge:73},
  ] as const;
  for(const {tenant,key,hash,dropCheckpoint,historicalCharge} of cases){
    const body=input(`durable ${key}`),item=await prepare(f,tenant,body,key,hash);await f.app.dispatchStarted(tenant,item.prepared.run,item.reservation);
    let text='',usage:{inputTokens:number;outputTokens:number;costUsd:number}|null=null;
    for await(const chunk of f.app.streamProvider(tenant,item.prepared.providerRequest,{preflightDecisionId:item.preflight.decisionId,reservationId:item.reservation.id,effectiveText:item.preflight.effectiveText},new AbortController().signal)){
      if(chunk.type==='text')text+=chunk.text;else if(chunk.type==='usage')usage=chunk;
    }
    assert.ok(usage);await f.app.complete(tenant,item.prepared.run,item.prepared.assistant,text,{...usage,totalTokens:usage.inputTokens+usage.outputTokens,
      modelId:item.prepared.assistant.modelId!,provider:item.prepared.assistant.provider!,budgetWarnings:[]},item.reservation);
    const usageRow=f.database.prepare('SELECT id,input_tokens,output_tokens,customer_charge_microusd FROM usage_records WHERE tenant_id=? AND message_id=?').get(tenant.principal.tenantId,item.prepared.assistant.id) as {id:string;input_tokens:number;output_tokens:number;customer_charge_microusd:number};
    f.database.prepare("UPDATE usage_records SET provider_cost_microusd=NULL,customer_charge_microusd=?,credential_source='legacy_unknown',baseline_cost_microusd=NULL,savings_microusd=NULL,platform_model_version_id=NULL,routing_decision_id=NULL WHERE id=?").run(historicalCharge,usageRow.id);
    if(dropCheckpoint)f.database.prepare("UPDATE budget_reservations SET metadata_json=json_remove(metadata_json,'$.credentialSource') WHERE id=?").run(item.reservation.id);
    f.database.prepare("UPDATE messages SET status='complete',input_tokens=?,output_tokens=?,cost_microusd=?,completed_at=? WHERE tenant_id=? AND id=?").run(usageRow.input_tokens,usageRow.output_tokens,usageRow.customer_charge_microusd,NOW,tenant.principal.tenantId,item.prepared.assistant.id);
    f.database.prepare("UPDATE message_parts SET text_content=?,kind='text' WHERE tenant_id=? AND message_id=? AND ordinal=0").run(text,tenant.principal.tenantId,item.prepared.assistant.id);
    f.database.prepare('DELETE FROM routing_decisions WHERE tenant_id=? AND run_id=?').run(tenant.principal.tenantId,item.prepared.run.id);
    completed.push({tenant,body,key,hash,runId:item.prepared.run.id,messageId:item.prepared.assistant.id});
  }
  const recovered=recoverInterruptedSingleModelRuns(f.database,{now:NOW+1,workerId:'startup-billed',recoverAll:true});
  assert.deepEqual({recovered:recovered.recovered,completed:recovered.completed,indeterminate:recovered.indeterminate},{recovered:4,completed:4,indeterminate:0});assert.equal(f.calls.count,4);
  const platform=f.database.prepare('SELECT provider_cost_microusd,customer_charge_microusd,credential_source FROM usage_records WHERE tenant_id=? AND message_id=?').get(f.tenantA.principal.tenantId,completed[0]!.messageId) as {provider_cost_microusd:number;customer_charge_microusd:number;credential_source:string};
  const byok=f.database.prepare('SELECT provider_cost_microusd,customer_charge_microusd,credential_source FROM usage_records WHERE tenant_id=? AND message_id=?').get(f.tenantB.principal.tenantId,completed[1]!.messageId) as typeof platform;
  assert.equal(platform.credential_source,'platform');assert.equal(platform.customer_charge_microusd,0);
  assert.equal(byok.credential_source,'byok');assert.equal(byok.customer_charge_microusd,0);
  const unknownNull=f.database.prepare('SELECT customer_charge_microusd,credential_source,savings_microusd FROM usage_records WHERE tenant_id=? AND message_id=?').get(f.tenantA.principal.tenantId,completed[2]!.messageId);
  const unknownHistorical=f.database.prepare('SELECT customer_charge_microusd,credential_source,savings_microusd FROM usage_records WHERE tenant_id=? AND message_id=?').get(f.tenantA.principal.tenantId,completed[3]!.messageId);
  assert.deepEqual(unknownNull,{customer_charge_microusd:0,credential_source:'legacy_unknown',savings_microusd:null});
  assert.deepEqual(unknownHistorical,{customer_charge_microusd:73,credential_source:'legacy_unknown',savings_microusd:null});
  assert.equal(recoverInterruptedSingleModelRuns(f.database,{now:NOW+2,workerId:'again',recoverAll:true}).recovered,0);assert.equal(f.calls.count,4);
  f.app.stop();const restarted=f.restart();for(const item of completed){const replay=await restarted.createRun(item.tenant,item.body,'create',claim(item.key,item.hash));assert.equal(replay.replay,true);
    assert.equal((await restarted.getRun(item.tenant,item.runId))?.status,'completed');assert.equal((await events(restarted,item.tenant,item.runId)).at(-1)?.event,'run.completed');assert.equal(await restarted.cancel(item.tenant,item.runId),'terminal');}
  assert.equal((await restarted.getRun(f.tenantA,ambiguous.prepared.run.id))?.status,'failed');assert.equal((await events(restarted,f.tenantA,ambiguous.prepared.run.id)).at(-1)?.event,'run.failed');
  assert.equal(f.calls.count,4);restarted.stop();f.database.close();
});

test('legacy unknown recovery preserves a historical charge and otherwise closes billing at zero',async()=>{
  const f=fixture(),completed:Array<{messageId:string;historicalCharge:number|null;historicalSavings:number|null}>=[];
  for(const [key,hash,historicalCharge,historicalSavings] of [
    ['legacy-unknown-zero','7',null,null],
    ['legacy-unknown-history','8',73,11],
  ] as const){
    const item=await prepare(f,f.tenantA,input(`durable ${key}`),key,hash);await f.app.dispatchStarted(f.tenantA,item.prepared.run,item.reservation);
    let text='',usage:{inputTokens:number;outputTokens:number;costUsd:number}|null=null;
    for await(const chunk of f.app.streamProvider(f.tenantA,item.prepared.providerRequest,{preflightDecisionId:item.preflight.decisionId,
      reservationId:item.reservation.id,effectiveText:item.preflight.effectiveText},new AbortController().signal)){
      if(chunk.type==='text')text+=chunk.text;else if(chunk.type==='usage')usage=chunk;
    }
    assert.ok(usage);await f.app.complete(f.tenantA,item.prepared.run,item.prepared.assistant,text,{...usage,totalTokens:usage.inputTokens+usage.outputTokens,
      modelId:item.prepared.assistant.modelId!,provider:item.prepared.assistant.provider!,budgetWarnings:[]},item.reservation);
    const row=f.database.prepare('SELECT id,input_tokens,output_tokens FROM usage_records WHERE tenant_id=? AND message_id=?')
      .get(f.tenantA.principal.tenantId,item.prepared.assistant.id) as {id:string;input_tokens:number;output_tokens:number};
    f.database.prepare("UPDATE budget_reservations SET metadata_json=json_remove(metadata_json,'$.credentialSource') WHERE id=?").run(item.reservation.id);
    f.database.prepare("UPDATE usage_records SET customer_charge_microusd=?,credential_source='legacy_unknown',baseline_cost_microusd=NULL,savings_microusd=?,platform_model_version_id=NULL,routing_decision_id=NULL WHERE id=?")
      .run(historicalCharge,historicalSavings,row.id);
    f.database.prepare("UPDATE messages SET status='complete',input_tokens=?,output_tokens=?,cost_microusd=?,completed_at=? WHERE tenant_id=? AND id=?")
      .run(row.input_tokens,row.output_tokens,historicalCharge,NOW,f.tenantA.principal.tenantId,item.prepared.assistant.id);
    f.database.prepare("UPDATE message_parts SET text_content=?,kind='text' WHERE tenant_id=? AND message_id=? AND ordinal=0")
      .run(text,f.tenantA.principal.tenantId,item.prepared.assistant.id);
    f.database.prepare('DELETE FROM routing_decisions WHERE tenant_id=? AND run_id=?').run(f.tenantA.principal.tenantId,item.prepared.run.id);
    completed.push({messageId:item.prepared.assistant.id,historicalCharge,historicalSavings});
  }
  const recovered=recoverInterruptedSingleModelRuns(f.database,{now:NOW+1,workerId:'legacy-unknown',recoverAll:true});
  assert.deepEqual({recovered:recovered.recovered,completed:recovered.completed},{recovered:2,completed:2});
  for(const item of completed){
    assert.deepEqual(f.database.prepare('SELECT customer_charge_microusd,credential_source,savings_microusd FROM usage_records WHERE tenant_id=? AND message_id=?')
      .get(f.tenantA.principal.tenantId,item.messageId),{customer_charge_microusd:item.historicalCharge??0,credential_source:'legacy_unknown',savings_microusd:item.historicalSavings});
  }
  assert.equal(f.calls.count,2);f.app.stop();f.database.close();
});
