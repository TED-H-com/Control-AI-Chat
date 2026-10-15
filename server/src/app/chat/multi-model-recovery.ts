import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import { GovernanceLedger } from '../../lib/governance/ledger.js';
import type { ChatRun, Message, Provider } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';

export const MULTI_MODEL_WORKFLOW_LEASE_MS=2*60_000;
export const MULTI_MODEL_RECOVERY_GRACE_MS=15*60_000;
const RECOVERY_ERROR='MULTI_MODEL_RECOVERY_INDETERMINATE';

interface RecoveryRow {
  tenant_id:TenantId;workflow_id:string;workflow_status:string;workflow_version:number;routing_decision_id:string;run_id:string;
  idempotency_id:string;idempotency_status:'claimed'|'dispatching';idempotency_created_at:number;user_message_id:string;assistant_message_id:string;
  conversation_id:string;assistant_status:string;assistant_created_at:number;parent_message_id:string|null;model_catalog_id:string|null;
  provider_key:Provider|null;input_tokens:number|null;output_tokens:number|null;cost_microusd:number|null;text_content:string|null;
}
interface ExecutionRow {
  id:string;status:string;credential_source:'platform'|'byok';input_tokens:number|null;output_tokens:number|null;cached_input_tokens:number|null;
  provider_cost_microusd:number|null;customer_charge_microusd:number|null;baseline_cost_microusd:number|null;savings_microusd:number|null;
}
interface ReservationRow {id:string;status:'active'|'released'|'settled';metadata_json:string}
interface ReservationMeta {modelId:string;pricing:{providerModel:string}}

export interface MultiModelRecoveryInput {
  readonly now:number;
  readonly workerId?:string;
  readonly recoverAll?:boolean;
  readonly staleAfterMs?:number;
  readonly limit?:number;
}
export interface MultiModelRecoveryResult {readonly recovered:number;readonly completed:number;readonly indeterminate:number;readonly knownProviderCostMicrousd:number}

function safeSum(values:readonly number[],label:string):number {
  const total=values.reduce((sum,value)=>sum+value,0);
  if(!Number.isSafeInteger(total)||total<0)throw new Error(`Invalid multi-model recovery ${label}`);
  return total;
}

function response(row:RecoveryRow,status:'completed'|'failed',content:string,costMicrousd:number|null):{run:ChatRun;assistant:Message} {
  const run:ChatRun={id:row.run_id,conversationId:row.conversation_id,userMessageId:row.user_message_id,assistantMessageId:row.assistant_message_id,
    status,streamUrl:`/api/v1/chat/runs/${row.run_id}/events`,createdAt:new Date(row.idempotency_created_at).toISOString()};
  const assistant:Message={id:row.assistant_message_id,conversationId:row.conversation_id,parentMessageId:row.parent_message_id,role:'assistant',content,
    modelId:row.model_catalog_id,provider:row.provider_key,createdAt:new Date(row.assistant_created_at).toISOString(),
    inputTokens:status==='completed'?row.input_tokens:null,outputTokens:status==='completed'?row.output_tokens:null,
    costUsd:status==='completed'&&costMicrousd!==null?costMicrousd/1_000_000:null,gate:null,attachments:[],version:1};
  return{run,assistant};
}

/**
 * Reconciles workflows whose in-memory coordinator disappeared. Provider calls are never replayed:
 * only immutable, authoritative execution checkpoints contribute cost, and every other execution is
 * terminalized without usage. `recoverAll` is reserved for startup, before the HTTP server accepts work.
 */
