import type Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import { calculateUsageBilling } from '../../lib/governance/index.js';
import { GovernanceLedger } from '../../lib/governance/ledger.js';
import type { ChatRun, Message, Provider } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';

export const SINGLE_MODEL_RECOVERY_GRACE_MS=15*60_000;
const PREDISPATCH_ERROR='CHAT_RECOVERY_PREDISPATCH';
const INDETERMINATE_ERROR='CHAT_RECOVERY_INDETERMINATE';

interface CandidateRow {
  tenant_id:TenantId;idempotency_id:string;idempotency_status:'claimed'|'dispatching';idempotency_updated_at:number;
  idempotency_created_at:number;run_id:string;conversation_id:string;user_message_id:string;assistant_message_id:string;
}
interface MessageRow {
  status:string;created_at:number;parent_message_id:string|null;model_catalog_id:string|null;provider_key:Provider|null;
  input_tokens:number|null;output_tokens:number|null;cost_microusd:number|null;text_content:string|null;
}
interface RoutingRow {
  id:string;mode:'auto'|'single'|'multi_model';status:string;credential_source:'platform'|'byok'|null;selected_platform_model_version_id:string|null;
  baseline_platform_model_version_id:string|null;baseline_cost_microusd:number|null;
}
interface ReservationRow {id:string;status:'active'|'released'|'settled';expires_at:number;metadata_json:string}
interface UsageRow {
  id:string;input_tokens:number;output_tokens:number;cached_input_tokens:number;cost_microusd:number;
  provider_cost_microusd:number|null;customer_charge_microusd:number|null;credential_source:'platform'|'byok'|'legacy_unknown';
  baseline_cost_microusd:number|null;savings_microusd:number|null;platform_model_version_id:string|null;routing_decision_id:string|null;
}

export interface SingleModelRecoveryInput {
  readonly now:number;
  readonly workerId?:string;
  readonly recoverAll?:boolean;
  readonly staleAfterMs?:number;
  readonly limit?:number;
}
export interface SingleModelRecoveryResult {
  readonly recovered:number;
  readonly completed:number;
  readonly cancelled:number;
  readonly indeterminate:number;
  readonly observedProviderCostMicrousd:number;
}

function emptyResult():SingleModelRecoveryResult{return{recovered:0,completed:0,cancelled:0,indeterminate:0,observedProviderCostMicrousd:0};}
function safeCost(value:number,label:string):number {
  if(!Number.isSafeInteger(value)||value<0)throw new Error(`Invalid single-model recovery ${label}`);
  return value;
}
function response(
  row:CandidateRow,
  message:MessageRow|undefined,
  status:'completed'|'failed'|'cancelled',
  content:string,
  inputTokens:number|null,
  outputTokens:number|null,
  providerCostMicrousd:number|null,
):{run:ChatRun;assistant:Message} {
  const run:ChatRun={id:row.run_id,conversationId:row.conversation_id,userMessageId:row.user_message_id,assistantMessageId:row.assistant_message_id,status,
    streamUrl:`/api/v1/chat/runs/${row.run_id}/events`,createdAt:new Date(row.idempotency_created_at).toISOString()};
  const assistant:Message={id:row.assistant_message_id,conversationId:row.conversation_id,parentMessageId:message?.parent_message_id??row.user_message_id,
    role:'assistant',content,modelId:message?.model_catalog_id??null,provider:message?.provider_key??null,
    createdAt:new Date(message?.created_at??row.idempotency_created_at).toISOString(),inputTokens,outputTokens,
    costUsd:providerCostMicrousd===null?null:providerCostMicrousd/1_000_000,gate:null,attachments:[],version:1};
  return{run,assistant};
}

