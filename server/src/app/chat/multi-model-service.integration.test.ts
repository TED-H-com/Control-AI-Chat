import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { provisionTestTenant } from '../../test/tenant-fixture.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import { estimateModelCostMicrousd } from '../../lib/governance/index.js';
import type { TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { ChatProvider, ChatRequest, ProviderId, Usage } from '../../lib/providers/types.js';
import type { TenantId } from '../../shared/types.js';
import type { ProviderChunk } from '../../routes/chat.js';
import { recoverInterruptedMultiModelWorkflows } from './multi-model-recovery.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,7,10,16);
const FINAL_ANSWER='Consolidated final answer.';
const STEPS=['draft','critique','alternative','refine','consolidate'] as const;

interface ProviderCall {
  readonly provider:ProviderId;
  readonly model:string;
  readonly ordinal:number;
  readonly step:string;
  readonly prompt:string;
}

function allowGate(inbound:string[]):GateEngine {
  return {
    async evaluate(context:GateContext):Promise<GateVerdict>{
      if(context.pass==='postflight')inbound.push(context.parts.map(part=>part.text).join(''));
      return {
        evaluationId:context.evaluationId,
        pass:context.pass,
        action:'allow',
        disposition:context.pass==='preflight'?'allow_provider_call':'release_to_user',
        matches:[],
        providerParts:context.pass==='preflight'?context.parts:null,
        displayParts:context.pass==='postflight'?context.parts:null,
        redactions:[],masks:[],
        warningToken:null,
        approvalRequestId:null,
        policySnapshotId:context.policySnapshot.snapshotId,
        policyFingerprint:context.policySnapshot.fingerprint,
        degraded:false,
        failureCodes:[],
        timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1},
      };
    },
    createPostflightStream(){throw new Error('The service integration uses complete postflight evaluations');},
  };
}