export function recoverInterruptedMultiModelWorkflows(database:Database.Database,input:MultiModelRecoveryInput):MultiModelRecoveryResult {
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='multi_model_workflows'").get())
    return{recovered:0,completed:0,indeterminate:0,knownProviderCostMicrousd:0};
  if(!Number.isSafeInteger(input.now)||input.now<0)throw new TypeError('Invalid multi-model recovery time');
  const limit=input.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>1_000)throw new TypeError('Invalid multi-model recovery limit');
  const staleAfter=input.staleAfterMs??MULTI_MODEL_RECOVERY_GRACE_MS;
  if(!Number.isSafeInteger(staleAfter)||staleAfter<1)throw new TypeError('Invalid multi-model recovery grace');
  const workerId=input.workerId??`multi-recovery:${randomUUID()}`,recoverAll=input.recoverAll===true,staleBefore=input.now-staleAfter;
  const candidates=database.prepare(`SELECT w.tenant_id,w.id workflow_id,w.status workflow_status,w.version workflow_version,w.routing_decision_id,w.run_id,
      i.id idempotency_id,i.status idempotency_status,i.created_at idempotency_created_at,i.user_message_id,i.assistant_message_id,
      i.conversation_id,m.status assistant_status,m.created_at assistant_created_at,m.parent_message_id,m.model_catalog_id,m.provider_key,
      m.input_tokens,m.output_tokens,m.cost_microusd,(SELECT text_content FROM message_parts p WHERE p.tenant_id=m.tenant_id AND p.message_id=m.id AND p.ordinal=0) text_content
    FROM multi_model_workflows w
    JOIN idempotency_records i ON i.tenant_id=w.tenant_id AND i.run_id=w.run_id AND i.status IN ('claimed','dispatching') AND i.response_json IS NULL
    JOIN messages m ON m.tenant_id=w.tenant_id AND m.id=i.assistant_message_id
    WHERE (?=1 OR (w.lease_expires_at_ms IS NOT NULL AND w.lease_expires_at_ms<=?) OR (w.lease_expires_at_ms IS NULL AND w.updated_at_ms<=?))
    ORDER BY w.updated_at_ms,w.tenant_id,w.id LIMIT ?`).all(recoverAll?1:0,input.now,staleBefore,limit) as RecoveryRow[];
  let recovered=0,completed=0,indeterminate=0,knownProviderCostMicrousd=0;
  for(const candidate of candidates){
    const outcome=database.transaction(()=>{
      const tenant=forTenant({tenantId:candidate.tenant_id});
      const claimSql=recoverAll
        ?`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows SET lease_owner=?,lease_expires_at_ms=?,attempts=attempts+1,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND EXISTS(SELECT 1 FROM idempotency_records i WHERE i.tenant_id=(SELECT id FROM tenant_scope) AND i.run_id=multi_model_workflows.run_id AND i.status IN ('claimed','dispatching') AND i.response_json IS NULL)`
        :`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows SET lease_owner=?,lease_expires_at_ms=?,attempts=attempts+1,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND ((lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms<=?) OR (lease_expires_at_ms IS NULL AND updated_at_ms<=?))
          AND EXISTS(SELECT 1 FROM idempotency_records i WHERE i.tenant_id=(SELECT id FROM tenant_scope) AND i.run_id=multi_model_workflows.run_id AND i.status IN ('claimed','dispatching') AND i.response_json IS NULL)`;
      const claimed=recoverAll
        ?tenant.run(database.prepare(claimSql) as Database.Statement<[TenantId,...unknown[]]>,workerId,input.now+MULTI_MODEL_WORKFLOW_LEASE_MS,candidate.workflow_id,candidate.workflow_version)
        :tenant.run(database.prepare(claimSql) as Database.Statement<[TenantId,...unknown[]]>,workerId,input.now+MULTI_MODEL_WORKFLOW_LEASE_MS,candidate.workflow_id,candidate.workflow_version,input.now,staleBefore);
      if(claimed.changes!==1)return null;

      const executions=tenant.all(database.prepare<[TenantId,string],ExecutionRow>(`SELECT e.id,e.status,e.credential_source,e.input_tokens,e.output_tokens,e.cached_input_tokens,
        e.provider_cost_microusd,e.customer_charge_microusd,e.baseline_cost_microusd,e.savings_microusd
        FROM provider_executions e
        WHERE e.tenant_id=? AND e.workflow_id=? ORDER BY e.ordinal`),candidate.workflow_id);
      const known=executions.filter(row=>['succeeded','failed','checkpointed','indeterminate'].includes(row.status)
        &&row.input_tokens!==null&&row.output_tokens!==null&&row.cached_input_tokens!==null&&row.provider_cost_microusd!==null&&row.customer_charge_microusd!==null);
      const hasCompletedEvidence=candidate.workflow_status==='completed'&&candidate.assistant_status==='complete'&&executions.length===5
        &&executions.every(row=>row.status==='succeeded'&&known.includes(row));
      const providerCost=safeSum(known.map(row=>row.provider_cost_microusd!),`provider cost for ${candidate.workflow_id}`);
      const customerCharge=safeSum(known.map(row=>row.customer_charge_microusd!),`customer charge for ${candidate.workflow_id}`);
      const inputTokens=safeSum(known.map(row=>row.input_tokens!),`input tokens for ${candidate.workflow_id}`);
      const outputTokens=safeSum(known.map(row=>row.output_tokens!),`output tokens for ${candidate.workflow_id}`);
      const cachedInputTokens=safeSum(known.map(row=>row.cached_input_tokens!),`cached input tokens for ${candidate.workflow_id}`);
      const reservation=tenant.get(database.prepare<[TenantId,string],ReservationRow>('SELECT id,status,metadata_json FROM budget_reservations WHERE tenant_id=? AND idempotency_key=?'),`chat:${candidate.idempotency_id}`);
      let usageId:string|null=null;
      if(known.length){
        if(!reservation)throw new Error('Multi-model recovery is missing its budget reservation');
        const meta=JSON.parse(reservation.metadata_json) as Partial<ReservationMeta>;
        if(typeof meta.modelId!=='string'||typeof meta.pricing?.providerModel!=='string')throw new Error('Multi-model recovery reservation metadata is invalid');
        const settled=new GovernanceLedger(database).settle({reservationId:reservation.id,providerRequestId:null,providerModel:meta.pricing.providerModel,
          actualInputTokens:inputTokens,actualCachedInputTokens:cachedInputTokens,actualOutputTokens:outputTokens,actualCostMicros:providerCost,
          locallyCountedOutputTokens:outputTokens,usageQuality:'provider_actual',finishReason:'restart_recovery',
          outcome:hasCompletedEvidence?'complete':'provider_error',now:input.now});
        usageId=settled.usageEventId;
        const model=tenant.get(database.prepare<[TenantId,string],{platform_model_version_id:string|null}>('SELECT platform_model_version_id FROM model_catalog WHERE tenant_id=? AND id=?'),meta.modelId);
        if(!model)throw new Error('Multi-model recovery representative catalogue model disappeared');
        const baselineRows=known.map(row=>row.baseline_cost_microusd).filter((value):value is number=>value!==null);
        const savingsRows=known.map(row=>row.savings_microusd).filter((value):value is number=>value!==null);
        const source=known.some(row=>row.credential_source==='platform')?'platform':'byok';
        const billed=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE usage_records SET provider_cost_microusd=?,customer_charge_microusd=?,credential_source=?,
          baseline_cost_microusd=?,savings_microusd=?,platform_model_version_id=?,routing_decision_id=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,
          providerCost,customerCharge,source,baselineRows.length?safeSum(baselineRows,'baseline cost'):null,savingsRows.length?safeSum(savingsRows,'savings'):null,
          model.platform_model_version_id,candidate.routing_decision_id,usageId);
        if(billed.changes!==1)throw new Error('Multi-model recovery could not attribute request billing');
        const link=database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE provider_executions SET usage_record_id=?
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND (usage_record_id IS NULL OR usage_record_id=?)`);
        for(const execution of known)if(tenant.run(link as Database.Statement<[TenantId,...unknown[]]>,usageId,execution.id,usageId).changes!==1)
          throw new Error('Multi-model recovery could not link an execution checkpoint');
      }else if(reservation&&reservation.status==='active')new GovernanceLedger(database).release(reservation.id,'multi-model restart before authoritative usage checkpoint',input.now);

      const safelyCompleted=hasCompletedEvidence&&usageId!==null;
      if(safelyCompleted){
        tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows SET status='completed',failure_code=NULL,
          lease_owner=NULL,lease_expires_at_ms=NULL,completed_at_ms=COALESCE(completed_at_ms,?),updated_at_ms=?,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,input.now,input.now,candidate.workflow_id,workerId);
        tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions SET status='completed',completed_at_ms=COALESCE(completed_at_ms,?),updated_at_ms=?,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,input.now,input.now,candidate.routing_decision_id);
        const payload=response(candidate,'completed',candidate.text_content??'',candidate.cost_microusd??providerCost);
        const finalized=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET status='completed',response_json=?,updated_at=?,completed_at=?
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('claimed','dispatching') AND response_json IS NULL`) as Database.Statement<[TenantId,...unknown[]]>,JSON.stringify(payload),input.now,input.now,candidate.idempotency_id);
        if(finalized.changes!==1)throw new Error('Multi-model completed recovery lost its idempotency fence');
        return{status:'completed' as const,providerCost};
      }

      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE provider_executions SET status=CASE WHEN status='planned' THEN 'cancelled' ELSE 'indeterminate' END,
        completed_at_ms=COALESCE(completed_at_ms,?),lease_owner=NULL,lease_expires_at_ms=NULL,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND workflow_id=? AND status IN ('planned','claimed','streaming','checkpointed')`) as Database.Statement<[TenantId,...unknown[]]>,input.now,candidate.workflow_id);
      const failureCode=executions.some(row=>row.status==='streaming')?'multi_model_restart_unknown_dispatch':'multi_model_restart_unrecoverable';
      if(tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows SET status='indeterminate',failure_code=?,completed_at_ms=NULL,
        lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,failureCode,input.now,candidate.workflow_id,workerId).changes!==1)
        throw new Error('Multi-model recovery lost its workflow fence');
      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions SET status='failed',completed_at_ms=?,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,input.now,input.now,candidate.routing_decision_id);
      const content='The multi-model run could not be safely recovered.';
      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status='failed',error_code=?,completed_at=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND status IN ('pending','streaming')`) as Database.Statement<[TenantId,...unknown[]]>,RECOVERY_ERROR,input.now,candidate.assistant_message_id);
      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind='text'
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0`) as Database.Statement<[TenantId,...unknown[]]>,content,candidate.assistant_message_id);
      const payload=response(candidate,'failed',content,null);
      const finalized=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET status='failed',response_json=?,updated_at=?,completed_at=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('claimed','dispatching') AND response_json IS NULL`) as Database.Statement<[TenantId,...unknown[]]>,JSON.stringify(payload),input.now,input.now,candidate.idempotency_id);
      if(finalized.changes!==1)throw new Error('Multi-model indeterminate recovery lost its idempotency fence');
      return{status:'indeterminate' as const,providerCost};
    }).immediate();
    if(!outcome)continue;
    recovered++;knownProviderCostMicrousd+=outcome.providerCost;
    if(outcome.status==='completed')completed++;else indeterminate++;
  }
  return{recovered,completed,indeterminate,knownProviderCostMicrousd};
}