function hasTables(database:Database.Database):boolean {
  const required=['idempotency_records','messages','message_parts','routing_decisions','multi_model_workflows','budget_reservations','usage_records',
    'gate_decisions','policy_violations','policy_approval_requests','audit_events'];
  const rows=database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(()=>'?').join(',')})`).pluck().all(...required) as string[];
  return rows.length===required.length;
}

/**
 * Reconciles ordinary chat runs whose in-memory pipeline disappeared, plus multi-model requests that
 * crashed before their workflow existed. A `dispatching` record is an irreversible ambiguity boundary:
 * recovery never calls a provider and never invents usage. Only an existing usage record can retain a
 * charge; otherwise both reservations are released.
 *
 * Periodic recovery also requires the budget reservation heartbeat to be absent or expired. Startup
 * may use `recoverAll` because it runs before the HTTP listener accepts a new stream.
 */
export function recoverInterruptedSingleModelRuns(database:Database.Database,input:SingleModelRecoveryInput):SingleModelRecoveryResult {
  if(!hasTables(database))return emptyResult();
  if(!Number.isSafeInteger(input.now)||input.now<0)throw new TypeError('Invalid single-model recovery time');
  const limit=input.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>1_000)throw new TypeError('Invalid single-model recovery limit');
  const staleAfter=input.staleAfterMs??SINGLE_MODEL_RECOVERY_GRACE_MS;
  if(!Number.isSafeInteger(staleAfter)||staleAfter<1)throw new TypeError('Invalid single-model recovery grace');
  const recoverAll=input.recoverAll===true,staleBefore=input.now-staleAfter;
  const candidates=database.prepare(`SELECT i.tenant_id,i.id idempotency_id,i.status idempotency_status,i.updated_at idempotency_updated_at,
      i.created_at idempotency_created_at,i.run_id,i.conversation_id,i.user_message_id,i.assistant_message_id
    FROM idempotency_records i
    WHERE i.status IN ('claimed','dispatching') AND i.response_json IS NULL
      AND i.run_id IS NOT NULL AND i.conversation_id IS NOT NULL AND i.user_message_id IS NOT NULL AND i.assistant_message_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM multi_model_workflows w WHERE w.tenant_id=i.tenant_id AND w.run_id=i.run_id)
      AND (NOT EXISTS(SELECT 1 FROM routing_decisions r WHERE r.tenant_id=i.tenant_id AND r.run_id=i.run_id AND r.mode='multi_model') OR (
        i.status='claimed' AND EXISTS(SELECT 1 FROM routing_decisions r
          WHERE r.tenant_id=i.tenant_id AND r.run_id=i.run_id AND r.mode='multi_model' AND r.status IN ('planned','selected'))
        AND NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.tenant_id=i.tenant_id AND e.action='chat.provider_called'
          AND e.conversation_id=i.conversation_id AND e.message_id=i.assistant_message_id
          AND e.target_type='message' AND e.target_id=i.assistant_message_id)
      ))
      AND NOT EXISTS(SELECT 1 FROM gate_decisions d WHERE d.tenant_id=i.tenant_id AND d.message_id=i.user_message_id
        AND d.status IN ('pending_approval','approved'))
      AND NOT EXISTS(SELECT 1 FROM policy_approval_requests a JOIN policy_violations v
        ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
        WHERE a.tenant_id=i.tenant_id AND a.status IN ('pending','claimed','approved','releasing')
          AND (v.message_id=i.user_message_id OR a.release_run_id=i.run_id OR a.routing_decision_id IN (
            SELECT r.id FROM routing_decisions r WHERE r.tenant_id=i.tenant_id AND r.run_id=i.run_id
          )))
      AND (?=1 OR (i.updated_at<=? AND NOT EXISTS(
        SELECT 1 FROM budget_reservations b WHERE b.tenant_id=i.tenant_id AND b.idempotency_key='chat:'||i.id
          AND b.status='active' AND b.expires_at>?
      )))
    ORDER BY i.updated_at,i.tenant_id,i.id LIMIT ?`).all(recoverAll?1:0,staleBefore,input.now,limit) as CandidateRow[];

  let recovered=0,completed=0,cancelled=0,indeterminate=0,observedProviderCostMicrousd=0;
  for(const candidate of candidates){
    const outcome=database.transaction(()=>{
      const tenant=forTenant({tenantId:candidate.tenant_id});
      const periodicFence=`AND updated_at=? AND NOT EXISTS(SELECT 1 FROM budget_reservations b
        WHERE b.tenant_id=(SELECT id FROM tenant_scope) AND b.idempotency_key='chat:'||idempotency_records.id
          AND b.status='active' AND b.expires_at>?)`;
      const ownershipFence=`AND NOT EXISTS(SELECT 1 FROM multi_model_workflows w
          WHERE w.tenant_id=(SELECT id FROM tenant_scope) AND w.run_id=idempotency_records.run_id)
        AND (NOT EXISTS(SELECT 1 FROM routing_decisions r
          WHERE r.tenant_id=(SELECT id FROM tenant_scope) AND r.run_id=idempotency_records.run_id AND r.mode='multi_model') OR (
          idempotency_records.status='claimed' AND EXISTS(SELECT 1 FROM routing_decisions r
            WHERE r.tenant_id=(SELECT id FROM tenant_scope) AND r.run_id=idempotency_records.run_id AND r.mode='multi_model' AND r.status IN ('planned','selected'))
          AND NOT EXISTS(SELECT 1 FROM audit_events e
            WHERE e.tenant_id=(SELECT id FROM tenant_scope) AND e.action='chat.provider_called'
              AND e.conversation_id=idempotency_records.conversation_id AND e.message_id=idempotency_records.assistant_message_id
              AND e.target_type='message' AND e.target_id=idempotency_records.assistant_message_id)
        ))
        AND NOT EXISTS(SELECT 1 FROM gate_decisions d
          WHERE d.tenant_id=(SELECT id FROM tenant_scope) AND d.message_id=idempotency_records.user_message_id
            AND d.status IN ('pending_approval','approved'))
        AND NOT EXISTS(SELECT 1 FROM policy_approval_requests a JOIN policy_violations v
          ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
          WHERE a.tenant_id=(SELECT id FROM tenant_scope) AND a.status IN ('pending','claimed','approved','releasing')
            AND (v.message_id=idempotency_records.user_message_id OR a.release_run_id=idempotency_records.run_id OR a.routing_decision_id IN (
              SELECT r.id FROM routing_decisions r WHERE r.tenant_id=(SELECT id FROM tenant_scope) AND r.run_id=idempotency_records.run_id
            )))`;
      const claim=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET updated_at=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status=? AND response_json IS NULL
          ${ownershipFence} ${recoverAll?'':periodicFence}`) as Database.Statement<[TenantId,...unknown[]]>,input.now,candidate.idempotency_id,candidate.idempotency_status,
          ...(!recoverAll?[candidate.idempotency_updated_at,input.now]:[]));
      if(claim.changes!==1)return null;

      const message=tenant.get(database.prepare<[TenantId,string],MessageRow>(`SELECT m.status,m.created_at,m.parent_message_id,m.model_catalog_id,m.provider_key,
          m.input_tokens,m.output_tokens,m.cost_microusd,p.text_content
        FROM messages m LEFT JOIN message_parts p ON p.tenant_id=m.tenant_id AND p.message_id=m.id AND p.ordinal=0
        WHERE m.tenant_id=? AND m.id=? AND m.role='assistant'`),candidate.assistant_message_id);
      const route=tenant.get(database.prepare<[TenantId,string],RoutingRow>(`SELECT id,mode,status,credential_source,selected_platform_model_version_id,baseline_platform_model_version_id,baseline_cost_microusd
        FROM routing_decisions WHERE tenant_id=? AND run_id=?`),candidate.run_id);
      const reservation=tenant.get(database.prepare<[TenantId,string],ReservationRow>('SELECT id,status,expires_at,metadata_json FROM budget_reservations WHERE tenant_id=? AND idempotency_key=?'),`chat:${candidate.idempotency_id}`);
      const usage=tenant.get(database.prepare<[TenantId,string,string],UsageRow>(`SELECT id,input_tokens,output_tokens,cached_input_tokens,cost_microusd,provider_cost_microusd,
          customer_charge_microusd,credential_source,baseline_cost_microusd,savings_microusd,platform_model_version_id,routing_decision_id
        FROM usage_records WHERE tenant_id=? AND (message_id=? OR provider_request_id=?) ORDER BY completed_at DESC,id LIMIT 1`),
        candidate.assistant_message_id,reservation?`reservation:${reservation.id}`:'reservation:missing');

      let providerCost:number|null=null,customerCharge:number|null=null;
      if(usage){
        providerCost=safeCost(usage.provider_cost_microusd??usage.cost_microusd,'observed provider cost');
        let checkpointSource:'platform'|'byok'|null=null;
        if(reservation){
          const metadata=JSON.parse(reservation.metadata_json) as {credentialSource?:unknown};
          if(metadata.credentialSource==='platform'||metadata.credentialSource==='byok')checkpointSource=metadata.credentialSource;
        }
        const exactSource=checkpointSource??route?.credential_source??null;
        const source=exactSource??usage.credential_source;
        const baseline=usage.baseline_cost_microusd??route?.baseline_cost_microusd??null;
        // Only a route or the pre-provider reservation checkpoint proves the source. Preserve any
        // historical charge, but an unproven legacy row closes at zero rather than guessing whether
        // to apply platform markup or BYOK zero-charge.
        const derived=usage.customer_charge_microusd===null&&exactSource
          ?calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource:exactSource,baselineCostMicrousd:baseline})
          :null;
        customerCharge=safeCost(usage.customer_charge_microusd??derived?.customerChargeMicrousd??0,'observed customer charge');
        const savings=usage.savings_microusd??derived?.savingsMicrousd??null;
        const attributed=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE usage_records SET
            provider_cost_microusd=?,customer_charge_microusd=?,credential_source=?,baseline_cost_microusd=?,savings_microusd=?,
            platform_model_version_id=COALESCE(platform_model_version_id,?),routing_decision_id=COALESCE(routing_decision_id,?)
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,providerCost,customerCharge,source,
          baseline,savings,route?.selected_platform_model_version_id??usage.platform_model_version_id,
          route?.id??usage.routing_decision_id,usage.id);
        if(attributed.changes!==1)throw new Error('Single-model recovery could not attribute observed usage');
      }else{
        if(reservation?.status==='active')new GovernanceLedger(database).release(reservation.id,'single-model restart without durable usage evidence',input.now);
      }

      const safelyCompleted=message?.status==='complete'&&usage!==undefined&&Boolean(message.text_content);
      const wasCancelled=message?.status==='stopped'||route?.status==='cancelled';
      const dispatched=candidate.idempotency_status==='dispatching'||route?.status==='dispatching';
      const runStatus:'completed'|'failed'|'cancelled'=safelyCompleted?'completed':wasCancelled||!dispatched?'cancelled':'failed';
      const content=safelyCompleted?message!.text_content!
        :runStatus==='cancelled'?'The request was interrupted before it was sent.'
        :'The model response could not be safely recovered and was not retried.';
      const inputTokens=usage?.input_tokens??(safelyCompleted?message?.input_tokens??null:null);
      const outputTokens=usage?.output_tokens??(safelyCompleted?message?.output_tokens??null:null);

      if(message&&!safelyCompleted){
        const messageStatus=runStatus==='cancelled'?'stopped':'failed',errorCode=runStatus==='cancelled'?PREDISPATCH_ERROR:INDETERMINATE_ERROR;
        tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status=?,error_code=?,input_tokens=COALESCE(input_tokens,?),
            output_tokens=COALESCE(output_tokens,?),cost_microusd=COALESCE(cost_microusd,?),completed_at=COALESCE(completed_at,?)
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND status IN ('pending','streaming','complete')`) as Database.Statement<[TenantId,...unknown[]]>,
          messageStatus,errorCode,inputTokens,outputTokens,providerCost,input.now,candidate.assistant_message_id);
        tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind='text'
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0`) as Database.Statement<[TenantId,...unknown[]]>,content,candidate.assistant_message_id);
      }
      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions SET status='denied'
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND final_action='warn' AND status='awaiting_confirmation'`) as Database.Statement<[TenantId,...unknown[]]>,candidate.user_message_id);
      tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET status='expired',updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND gate_action='warn' AND status IN ('open','triaged','in_review')`) as Database.Statement<[TenantId,...unknown[]]>,input.now,candidate.user_message_id);
      if(route&&['planned','selected','dispatching'].includes(route.status))tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions
        SET status=?,completed_at_ms=?,updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('planned','selected','dispatching')`) as Database.Statement<[TenantId,...unknown[]]>,
        runStatus==='completed'?'completed':runStatus==='cancelled'?'cancelled':'failed',input.now,input.now,route.id);

      const payload=response(candidate,message,runStatus,content,inputTokens,outputTokens,providerCost);
      const finalized=tenant.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET status=?,response_json=?,updated_at=?,completed_at=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('claimed','dispatching') AND response_json IS NULL`) as Database.Statement<[TenantId,...unknown[]]>,
        runStatus==='completed'?'completed':'failed',JSON.stringify(payload),input.now,input.now,candidate.idempotency_id);
      if(finalized.changes!==1)throw new Error('Single-model recovery lost its idempotency fence');
      return{status:runStatus,providerCost:providerCost??0};
    }).immediate();
    if(!outcome)continue;
    recovered++;observedProviderCostMicrousd+=outcome.providerCost;
    if(outcome.status==='completed')completed++;else if(outcome.status==='cancelled')cancelled++;else indeterminate++;
  }
  return{recovered,completed,cancelled,indeterminate,observedProviderCostMicrousd};
}