function fakeProvider(id:ProviderId,calls:ProviderCall[]):ChatProvider {
  return {
    id,
    protocols:['openai_responses','openai_chat_completions','anthropic_messages','google_generate_content'],
    configured:true,
    supports:()=>true,
    health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),
    async *stream(request:ChatRequest){
      const ordinal=Number(request.metadata.multiModelOrdinal),step=request.metadata.multiModelStep??'';
      calls.push({provider:id,model:request.model,ordinal,step,prompt:request.messages.at(-1)?.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')??''});
      const text=step==='consolidate'?FINAL_ANSWER:`Internal ${step} answer from ${id}.`;
      const usage:Usage={inputTokens:1_000,outputTokens:100,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:1_100,estimated:false,source:'provider'};
      yield{type:'start',requestId:`request-${ordinal}`,providerRequestId:`${id}-${ordinal}`,model:request.model,createdAt:NOW};
      yield{type:'text_delta',index:0,delta:text};
      yield{type:'usage',usage};
      yield{type:'finish',reason:'stop'};
    },
  };
}

test('multi-model chat persists five governed platform executions and releases only the consolidated answer',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const audit=createAuditService({
    database,
    ipHmacKey:Buffer.alloc(32,1),
    transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),
    now:()=>NOW,
  });
  const workspace=provisionTestTenant(database,{email:'owner@roundtable.example',name:'Roundtable',now:NOW});
  database.prepare("UPDATE provider_config SET enabled=0,credential_ciphertext=NULL,key_version=NULL WHERE tenant_id=? AND provider_key NOT IN ('openai','anthropic','google','xai')").run(workspace.tenantId);
  const tenantId=workspace.tenantId as TenantId,tenantDb=forTenant({tenantId});
  const unpinnedCandidate=database.prepare("SELECT id FROM model_catalog WHERE tenant_id=? AND multi_model_eligible=1 ORDER BY id LIMIT 1").pluck().get(tenantId) as string;
  database.prepare('UPDATE model_catalog SET platform_model_version_id=NULL WHERE tenant_id=? AND id=?').run(tenantId,unpinnedCandidate);
  const tenant={
    principal:{tenantId,userId:workspace.ownerUserId,membershipId:workspace.ownerUserId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},
    db:tenantDb,
    requestId:randomUUID(),
    now:new Date(NOW),
  } as TenantContext;
  const calls:ProviderCall[]=[],inbound:string[]=[];
  const providers=new Map<ProviderId,ChatProvider>(['openai','anthropic','google','xai'].map(id=>[id as ProviderId,fakeProvider(id as ProviderId,calls)]));
  const app=new GovernedChatApplication({
    database,
    gate:allowGate(inbound),
    providers:{get(id){const provider=providers.get(id);if(!provider)throw new Error(`Unexpected provider ${id}`);return provider;}},
    audit,
    approvalPayloadKey:Buffer.alloc(32,3),
    multiModelResultKey:Buffer.alloc(32,4),
    now:()=>NOW,
  });

  try{
    const prepared=await app.createRun(tenant,{content:'Compare the safest rollout approaches.',mode:'multi_model',reasoningEffort:'high',clientRequestId:randomUUID()},'create',{
      key:'multi-model-full-flow',requestHash:'a'.repeat(64),method:'POST',path:'/chat/runs',
    });
    const preflight=await app.gate(tenant,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal);
    assert.equal(preflight.action,'allow');
    const reservation=await app.reserveBudget(tenant,prepared.run);
    await app.dispatchStarted(tenant,prepared.run,reservation);

    const chunks:ProviderChunk[]=[];
    for await(const chunk of app.streamProvider(tenant,prepared.providerRequest,{preflightDecisionId:preflight.decisionId,reservationId:reservation.id,effectiveText:preflight.effectiveText},new AbortController().signal))chunks.push(chunk);
    const textChunks=chunks.filter((chunk):chunk is Extract<ProviderChunk,{type:'text'}>=>chunk.type==='text');
    const usage=chunks.find((chunk):chunk is Extract<ProviderChunk,{type:'usage'}>=>chunk.type==='usage');
    assert.deepEqual(textChunks.map(chunk=>chunk.text),[FINAL_ANSWER],'draft, critique, alternative, and refine must remain internal');
    assert.ok(usage,'multi-model streaming must publish aggregate usage');
    assert.equal(usage.inputTokens,5_000);assert.equal(usage.outputTokens,500);

    const completed=await app.complete(tenant,prepared.run,prepared.assistant,FINAL_ANSWER,{
      inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.inputTokens+usage.outputTokens,costUsd:usage.costUsd,
      modelId:prepared.assistant.modelId!,provider:prepared.assistant.provider!,budgetWarnings:[],
    },reservation);
    await app.audit(tenant,prepared.run,'success',{mode:'multi_model'});
    assert.equal(completed.content,FINAL_ANSWER);

    assert.equal(calls.length,5);
    assert.deepEqual(calls.map(call=>call.ordinal),[1,2,3,4,5]);
    assert.deepEqual(calls.map(call=>call.step),STEPS);
    assert.ok(new Set(calls.map(call=>call.provider)).size>=2,'five rounds must use at least two provider families');
    assert.deepEqual(inbound,calls.map(call=>call.step==='consolidate'?FINAL_ANSWER:`Internal ${call.step} answer from ${call.provider}.`),'every intermediate result must pass the normal inbound gate');

    const route=tenantDb.get(database.prepare(`SELECT id,status,mode,completed_at_ms,selected_model_catalog_id,selected_platform_model_version_id,selected_provider,vendor_jurisdiction_constraint,processing_region_constraint,route_reason_json
      FROM routing_decisions WHERE tenant_id=? AND run_id=?`),prepared.run.id) as {id:string;status:string;mode:string;completed_at_ms:number|null;selected_model_catalog_id:string|null;selected_platform_model_version_id:string|null;selected_provider:string|null;vendor_jurisdiction_constraint:string;processing_region_constraint:string;route_reason_json:string}|undefined;
    assert.ok(route);assert.equal(route.status,'completed');assert.equal(route.mode,'multi_model');assert.equal(route.completed_at_ms,NOW);
    assert.equal(route.selected_model_catalog_id,null);assert.equal(route.selected_platform_model_version_id,null);assert.equal(route.selected_provider,null);
    assert.equal(route.vendor_jurisdiction_constraint,'any');assert.equal(route.processing_region_constraint,'any');assert.ok(JSON.parse(route.route_reason_json).includes('vendor:any'));assert.ok(JSON.parse(route.route_reason_json).includes('processing:any'));
    const workflow=tenantDb.get(database.prepare(`SELECT id,status,next_execution_ordinal,completed_at_ms,lease_owner,lease_expires_at_ms FROM multi_model_workflows
      WHERE tenant_id=? AND run_id=?`),prepared.run.id) as {id:string;status:string;next_execution_ordinal:number;completed_at_ms:number|null;lease_owner:string|null;lease_expires_at_ms:number|null}|undefined;
    assert.ok(workflow);assert.equal(workflow.status,'completed');assert.equal(workflow.next_execution_ordinal,6);assert.equal(workflow.completed_at_ms,NOW);
    assert.equal(workflow.lease_owner,null);assert.equal(workflow.lease_expires_at_ms,null);

    const executions=tenantDb.all(database.prepare(`SELECT e.id,e.ordinal,e.execution_role,e.provider_key,e.status,e.input_tokens,e.output_tokens,e.cached_input_tokens,
        e.provider_cost_microusd,e.customer_charge_microusd,e.credential_source,e.usage_record_id,e.result_ciphertext,e.result_nonce,e.completed_at_ms,
        m.input_microusd_per_million input_price,m.output_microusd_per_million output_price,m.cached_input_microusd_per_million cached_price,
        m.vendor_jurisdiction,m.speed_class,m.quality_tier,m.multi_model_eligible
      FROM provider_executions e JOIN model_catalog m ON m.tenant_id=e.tenant_id AND m.id=e.model_catalog_id
      WHERE e.tenant_id=? AND e.workflow_id=? ORDER BY e.ordinal`),workflow.id) as Array<{
        id:string;ordinal:number;execution_role:string;provider_key:ProviderId;status:string;input_tokens:number;output_tokens:number;cached_input_tokens:number;
        provider_cost_microusd:number;customer_charge_microusd:number;credential_source:string;usage_record_id:string|null;result_ciphertext:Buffer|null;result_nonce:Buffer|null;completed_at_ms:number|null;
        input_price:number;output_price:number;cached_price:number|null;vendor_jurisdiction:string;speed_class:string;quality_tier:number;multi_model_eligible:number;
      }>;
    assert.equal(executions.length,5);assert.ok(executions.every(row=>row.status==='succeeded'&&row.completed_at_ms===NOW));
    assert.deepEqual(executions.map(row=>row.execution_role),STEPS);
    assert.ok(new Set(executions.map(row=>row.provider_key)).size>=2);
    for(const row of executions){
      assert.equal(row.vendor_jurisdiction,'us');
      assert.equal(row.speed_class,'fast');assert.equal(row.quality_tier,1);assert.equal(row.multi_model_eligible,1);assert.equal(row.credential_source,'byok');
      const authoritativeCost=estimateModelCostMicrousd({inputTokens:row.input_tokens,outputTokens:row.output_tokens,cachedInputTokens:row.cached_input_tokens,inputMicrousdPerMillion:row.input_price,outputMicrousdPerMillion:row.output_price,cachedInputMicrousdPerMillion:row.cached_price});
      assert.equal(row.provider_cost_microusd,authoritativeCost);assert.equal(row.customer_charge_microusd,0);
      assert.ok(row.result_ciphertext&&row.result_ciphertext.byteLength>16);assert.equal(row.result_nonce?.byteLength,12);
    }

    const storedUsage=tenantDb.get(database.prepare(`SELECT u.id,u.provider_cost_microusd,u.customer_charge_microusd,u.credential_source,u.platform_model_version_id,u.routing_decision_id,
        u.input_tokens,u.output_tokens
      FROM usage_records u
      WHERE u.tenant_id=? AND u.message_id=?`),prepared.assistant.id) as {id:string;provider_cost_microusd:number;customer_charge_microusd:number;credential_source:string;platform_model_version_id:string;routing_decision_id:string;input_tokens:number;output_tokens:number;authoritative:number;pricing_verified_at:number|null}|undefined;
    assert.ok(storedUsage);const providerCost=executions.reduce((sum,row)=>sum+row.provider_cost_microusd,0),customerCharge=executions.reduce((sum,row)=>sum+row.customer_charge_microusd,0);
    assert.ok(providerCost>0);assert.equal(usage.costUsd,providerCost/1_000_000);
    assert.equal(storedUsage.provider_cost_microusd,providerCost);assert.equal(storedUsage.customer_charge_microusd,customerCharge);assert.equal(storedUsage.customer_charge_microusd,0);
    assert.equal(storedUsage.credential_source,'byok');assert.equal(storedUsage.routing_decision_id,route.id);
    assert.ok(executions.some(row=>row.id&&database.prepare('SELECT platform_model_version_id FROM provider_executions WHERE id=?').pluck().get(row.id)===null),'at least one completed execution must be unpinned');
    assert.equal(storedUsage.input_tokens,5_000);assert.equal(storedUsage.output_tokens,500);
    const storedMessage=tenantDb.get(database.prepare('SELECT cost_microusd FROM messages WHERE tenant_id=? AND id=?'),prepared.assistant.id) as {cost_microusd:number}|undefined;
    assert.equal(storedMessage?.cost_microusd,providerCost);
    assert.ok(executions.every(row=>row.usage_record_id===storedUsage.id),'all five durable executions must link to the aggregate usage record');
  }finally{
    app.stop();database.close();
  }
});

test('restart recovery never redispatches and bills only authoritative multi-model checkpoints',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,11),transcriptKey:()=>Buffer.alloc(32,12),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW});
  const workspace=provisionTestTenant(database,{email:'owner@recovery.example',name:'Recovery',now:NOW}),tenantId=workspace.tenantId as TenantId,tenantDb=forTenant({tenantId});
  database.prepare("UPDATE provider_config SET enabled=0,credential_ciphertext=NULL,key_version=NULL WHERE tenant_id=? AND provider_key NOT IN ('openai','anthropic','google','xai')").run(tenantId);
  const tenant={principal:{tenantId,userId:workspace.ownerUserId,membershipId:workspace.ownerUserId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:tenantDb,requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  const calls:ProviderCall[]=[],providers=new Map<ProviderId,ChatProvider>(['openai','anthropic','google','xai'].map(id=>[id as ProviderId,fakeProvider(id as ProviderId,calls)]));
  const app=new GovernedChatApplication({database,gate:allowGate([]),providers:{get(id){const provider=providers.get(id);if(!provider)throw new Error(`Unexpected provider ${id}`);return provider;}},audit,approvalPayloadKey:Buffer.alloc(32,13),multiModelResultKey:Buffer.alloc(32,14),now:()=>NOW});
  const prepare=async(key:string)=>{
    const prepared=await app.createRun(tenant,{content:`Compare recovery choices for ${key}.`,mode:'multi_model',reasoningEffort:'high',clientRequestId:randomUUID()},'create',{key,requestHash:key.padEnd(64,'a').slice(0,64),method:'POST',path:'/chat/runs'});
    const preflight=await app.gate(tenant,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},new AbortController().signal),reservation=await app.reserveBudget(tenant,prepared.run);
    await app.dispatchStarted(tenant,prepared.run,reservation);
    const durable=database.prepare(`SELECT w.id workflow_id,w.routing_decision_id,i.id idempotency_id FROM multi_model_workflows w JOIN idempotency_records i ON i.tenant_id=w.tenant_id AND i.run_id=w.run_id WHERE w.tenant_id=? AND w.run_id=?`).get(tenantId,prepared.run.id) as {workflow_id:string;routing_decision_id:string;idempotency_id:string};
    return{prepared,preflight,reservation,...durable};
  };
  try{
    const interrupted=await prepare('checkpointed-recovery');
    assert.deepEqual(recoverInterruptedMultiModelWorkflows(database,{now:NOW,workerId:'maintenance'}),{recovered:0,completed:0,indeterminate:0,knownProviderCostMicrousd:0},'maintenance must not steal a live workflow lease');
    const executions=database.prepare('SELECT id,ordinal FROM provider_executions WHERE tenant_id=? AND workflow_id=? ORDER BY ordinal').all(tenantId,interrupted.workflow_id) as Array<{id:string;ordinal:number}>;
    database.prepare("UPDATE provider_executions SET status='succeeded',input_tokens=10,output_tokens=2,cached_input_tokens=1,provider_cost_microusd=100,customer_charge_microusd=0,completed_at_ms=? WHERE tenant_id=? AND id=?").run(NOW-30,tenantId,executions[0]!.id);
    database.prepare("UPDATE provider_executions SET status='failed',credential_source='byok',input_tokens=5,output_tokens=1,cached_input_tokens=0,provider_cost_microusd=50,customer_charge_microusd=0,completed_at_ms=? WHERE tenant_id=? AND id=?").run(NOW-20,tenantId,executions[1]!.id);
    database.prepare("UPDATE provider_executions SET status='streaming',provider_request_id='unknown-dispatch',started_at_ms=? WHERE tenant_id=? AND id=?").run(NOW-10,tenantId,executions[2]!.id);
    database.prepare('UPDATE multi_model_workflows SET lease_expires_at_ms=?,updated_at_ms=? WHERE tenant_id=? AND id=?').run(NOW-1,NOW-10,tenantId,interrupted.workflow_id);
    const recovered=recoverInterruptedMultiModelWorkflows(database,{now:NOW,workerId:'maintenance'});
    assert.deepEqual(recovered,{recovered:1,completed:0,indeterminate:1,knownProviderCostMicrousd:150});assert.equal(calls.length,0);
    assert.deepEqual(database.prepare('SELECT status,failure_code,lease_owner,lease_expires_at_ms FROM multi_model_workflows WHERE id=?').get(interrupted.workflow_id),{status:'indeterminate',failure_code:'multi_model_restart_unknown_dispatch',lease_owner:null,lease_expires_at_ms:null});
    assert.equal(database.prepare('SELECT status FROM routing_decisions WHERE id=?').pluck().get(interrupted.routing_decision_id),'failed');
    assert.equal(database.prepare('SELECT status FROM idempotency_records WHERE id=?').pluck().get(interrupted.idempotency_id),'failed');
    assert.deepEqual(database.prepare('SELECT status,error_code FROM messages WHERE id=?').get(interrupted.prepared.assistant.id),{status:'failed',error_code:'MULTI_MODEL_RECOVERY_INDETERMINATE'});
    assert.deepEqual(database.prepare('SELECT ordinal,status,usage_record_id IS NOT NULL linked FROM provider_executions WHERE workflow_id=? ORDER BY ordinal').all(interrupted.workflow_id),[
      {ordinal:1,status:'succeeded',linked:1},{ordinal:2,status:'failed',linked:1},{ordinal:3,status:'indeterminate',linked:0},{ordinal:4,status:'cancelled',linked:0},{ordinal:5,status:'cancelled',linked:0},
    ]);
    assert.deepEqual(database.prepare('SELECT input_tokens,output_tokens,cached_input_tokens,cost_microusd,provider_cost_microusd,customer_charge_microusd,credential_source,routing_decision_id,status FROM usage_records WHERE message_id=?').get(interrupted.prepared.assistant.id),{input_tokens:15,output_tokens:3,cached_input_tokens:1,cost_microusd:150,provider_cost_microusd:150,customer_charge_microusd:0,credential_source:'byok',routing_decision_id:interrupted.routing_decision_id,status:'cancelled'});
    assert.equal(database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(interrupted.reservation.id),'settled');
    assert.deepEqual(recoverInterruptedMultiModelWorkflows(database,{now:NOW+1,workerId:'maintenance'}),{recovered:0,completed:0,indeterminate:0,knownProviderCostMicrousd:0});
    assert.equal(database.prepare('SELECT COUNT(*) FROM usage_records WHERE message_id=?').pluck().get(interrupted.prepared.assistant.id),1);

    const completed=await prepare('completed-recovery');
    database.prepare(`UPDATE provider_executions SET status='succeeded',input_tokens=1,output_tokens=1,cached_input_tokens=0,
      provider_cost_microusd=1,customer_charge_microusd=CASE credential_source WHEN 'platform' THEN 2 ELSE 0 END,completed_at_ms=?
      WHERE tenant_id=? AND workflow_id=?`).run(NOW-5,tenantId,completed.workflow_id);
    const completedCharge=database.prepare('SELECT SUM(customer_charge_microusd) FROM provider_executions WHERE tenant_id=? AND workflow_id=?').pluck().get(tenantId,completed.workflow_id) as number;
    database.prepare("UPDATE multi_model_workflows SET status='completed',next_execution_ordinal=6,lease_owner=NULL,lease_expires_at_ms=NULL,completed_at_ms=?,updated_at_ms=? WHERE tenant_id=? AND id=?").run(NOW-4,NOW-4,tenantId,completed.workflow_id);
    database.prepare("UPDATE messages SET status='complete',input_tokens=5,output_tokens=5,cost_microusd=?,completed_at=? WHERE tenant_id=? AND id=?").run(completedCharge,NOW-4,tenantId,completed.prepared.assistant.id);
    database.prepare("UPDATE message_parts SET text_content='Recovered consolidated answer.',kind='text' WHERE tenant_id=? AND message_id=? AND ordinal=0").run(tenantId,completed.prepared.assistant.id);
    const completedRecovered=recoverInterruptedMultiModelWorkflows(database,{now:NOW,workerId:'startup',recoverAll:true});
    assert.deepEqual(completedRecovered,{recovered:1,completed:1,indeterminate:0,knownProviderCostMicrousd:5});assert.equal(calls.length,0);
    assert.equal(database.prepare('SELECT status FROM usage_records WHERE message_id=?').pluck().get(completed.prepared.assistant.id),'success');
    assert.equal(database.prepare('SELECT status FROM idempotency_records WHERE id=?').pluck().get(completed.idempotency_id),'completed');
    assert.equal(database.prepare('SELECT status FROM routing_decisions WHERE id=?').pluck().get(completed.routing_decision_id),'completed');

    const startup=await prepare('startup-recovery'),usageBefore=database.prepare('SELECT COUNT(*) FROM usage_records').pluck().get() as number;
    const startupRecovered=recoverInterruptedMultiModelWorkflows(database,{now:NOW,workerId:'startup',recoverAll:true});
    assert.deepEqual(startupRecovered,{recovered:1,completed:0,indeterminate:1,knownProviderCostMicrousd:0});assert.equal(calls.length,0);
    assert.equal(database.prepare('SELECT status FROM budget_reservations WHERE id=?').pluck().get(startup.reservation.id),'released');
    assert.equal(database.prepare('SELECT COUNT(*) FROM usage_records').pluck().get(),usageBefore,'startup recovery without checkpoints must not create usage');
    assert.equal(database.prepare('SELECT status FROM multi_model_workflows WHERE id=?').pluck().get(startup.workflow_id),'indeterminate');
  }finally{app.stop();database.close();}
});
