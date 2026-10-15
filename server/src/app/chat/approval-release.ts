import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { forTenant, type TenantDb } from '../../lib/db.js';
import type { AuditService, AuditTransaction } from '../../lib/audit/index.js';
import { assertProviderTransportAuthorized, resolvePolicy, type GateContext, type GateEngine, type GatePrincipalRole, type GateVerdict, type ResolvedPolicySnapshot } from '../../lib/gate/index.js';
import {
  calculateUsageBilling, estimateModelCostMicrousd, GovernanceLedger, loadRoutingCandidates, RateLimiter,
  resolveEffectiveModels, ROUTING_OUTPUT_TOKEN_ESTIMATE, selectSingleRoute, type DirectUsVendorProvider, type ReservationGrant, type RoutingEffort,
  type SettlementResult, type SingleRouteSelection,
} from '../../lib/governance/index.js';
import { estimateUsage } from '../../lib/providers/metering.js';
import type { ProviderRegistry } from '../../lib/providers/registry.js';
import type { TenantProviderRegistry } from '../../lib/providers/tenant-registry.js';
import { supportsReasoningEffort } from '../../lib/providers/reasoning-capability.js';
import type { ChatMessage, ChatProvider, ChatRequest, ProviderId, ProviderProtocol, Usage } from '../../lib/providers/types.js';
import type { GateAction } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { openApprovalEnvelope, openApprovalResult, protectedContentDigest, sealApprovalResult, type ApprovalAttachmentV1, type ApprovalEnvelopePayloadV1, type ApprovalReleaseResultV1 } from './approval-envelope.js';
import { completeApprovalRun, terminalApprovalRun } from './approval-run-lifecycle.js';
import { assembleAuthorizedProviderContext } from './attachment-context.js';
import { estimateRequiredInputTokens } from '../../lib/token-estimate.js';
import { composePersona } from './personas.js';

const LEASE_MS=30_000;
const MAX_ATTEMPTS=3;
const MAX_FINALIZE_ATTEMPTS=3;
const RETRY_MS=[1_000,5_000,30_000] as const;
const FINALIZE_RETRY_MS=[1_000,5_000,30_000] as const;
const SAFE_FAILURE_CODES=new Set([
  'account_inactive','approval_dispatch_without_reservation','approval_finalize_failed','approval_payload_invalid','approval_release_failed',
  'approval_release_fence_lost','approval_release_message_conflict','approval_release_not_prepared','approval_reservation_metadata_invalid',
  'approval_violation_changed','postflight_policy_changed',
  'attachment_changed','attachment_invalid','attachment_project_changed','attachment_unavailable','budget_hard_cap_exceeded',
  'budget_output_too_small','concurrent_stream_limit','conversation_unavailable','gate_omitted_attachment','idempotency_conflict',
  'ledger_invariant_violation','model_not_allowed','model_unavailable','no_models_available','payload_digest_mismatch','policy_changed',
  'multi_model_approval_unsupported',
  'pricing_overflow','provider_aborted','provider_failed','provider_not_allowed','provider_response_too_large','provider_timeout',
  'provider_unavailable','reasoning_unavailable','reconciliation_required','release_identity_missing','request_rate_limited',
  'resource_not_found','tenant_inactive','unauthorized','forbidden','worker_aborted',
]);

interface ApprovalRow {
  id:string;tenant_id:TenantId;violation_id:string;gate_decision_id:string|null;requesting_user_id:string;status:string;
  payload_ciphertext:Buffer;payload_nonce:Buffer;key_version:number;payload_digest:string;policy_revision:number;
  payload_crypto_scheme:'legacy_v1'|'dek_v2';payload_crypto_state:string;payload_wrapped_dek:Buffer|null;payload_wrap_nonce:Buffer|null;payload_kek_version:number|null;
  decision_by_user_id:string|null;decision_note:string|null;release_attempts:number;version:number;expires_at_ms:number;
  release_message_id:string|null;release_run_id:string|null;release_user_message_id:string|null;release_reservation_id:string|null;
  routing_decision_id:string|null;
  release_lease_owner:string|null;release_lease_expires_at_ms:number|null;release_next_attempt_at_ms:number|null;release_phase:string|null;
  release_error_code:string|null;release_finalize_attempts:number;provider_started_at_ms:number|null;result_ciphertext:Buffer|null;result_nonce:Buffer|null;result_digest:string|null;
  violation_status:string;violation_version:number;gate_decision_status:string|null;rule_ids_json:string;group_id:string|null;conversation_id:string|null;message_id:string|null;detector:string;violation_direction:'outbound'|'inbound'|'file';
}
interface ModelRow {id:string;provider_key:ProviderId;model_key:string;display_name:string;context_window:number;max_output_tokens:number;input_microusd_per_million:number;output_microusd_per_million:number;cached_input_microusd_per_million:number|null;capabilities_json:string;platform_model_version_id:string|null}
interface RoutingDecisionRow {
  id:string;tenant_id:TenantId;run_id:string;user_id:string;conversation_id:string|null;assistant_message_id:string|null;
  mode:'auto'|'single'|'multi_model';requested_provider:DirectUsVendorProvider|null;requested_model_catalog_id:string|null;requested_effort:RoutingEffort;
  selected_model_catalog_id:string|null;selected_platform_model_version_id:string|null;selected_provider:ProviderId|null;
  selected_reasoning_effort:'none'|'low'|'medium'|'high'|null;vendor_jurisdiction_constraint:'us'|'any';processing_region_constraint:'us'|'any';
  baseline_platform_model_version_id:string|null;baseline_cost_microusd:number|null;credential_source:'platform'|'byok'|null;status:'planned'|'selected'|'dispatching'|'completed'|'failed'|'cancelled';
}
interface PolicyRow {id:string;revision:number;name:string;detector_kind:'keyword'|'pii'|'secret'|'source_code'|'classification_tag'|'prompt_injection'|'semantic_policy'|'institution_name';action:GateAction;pass_mask:'preflight'|'postflight'|'both';priority:number;scope_type:'org'|'group'|'user'|'model';scope_id:string;config_json:string;failure_mode:'open'|'closed'|'escalate'}
interface FileRow {id:string;project_id:string;original_name:string;mime_type:string;byte_size:number;sha256:string;extracted_text:string;created_at:number}
interface Subject {tenantId:TenantId;userId:string;groupIds:string[];roles:GatePrincipalRole[]}
interface Prepared {row:ApprovalRow;payload:ApprovalEnvelopePayloadV1;subject:Subject;model:ModelRow;projectId:string|null;verdict:GateVerdict;fileResults:ApprovalReleaseResultV1['files'];messages:readonly ChatMessage[];authorizedPrompt:string;policyFingerprint:string;attachmentContextTruncated:boolean;reservation:ReservationGrant;route:RoutingDecisionRow|null;routeSelection:SingleRouteSelection|null;credentialSource:'platform'|'byok'|'legacy_unknown'}
interface Claimed {row:ApprovalRow;leaseOwner:string;attempt:number;supersededReservationId:string|null;finalizeTerminal:boolean}
interface ReservationMeta {output:number;pricing:{providerModel:string}}
interface ProviderStartRow {metadata_json:string}
interface ApprovalSettlement {settled:SettlementResult;providerCostMicrousd:number;customerChargeMicrousd:number;baselineCostMicrousd:number|null;savingsMicrousd:number|null;model:ModelRow;route:RoutingDecisionRow|null;credentialSource:'platform'|'byok'|'legacy_unknown'}
interface ReleaseContext {model:ModelRow;route:RoutingDecisionRow|null;credentialSource:'platform'|'byok'|'legacy_unknown'}

export interface ApprovalReleaseWorkerDependencies {
  readonly database:Database.Database;
  readonly gate:GateEngine;
  readonly providers:Pick<ProviderRegistry,'get'>;
  readonly tenantProviders?:Pick<TenantProviderRegistry,'resolve'>;
  readonly audit:AuditService;
  readonly approvalPayloadKey:Uint8Array;
  readonly now?:()=>number;
  readonly workerId?:string;
  readonly leaseMs?:number;
  readonly pollMs?:number;
  readonly providerTimeoutMs?:number;
  readonly maxResponseCodePoints?:number;
  readonly concurrency?:number;
  readonly logger?:Pick<Console,'error'|'warn'>;
}

export class ApprovalReleaseWorker {
  readonly available=true;
  readonly #database:Database.Database;
  readonly #gate:GateEngine;
  readonly #providers:Pick<ProviderRegistry,'get'>;
  readonly #tenantProviders:Pick<TenantProviderRegistry,'resolve'>|null;
  readonly #audit:AuditService;
  readonly #key:Buffer;
  readonly #ledger:GovernanceLedger;
  readonly #rates:RateLimiter;
  readonly #now:()=>number;
  readonly #workerId:string;
  readonly #leaseMs:number;
  readonly #pollMs:number;
  readonly #providerTimeoutMs:number;
  readonly #maxResponseCodePoints:number;
  readonly #concurrency:number;
  readonly #logger:Pick<Console,'error'|'warn'>;
  readonly #q;
  #timer:NodeJS.Timeout|null=null;
  #timerImmediate=false;
  #running:Promise<number>|null=null;
  #stopped=false;
  #wakePending=false;
  #drainWake:(()=>void)|null=null;
  readonly #activeControllers=new Set<AbortController>();
  readonly #activeProcesses=new Set<Promise<void>>();
  readonly #finalizeAuditBackoff=new Map<string,{failures:number;nextAt:number}>();

  constructor(deps:ApprovalReleaseWorkerDependencies){
    if(deps.approvalPayloadKey.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');
    this.#database=deps.database;this.#gate=deps.gate;this.#providers=deps.providers;this.#tenantProviders=deps.tenantProviders??null;this.#audit=deps.audit;
    this.#key=Buffer.from(deps.approvalPayloadKey);this.#ledger=new GovernanceLedger(deps.database);this.#rates=new RateLimiter(deps.database);
    this.#now=deps.now??Date.now;this.#workerId=deps.workerId??randomUUID();this.#leaseMs=deps.leaseMs??LEASE_MS;this.#pollMs=deps.pollMs??5_000;this.#providerTimeoutMs=deps.providerTimeoutMs??120_000;this.#maxResponseCodePoints=deps.maxResponseCodePoints??1_000_000;this.#concurrency=deps.concurrency??4;this.#logger=deps.logger??console;
    if(!Number.isSafeInteger(this.#concurrency)||this.#concurrency<1||this.#concurrency>16)throw new TypeError('Approval release concurrency must be an integer from 1 to 16');
    this.#q={
      load:deps.database.prepare<[TenantId,string],ApprovalRow>(`SELECT a.*,v.status violation_status,v.version violation_version,g.status gate_decision_status,v.rule_ids_json,v.group_id,v.conversation_id,v.message_id,v.detector,v.direction violation_direction
        FROM policy_approval_requests a JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
        LEFT JOIN gate_decisions g ON g.tenant_id=a.tenant_id AND g.id=a.gate_decision_id
        WHERE a.tenant_id=? AND a.id=?`),
      policies:deps.database.prepare<[TenantId,string,string,string,string],PolicyRow>(`SELECT r.id,r.updated_at revision,p.name,CASE d.kind WHEN 'classification' THEN 'classification_tag' WHEN 'injection' THEN 'prompt_injection' WHEN 'semantic' THEN 'semantic_policy' WHEN 'institution' THEN 'institution_name' WHEN 'regex' THEN 'keyword' ELSE d.kind END detector_kind,r.action,CASE r.direction WHEN 'inbound' THEN 'postflight' ELSE 'preflight' END pass_mask,r.priority,CASE r.scope_type WHEN 'tenant' THEN 'org' ELSE r.scope_type END scope_type,COALESCE(r.scope_id,r.tenant_id) scope_id,r.config_json,'closed' failure_mode FROM policy_rules r JOIN policies p ON p.tenant_id=r.tenant_id AND p.id=r.policy_id AND p.enabled=1 AND p.deleted_at IS NULL JOIN detector_definitions d ON d.id=r.detector_id AND d.enabled=1 AND (d.tenant_id=r.tenant_id OR d.tenant_id IS NULL) WHERE r.tenant_id=? AND r.enabled=1 AND r.direction IN (SELECT value FROM json_each(?)) AND (r.scope_type='tenant' OR (r.scope_type='user' AND r.scope_id=?) OR (r.scope_type='group' AND r.scope_id IN (SELECT value FROM json_each(?))) OR (r.scope_type='model' AND r.scope_id=?)) ORDER BY r.priority DESC,r.id`),
      groups:deps.database.prepare<[TenantId,string],{group_id:string}>('SELECT group_id FROM group_members WHERE tenant_id=? AND user_id=? ORDER BY group_id'),
      roles:deps.database.prepare<[TenantId,string],{role:string}>(`SELECT DISTINCT r.key role FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND (r.tenant_id=ur.tenant_id OR r.tenant_id IS NULL) WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY r.key`),
      model:deps.database.prepare<[TenantId,string],ModelRow>(`SELECT m.id,m.provider_key,m.model_key,m.display_name,m.context_window,m.max_output_tokens,
        m.input_microusd_per_million,m.output_microusd_per_million,m.cached_input_microusd_per_million,m.capabilities_json,m.platform_model_version_id
        FROM model_catalog m
        WHERE m.tenant_id=? AND m.id=? AND m.enabled=1`),
      settlementModel:deps.database.prepare<[TenantId,string],ModelRow>(`SELECT m.id,m.provider_key,m.model_key,m.display_name,m.context_window,m.max_output_tokens,
        m.input_microusd_per_million,m.output_microusd_per_million,m.cached_input_microusd_per_million,m.capabilities_json,m.platform_model_version_id
        FROM model_catalog m
        WHERE m.tenant_id=? AND m.id=?`),
      route:deps.database.prepare<[TenantId,string],RoutingDecisionRow>(`SELECT id,tenant_id,run_id,user_id,conversation_id,assistant_message_id,mode,requested_provider,requested_model_catalog_id,requested_effort,
        selected_model_catalog_id,selected_platform_model_version_id,selected_provider,selected_reasoning_effort,vendor_jurisdiction_constraint,processing_region_constraint,
        baseline_platform_model_version_id,baseline_cost_microusd,credential_source,status FROM routing_decisions WHERE tenant_id=? AND id=?`),
      catalogPricing:deps.database.prepare<[TenantId,string],{input_price:number;output_price:number;cached_price:number|null}>('SELECT input_microusd_per_million input_price,output_microusd_per_million output_price,cached_input_microusd_per_million cached_price FROM model_catalog WHERE tenant_id=? AND id=?'),
      conversation:deps.database.prepare<[TenantId,string,string],{id:string;project_id:string|null}>(`SELECT c.id,(SELECT pc.project_id FROM project_conversations pc WHERE pc.conversation_id=c.id) project_id
        FROM conversations c WHERE c.tenant_id=? AND c.id=? AND c.owner_user_id=? AND c.status<>'deleted'`),
      file:deps.database.prepare<[TenantId,string,string,string],FileRow>(`SELECT f.id,f.project_id,f.original_name,f.mime_type,f.byte_size,f.sha256,f.extracted_text,f.created_at FROM project_files f JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id WHERE f.tenant_id=? AND f.id=? AND f.project_id=? AND p.owner_user_id=? AND p.deleted_at IS NULL AND p.archived_at IS NULL AND f.deleted_at IS NULL AND f.content_purged_at IS NULL AND f.extraction_status='ready' AND f.extracted_text IS NOT NULL`),
      nextSequence:deps.database.prepare<[TenantId,string],{n:number}>('SELECT COALESCE(MAX(sequence_no),-1)+1 n FROM messages WHERE tenant_id=? AND conversation_id=?'),
      releasedMessage:deps.database.prepare<[TenantId,string],{id:string}>('SELECT id FROM messages WHERE tenant_id=? AND approval_id=? AND role=\'assistant\''),
      reservation:deps.database.prepare<[TenantId,string],{status:string;expires_at:number;metadata_json:string}>('SELECT status,expires_at,metadata_json FROM budget_reservations WHERE tenant_id=? AND id=?'),
      reservationByKey:deps.database.prepare<[TenantId,string],{id:string}>('SELECT id FROM budget_reservations WHERE tenant_id=? AND idempotency_key=?'),
      providerStarts:deps.database.prepare<[TenantId,string],ProviderStartRow>(`SELECT metadata_json FROM audit_events
        WHERE tenant_id=? AND action='chat.provider_called' AND message_id=? ORDER BY sequence DESC`),
      updateRoutingSelection:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions SET selected_model_catalog_id=?,selected_platform_model_version_id=?,selected_provider=?,selected_reasoning_effort=?,
        baseline_platform_model_version_id=?,baseline_cost_microusd=?,credential_source=?,route_reason_json=?,
        status='selected',completed_at_ms=NULL,updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('planned','selected')`) as Database.Statement<[TenantId,...unknown[]]>,
      dispatchRouting:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions SET credential_source=?,status='dispatching',updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='selected'`) as Database.Statement<[TenantId,...unknown[]]>,
      finishRouting:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE routing_decisions SET status=?,completed_at_ms=?,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('planned','selected','dispatching')`) as Database.Statement<[TenantId,...unknown[]]>,
      linkUsageBilling:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE usage_records SET provider_cost_microusd=?,customer_charge_microusd=?,credential_source=?,baseline_cost_microusd=?,savings_microusd=?,platform_model_version_id=?,routing_decision_id=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,
    } as const;
  }

  start():this{if(!this.#stopped){this.wake();}return this;}
  wake():void{
    if(this.#stopped)return;
    if(this.#running){this.#wakePending=true;this.#signalDrain();return;}
    if(this.#timer){if(this.#timerImmediate)return;clearTimeout(this.#timer);this.#timer=null;}
    this.#timerImmediate=true;this.#timer=setTimeout(()=>{this.#timer=null;this.#timerImmediate=false;void this.drainOnce().catch(error=>this.#logger.error('Approval release worker drain failed',this.#code(error))).finally(()=>this.#schedule());},0);this.#timer.unref();
  }
  async stop():Promise<void>{
    this.#stopped=true;this.#wakePending=false;if(this.#timer){clearTimeout(this.#timer);this.#timer=null;this.#timerImmediate=false;}for(const controller of this.#activeControllers)controller.abort();this.#signalDrain();
    try{await this.#running;}finally{if(this.#activeProcesses.size)await Promise.allSettled([...this.#activeProcesses]);this.#key.fill(0);}
  }
  #schedule():void{if(this.#stopped||this.#timer)return;this.#timerImmediate=false;this.#timer=setTimeout(()=>{this.#timer=null;void this.drainOnce().catch(error=>this.#logger.error('Approval release worker drain failed',this.#code(error))).finally(()=>this.#schedule());},this.#pollMs);this.#timer.unref();}

  drainOnce(limit=10):Promise<number>{
    if(this.#running)return this.#running;
    let work:Promise<number>;
    work=this.#drain(limit).finally(()=>{if(this.#running!==work)return;this.#running=null;if(this.#wakePending&&!this.#stopped){this.#wakePending=false;this.wake();}});this.#running=work;return work;
  }

  async #drain(limit:number):Promise<number>{
    if(this.#stopped)return 0;
    let examined=0,handled=0;const seen=new Set<string>(),active=new Set<Promise<void>>(),activeTenants=new Map<TenantId,number>();
    try{
      // A claim starts its lease immediately, so take one only when its process slot is ready.
      while(!this.#stopped&&examined<limit){
        let candidateAvailable=true;
        while(!this.#stopped&&examined<limit&&active.size<this.#concurrency){
          this.#wakePending=false;
          const now=this.#now(),candidates=this.#database.prepare<[number,number,number,number,number,number],{tenant_id:TenantId;id:string;tenant_active:number}>(`WITH active AS (
              SELECT tenant_id,COUNT(*) tenant_active FROM policy_approval_requests
              WHERE status='releasing' AND COALESCE(release_lease_expires_at_ms,0)>? GROUP BY tenant_id
            ), eligible AS (
              SELECT tenant_id,id,created_at_ms,COALESCE(release_next_attempt_at_ms,created_at_ms) ready_at
              FROM policy_approval_requests
              WHERE (status IN ('pending','claimed') AND expires_at_ms<=?)
                OR (status IN ('approved','release_failed') AND COALESCE(release_next_attempt_at_ms,0)<=?)
                OR (status='releasing' AND COALESCE(release_lease_expires_at_ms,0)<=? AND COALESCE(release_next_attempt_at_ms,0)<=?)
            ), ranked AS (
              SELECT e.tenant_id,e.id,e.created_at_ms,e.ready_at,COALESCE(a.tenant_active,0) tenant_active,
                ROW_NUMBER() OVER (PARTITION BY e.tenant_id ORDER BY e.ready_at,e.created_at_ms,e.id) tenant_rank
              FROM eligible e LEFT JOIN active a ON a.tenant_id=e.tenant_id
            )
            SELECT tenant_id,id,tenant_active FROM ranked ORDER BY tenant_active,tenant_rank,ready_at,created_at_ms,id LIMIT ?`).all(now,now,now,now,now,Math.max(limit,seen.size+1));
          let candidate:typeof candidates[number]|undefined,leastGlobal=Number.POSITIVE_INFINITY,leastLocal=Number.POSITIVE_INFINITY;
          for(const row of candidates){
            const key=`${row.tenant_id}:${row.id}`,backoff=this.#finalizeAuditBackoff.get(key);if(seen.has(key)||(backoff&&backoff.nextAt>now))continue;
            if(candidate&&row.tenant_active>leastGlobal)break;
            const tenantLocal=activeTenants.get(row.tenant_id)??0;if(candidate&&row.tenant_active===leastGlobal&&tenantLocal>=leastLocal)continue;
            candidate=row;leastGlobal=row.tenant_active;leastLocal=tenantLocal;if(tenantLocal===0)break;
          }
          if(!candidate){candidateAvailable=false;break;}
          seen.add(`${candidate.tenant_id}:${candidate.id}`);examined++;
          const claim=this.#claim(candidate.tenant_id,candidate.id,now);if(!claim)continue;
          handled++;
          const processTenant=claim.row.tenant_id;activeTenants.set(processTenant,(activeTenants.get(processTenant)??0)+1);
          let process:Promise<void>;
          process=this.#process(claim).catch(error=>this.#logger.error('Approval release failed',claim.row.id,this.#code(error))).finally(()=>{active.delete(process);this.#activeProcesses.delete(process);const remaining=(activeTenants.get(processTenant)??1)-1;if(remaining===0)activeTenants.delete(processTenant);else activeTenants.set(processTenant,remaining);});
          active.add(process);this.#activeProcesses.add(process);
        }
        if(active.size===0)break;
        if(examined>=limit)break;
        if(active.size>=this.#concurrency||candidateAvailable)await Promise.race(active);
        else await this.#waitForProgress(active);
      }
    }finally{if(active.size)await Promise.allSettled([...active]);}
    return handled;
  }

  async #waitForProgress(active:Set<Promise<void>>):Promise<void>{
    let resolveWake!:()=>void,pollTimer!:NodeJS.Timeout;
    const wake=new Promise<void>(resolve=>{resolveWake=resolve;this.#drainWake=resolve;if(this.#wakePending){this.#drainWake=null;resolve();}});
    const poll=new Promise<void>(resolve=>{pollTimer=setTimeout(resolve,this.#pollMs);pollTimer.unref();});
    try{await Promise.race([...active,wake,poll]);}finally{clearTimeout(pollTimer);if(this.#drainWake===resolveWake)this.#drainWake=null;}
  }
  #signalDrain():void{const wake=this.#drainWake;if(!wake)return;this.#drainWake=null;wake();}

  #claim(tenantId:TenantId,id:string,now:number):Claimed|null{
    const db=forTenant({tenantId});
    const claimed=this.#audit.transact(tx=>{
      const row=db.get(this.#q.load,id);if(!row)return null;
      if(row.expires_at_ms<=now&&row.provider_started_at_ms===null){this.#expire(db,row,now,tx);return null;}
      if(row.status==='releasing'&&row.release_lease_expires_at_ms!==null&&row.release_lease_expires_at_ms>now)return null;
      if(row.status==='releasing'&&row.provider_started_at_ms!==null&&row.result_ciphertext===null){this.#settleUnknownReservation(db,row,now);this.#indeterminate(db,row,now,tx,'worker_lost_after_dispatch');return null;}
      if(!['approved','release_failed','releasing'].includes(row.status))return null;
      const resumeFinalize=row.status==='releasing'&&row.result_ciphertext!==null;
      if(!resumeFinalize&&!['open','triaged','in_review'].includes(row.violation_status)){this.#cancel(db,row,now,tx,'approval_violation_changed');return null;}
      if(!resumeFinalize&&row.release_attempts>=MAX_ATTEMPTS){this.#cancel(db,row,now,tx,'attempt_limit');return null;}
      const finalizeTerminal=resumeFinalize&&row.release_finalize_attempts>=MAX_FINALIZE_ATTEMPTS,stalePredispatch=row.status==='releasing'&&!resumeFinalize,attempt=resumeFinalize?row.release_attempts:row.release_attempts+1,leaseOwner=randomUUID();
      const releaseRunId=row.release_run_id??randomUUID(),releaseUserMessageId=row.release_user_message_id??randomUUID(),releaseMessageId=row.release_message_id??randomUUID();
      const supersededReservationId=stalePredispatch?(row.release_reservation_id??db.get(this.#q.reservationByKey,`approval:${id}:attempt:${row.release_attempts}`)?.id??null):null;
      const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
        SET status='releasing',release_attempts=?,release_lease_owner=?,release_lease_expires_at_ms=?,release_phase=?,release_next_attempt_at_ms=NULL,
          release_reservation_id=?,provider_started_at_ms=?,release_finalize_attempts=?,
          release_run_id=COALESCE(release_run_id,?),release_user_message_id=COALESCE(release_user_message_id,?),release_message_id=COALESCE(release_message_id,?),version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND (status IN ('approved','release_failed') OR (status='releasing' AND COALESCE(release_lease_expires_at_ms,0)<=?))`) as Database.Statement<[TenantId,...unknown[]]>,attempt,leaseOwner,now+this.#leaseMs,resumeFinalize?'result_checkpointed':'claimed',resumeFinalize?row.release_reservation_id:null,resumeFinalize?row.provider_started_at_ms:null,resumeFinalize?(finalizeTerminal?row.release_finalize_attempts:row.release_finalize_attempts+1):0,releaseRunId,releaseUserMessageId,releaseMessageId,id,row.version,now);
      if(changed.changes!==1)return null;
      tx.append({tenantId,action:'gate.approval_claimed',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'approval',id},outcome:'pending',context:{requestId:`approval:${id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'require_approval',detector:row.detector,metadata:{approvalId:id,previousAssigneeId:row.release_lease_owner,releaseAttempt:attempt}});
      return {row:{...row,status:'releasing',release_attempts:attempt,release_lease_owner:leaseOwner,release_lease_expires_at_ms:now+this.#leaseMs,release_next_attempt_at_ms:null,release_phase:resumeFinalize?'result_checkpointed':'claimed',release_reservation_id:resumeFinalize?row.release_reservation_id:null,provider_started_at_ms:resumeFinalize?row.provider_started_at_ms:null,release_finalize_attempts:resumeFinalize?(finalizeTerminal?row.release_finalize_attempts:row.release_finalize_attempts+1):0,release_run_id:releaseRunId,release_user_message_id:releaseUserMessageId,release_message_id:releaseMessageId,version:row.version+1},leaseOwner,attempt,supersededReservationId,finalizeTerminal};
    });
    if(claimed){this.#finalizeAuditBackoff.delete(`${tenantId}:${id}`);if(claimed.supersededReservationId)this.#ledger.release(claimed.supersededReservationId,'superseded approval release attempt',now);}
    return claimed;
  }

  async #process(claim:Claimed):Promise<void>{
    let prepared:Prepared|undefined,streamLeaseId:string|undefined,checkpointed=false,providerStarted=false;
    let observedUsage:Usage|null=null,observedProviderRequestId:string|null=null,providerRequest:ChatRequest|null=null,observedOutputUtf8Bytes=0;
    const controller=new AbortController();this.#activeControllers.add(controller);
    const heartbeat=setInterval(()=>{try{const now=this.#now();this.#heartbeat(claim,now);if(prepared&&!this.#ledger.heartbeat(prepared.reservation.reservationId,now))throw new PredispatchError('approval_dispatch_without_reservation');if(streamLeaseId)this.#rates.heartbeat(streamLeaseId,now);}catch(error){this.#logger.warn('Approval release lease heartbeat failed',claim.row.id,this.#code(error));controller.abort();}},Math.max(1_000,Math.floor(this.#leaseMs/3)));heartbeat.unref();
    try{
      if(claim.row.result_ciphertext){checkpointed=true;const result=this.#openResult(claim.row);if(claim.finalizeTerminal){this.#settleResult(claim.row,result);this.#terminalizeFinalizeLimit(claim);return;}await this.#finalize(claim,result);return;}
      prepared=await this.#prepare(claim,controller.signal);
      const ratePolicy=this.#rates.effectivePolicy(prepared.subject.tenantId,prepared.subject.userId,prepared.subject.groupIds);
      const requestDecision=this.#rates.consumeRequest(prepared.subject.tenantId,prepared.subject.userId,ratePolicy,this.#now());
      if(!requestDecision.allowed)throw new PredispatchError('request_rate_limited');
      streamLeaseId=this.#rates.acquireStream(prepared.subject.tenantId,prepared.subject.userId,prepared.reservation.reservationId,ratePolicy,this.#now()).id;
      const request=this.#providerRequest(prepared,claim,controller.signal);providerRequest=request;
      const resolved=this.#providerResolution(claim.row.tenant_id,prepared.model.provider_key,prepared.credentialSource);if(!resolved.provider.configured)throw new PredispatchError('provider_unavailable');prepared.credentialSource=resolved.credentialSource;
      this.#markProviderStarted(claim,prepared,this.#now(),resolved.credentialSource);providerStarted=true;
      const provider=resolved.provider;
      const outputChunks:string[]=[];let outputCodePoints=0,usage:Usage|null=null,finishReason:string|null=null;
      const iterator=provider.stream(request)[Symbol.asyncIterator](),deadline=Date.now()+this.#providerTimeoutMs;
      while(true){
        const next=await this.#providerNext(iterator,controller,deadline);if(next.done)break;const event=next.value;
        if(event.type==='start')observedProviderRequestId=event.providerRequestId??event.requestId;
        else if(event.type==='text_delta'){
          observedOutputUtf8Bytes+=Buffer.byteLength(event.delta,'utf8');if(!Number.isSafeInteger(observedOutputUtf8Bytes))throw new Error('provider_response_too_large');
          for(const _codePoint of event.delta)outputCodePoints++;
          if(outputCodePoints>this.#maxResponseCodePoints){controller.abort();void iterator.return?.();throw new Error('provider_response_too_large');}
          outputChunks.push(event.delta);
        }
        else if(event.type==='usage'){usage=event.usage;observedUsage=event.usage;}
        else if(event.type==='finish')finishReason=event.reason;
        else if(event.type==='error')throw event.error;
      }
      const output=outputChunks.join('');usage??=estimateUsage(request,output);observedUsage=usage;
      const postflight=await this.#postflight(prepared,claim,output,controller.signal);
      const result:ApprovalReleaseResultV1={schemaVersion:1,tenantId:claim.row.tenant_id,approvalId:claim.row.id,
        outputText:postflight.withheld?'Response withheld by policy':postflight.text,providerRequestId:observedProviderRequestId,finishReason,
        usage:{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens,estimated:usage.estimated},
        files:prepared.fileResults,
        preflight:this.#decisionResult(prepared.verdict,prepared.payload,protectedContentDigest(this.#key,claim.row.tenant_id,this.#messagesText(prepared.payload.messages))),
        postflight:{evaluationId:postflight.verdict.evaluationId,action:postflight.verdict.action,ruleIds:this.#ruleIds(postflight.verdict),detectorKeys:this.#detectors(postflight.verdict),protectedItemCount:postflight.verdict.redactions.length+postflight.verdict.masks.length,contentDigest:protectedContentDigest(this.#key,claim.row.tenant_id,output),latencyMs:Math.ceil(postflight.verdict.timings.totalUs/1000),withheld:postflight.withheld,policyFingerprint:postflight.policyFingerprint,groupIds:postflight.subject.groupIds,roles:postflight.subject.roles}};
      this.#checkpoint(claim,result);checkpointed=true;
      await this.#finalize(claim,result);
    }catch(error){
      if(error instanceof ReleaseTerminalError){if(!providerStarted&&prepared?.reservation)this.#ledger.release(prepared.reservation.reservationId,'approval release stopped at dispatch fence',this.#now());return;}
      if(checkpointed){this.#markFinalizeFailure(claim,error);throw error;}
      if(providerStarted){
        if(prepared?.reservation)this.#settleFailure(prepared,error,observedUsage,observedProviderRequestId,providerRequest,observedOutputUtf8Bytes);
        this.#markIndeterminate(claim,error);
      }else{
        if(prepared?.reservation)this.#ledger.release(prepared.reservation.reservationId,'approval release failed before provider dispatch',this.#now());
        this.#markPredispatchFailure(claim,error);
      }
    }finally{clearInterval(heartbeat);controller.abort();this.#activeControllers.delete(controller);if(streamLeaseId)this.#rates.releaseStream(streamLeaseId,this.#now());}
  }

  async #prepare(claim:Claimed,signal:AbortSignal):Promise<Prepared>{
    const row=this.#fresh(claim),payload=this.#open(row),db=forTenant({tenantId:row.tenant_id});
    let route:RoutingDecisionRow|null=null,routeSelection:SingleRouteSelection|null=null;
    let credentialSource:'platform'|'byok'|'legacy_unknown'='legacy_unknown';
    try{
    if(row.routing_decision_id){
      route=db.get(this.#q.route,row.routing_decision_id)??null;
      if(!route||route.run_id!==payload.runId||route.user_id!==row.requesting_user_id||route.conversation_id!==payload.conversationId||route.assistant_message_id!==payload.assistantMessageId||!['planned','selected'].includes(route.status))return this.#terminal(claim,'cancelled','model_unavailable');
      if(route.mode==='multi_model')return this.#terminal(claim,'cancelled','multi_model_approval_unsupported');
    }
    const conversation=db.get(this.#q.conversation,payload.conversationId,row.requesting_user_id);
    if(!conversation)return this.#terminal(claim,'cancelled','conversation_unavailable');
    const groupIds=db.all(this.#q.groups,row.requesting_user_id).map(value=>value.group_id);
    const roles=db.all(this.#q.roles,row.requesting_user_id).map(value=>value.role).filter((value):value is GatePrincipalRole=>['owner','admin','compliance','member'].includes(value));
    const subject:Subject={tenantId:row.tenant_id,userId:row.requesting_user_id,groupIds,roles};
    let model:ModelRow|undefined;
    if(route){
      const taskText=`${this.#messagesText(payload.messages.slice(-1))}\n${(payload.attachments??[]).map(item=>item.extractedText).join('\n')}`;
      const estimatedInput=estimateRequiredInputTokens(this.#messagesText(payload.messages)+(payload.attachments??[]).map(item=>item.extractedText).join('\n')),now=this.#now();
      const candidates=loadRoutingCandidates(this.#database,{tenantId:row.tenant_id,userId:row.requesting_user_id,inputTokens:estimatedInput,outputTokens:this.#routingOutputEstimate(payload),now});
      const anchoredProvider=route.requested_provider??(['openai','anthropic','google','xai'].includes(route.selected_provider??'')?route.selected_provider as DirectUsVendorProvider:null);
      const intent={mode:route.mode as 'auto'|'single',effort:route.requested_effort,...(anchoredProvider?{preferredProvider:anchoredProvider}:{}),...(route.requested_model_catalog_id?{preferredTenantModelId:route.requested_model_catalog_id}:{}),vendorJurisdiction:route.vendor_jurisdiction_constraint,processingRegion:route.processing_region_constraint,
        taskText,stableRoutingKey:`${row.tenant_id}:${row.requesting_user_id}:${payload.conversationId}`} as const;
      routeSelection=selectSingleRoute(intent,candidates);
      model=db.get(this.#q.model,routeSelection.selected.tenantModelId);
      if(!model||model.platform_model_version_id!==routeSelection.selected.platformModelVersionId||model.provider_key!==routeSelection.selected.provider||model.model_key!==routeSelection.selected.providerModel)throw new PredispatchError('model_unavailable');
      credentialSource=routeSelection.selected.credentialSource;
    }else return this.#terminal(claim,'cancelled','model_unavailable');
    if(!model)return this.#terminal(claim,'cancelled','model_unavailable');
    const capabilities=JSON.parse(model.capabilities_json) as unknown;
    const reasoningEffort=routeSelection?.reasoningEffort??payload.model.reasoningEffort;
    if(reasoningEffort!=='none'&&!supportsReasoningEffort(model.provider_key,model.model_key,Array.isArray(capabilities)?capabilities.map(String):[]))return this.#terminal(claim,'cancelled','reasoning_unavailable');
    let provider:ChatProvider;try{provider=this.#providerResolution(row.tenant_id,model.provider_key,credentialSource).provider;}catch{return this.#terminal(claim,'cancelled','provider_unavailable');}if(!provider.configured)return this.#terminal(claim,'cancelled','provider_unavailable');
    const parts=this.#parts(payload.messages,payload.role,payload.tone,payload.assistantPrompt,payload.assistantId),outboundPolicy=this.#policy(db,subject,model.id,'preflight',['outbound']);
    const attachments=payload.attachments??[],filePolicy=this.#policy(db,subject,model.id,'preflight',['file']);
    if(attachments.length&&(attachments.some(attachment=>attachment.projectId!==attachments[0]!.projectId)||conversation.project_id!==attachments[0]!.projectId))return this.#terminal(claim,'cancelled','attachment_project_changed');
    const currentFingerprint=this.#combinedPolicyFingerprint(outboundPolicy,filePolicy);
    const approvedRules=new Set(this.#jsonIds(row.rule_ids_json)),currentAttachments:{attachment:ApprovalAttachmentV1;part:GateContext['parts'][number]}[]=[];
    for(const attachment of attachments){
      const current=db.get(this.#q.file,attachment.fileId,attachment.projectId,row.requesting_user_id);
      if(!current)return this.#terminal(claim,'cancelled','attachment_unavailable');
      if(current.original_name!==attachment.name||current.mime_type!==attachment.mimeType||current.byte_size!==attachment.byteSize||current.sha256!==attachment.sha256||current.extracted_text!==attachment.extractedText||current.created_at!==attachment.createdAtMs)return this.#terminal(claim,'cancelled','attachment_changed');
      const filePart={id:`file:${attachment.fileId}`,source:'file_extraction' as const,text:attachment.extractedText,mimeType:attachment.mimeType,fileId:attachment.fileId,provenance:{projectId:attachment.projectId,fileName:attachment.name,sha256:attachment.sha256}};
      currentAttachments.push({attachment,part:filePart});
    }
    let authorizedAttachments:{attachment:ApprovalAttachmentV1;text:string;verdict:GateVerdict}[]=[];
    if(currentAttachments.length){
      const fileParts=currentAttachments.map(item=>item.part),projectId=currentAttachments.every(item=>item.attachment.projectId===currentAttachments[0]!.attachment.projectId)?currentAttachments[0]!.attachment.projectId:null;
      const full=await this.#evaluate(this.#gateContext(row,payload,subject,model,'preflight',fileParts,filePolicy,'file_recheck',signal,projectId));
      const authorizedFiles=await this.#authorizeDirection(claim,row,payload,subject,model,'file',fileParts,filePolicy,full,currentFingerprint,approvedRules,signal,projectId);
      const authorizedByFile=new Map((authorizedFiles.providerParts??[]).filter(part=>part.fileId!==null).map(part=>[part.fileId!,part.text]));
      authorizedAttachments=currentAttachments.map(({attachment})=>{const text=authorizedByFile.get(attachment.fileId);if(text===undefined)throw new PredispatchError('gate_omitted_attachment');return{attachment,text,verdict:authorizedFiles};});
    }
    const full=await this.#evaluate(this.#gateContext(row,payload,subject,model,'preflight',parts,outboundPolicy,'outbound_recheck',signal));
    const authorized=await this.#authorizeDirection(claim,row,payload,subject,model,'outbound',parts,outboundPolicy,full,currentFingerprint,approvedRules,signal);
    const authorizedByMessage=new Map((authorized.providerParts??[]).map(part=>[part.id,part.text]));
    if(payload.messages.some((_message,index)=>!authorizedByMessage.has(`message:${index}`)))throw new PredispatchError('approval_payload_invalid');
    const authorizedMessages:ChatMessage[]=payload.messages.map((message,index)=>({...message,content:[{type:'text' as const,text:authorizedByMessage.get(`message:${index}`)!}]}));
    const authorizedPrompt=authorizedByMessage.get(`message:${payload.messages.length-1}`)!;
    const assembled=assembleAuthorizedProviderContext({messages:authorizedMessages,attachments:authorizedAttachments.map(({attachment,text})=>({id:attachment.fileId,text})),modelContextWindow:model.context_window,configuredMaxOutput:model.max_output_tokens});
    const systemText=[authorizedByMessage.get('system:assistant'),authorizedByMessage.get('system:persona')].filter((part):part is string=>part!==undefined).join('\n\n');
    const messages:readonly ChatMessage[]=systemText?[{role:'system',content:[{type:'text',text:systemText}]},...assembled.messages]:assembled.messages;
    const fileResults=authorizedAttachments.map(({attachment,verdict},index)=>({...this.#decisionResult(index===0?verdict:{...verdict,evaluationId:randomUUID()},payload,protectedContentDigest(this.#key,row.tenant_id,attachment.extractedText)),fileId:attachment.fileId,projectId:attachment.projectId}));
    const estimate=estimateRequiredInputTokens(this.#messagesText(messages));
    if(!row.release_message_id||!row.release_user_message_id||!row.release_run_id)throw new PredispatchError('release_identity_missing');
    const reservation=this.#ledger.reserve({idempotencyKey:`approval:${row.id}:attempt:${claim.attempt}`,tenantId:row.tenant_id,userId:row.requesting_user_id,groupIds,conversationId:payload.conversationId,messageId:row.release_message_id,modelId:model.id,provider:model.provider_key,estimatedInputTokens:estimate,requestedMaxOutputTokens:model.max_output_tokens,now:this.#now()});
    try{
      const refreshed=this.#recordPreparation(claim,payload,authorized,reservation,assembled.attachmentContextTruncated,routeSelection);
      if(routeSelection&&route)route={...route,selected_model_catalog_id:routeSelection.selected.tenantModelId,selected_platform_model_version_id:routeSelection.selected.platformModelVersionId,selected_provider:routeSelection.selected.provider,selected_reasoning_effort:routeSelection.reasoningEffort,baseline_platform_model_version_id:routeSelection.baseline.platformModelVersionId,credential_source:routeSelection.selected.credentialSource,status:'selected'};
      return {row:refreshed,payload,subject,model,projectId:conversation.project_id,verdict:authorized,fileResults,messages,authorizedPrompt,policyFingerprint:currentFingerprint,attachmentContextTruncated:assembled.attachmentContextTruncated,reservation,route,routeSelection,credentialSource};
    }catch(error){this.#ledger.release(reservation.reservationId,'approval preparation did not commit',this.#now());throw error;}
    }catch(error){throw error;}
  }

  #recordPreparation(claim:Claimed,payload:ApprovalEnvelopePayloadV1,verdict:GateVerdict,reservation:ReservationGrant,attachmentContextTruncated:boolean,selection:SingleRouteSelection|null):ApprovalRow{
    const db=forTenant({tenantId:claim.row.tenant_id}),now=this.#now();
    return this.#audit.transact(tx=>{
      const row=db.get(this.#q.load,claim.row.id);this.#assertLease(row,claim);
      if(selection){
        if(!row!.routing_decision_id)throw new Error('approval_release_fence_lost');
        const routed=db.run(this.#q.updateRoutingSelection,selection.selected.tenantModelId,selection.selected.platformModelVersionId,selection.selected.provider,selection.reasoningEffort,
          selection.baseline.platformModelVersionId,selection.baselineCostMicrousd,
          selection.selected.credentialSource,JSON.stringify(selection.reasons),now,row!.routing_decision_id);
        if(routed.changes!==1)throw new Error('approval_release_fence_lost');
      }
      const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
        SET release_reservation_id=?,release_phase='prepared',version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,reservation.reservationId,row!.id,claim.leaseOwner);
      if(changed.changes!==1)throw new Error('approval_release_fence_lost');
      tx.append({tenantId:row!.tenant_id,action:'gate.released_content_rechecked',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'approval',id:row!.id},outcome:'success',context:{requestId:`approval:${row!.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row!.requesting_user_id,groupId:row!.group_id,conversationId:payload.conversationId,messageId:row!.release_user_message_id,modelId:selection?.selected.tenantModelId??payload.model.catalogId,providerId:selection?.selected.provider??payload.model.provider,gateAction:verdict.action,metadata:{approvalId:row!.id,originalRuleSetRevision:row!.policy_revision,currentRuleSetRevision:this.#revision(verdict),result:'authorized',attachmentContextTruncated,routeDecisionId:row!.routing_decision_id}});
      return {...row!,release_reservation_id:reservation.reservationId,release_phase:'prepared',version:row!.version+1};
    });
  }

  #providerRequest(prepared:Prepared,claim:Claimed,signal:AbortSignal):ChatRequest{
    return {context:{requestId:`approval:${claim.row.id}`,streamId:prepared.row.release_run_id!,tenantId:prepared.subject.tenantId,userId:prepared.subject.userId,groupIds:prepared.subject.groupIds,conversationId:prepared.payload.conversationId,sourceMessageId:prepared.row.release_user_message_id!,locale:'en'},provider:prepared.model.provider_key,protocol:this.#protocol(prepared.model.provider_key),model:prepared.model.model_key,messages:prepared.messages,tools:[],toolChoice:'none',maxOutputTokens:prepared.reservation.allowedMaxOutputTokens,reasoningEffort:prepared.routeSelection?.reasoningEffort??prepared.payload.model.reasoningEffort,stop:[],metadata:{approvalId:claim.row.id,idempotencyKey:`approval:${claim.row.id}:attempt:${claim.attempt}`},signal};
  }

  async #authorizeDirection(claim:Claimed,row:ApprovalRow,payload:ApprovalEnvelopePayloadV1,subject:Subject,model:ModelRow,direction:'outbound'|'file',parts:GateContext['parts'],policy:ResolvedPolicySnapshot,full:GateVerdict,currentFingerprint:string,approvedRules:ReadonlySet<string>,signal:AbortSignal,projectId:string|null=null):Promise<GateVerdict>{
    if(full.matches.some(match=>match.action==='block'))return this.#policyDenied(claim,full,'current_policy_block');
    const fingerprintMatches=currentFingerprint===payload.policy.fingerprint;
    const approvedHere=row.violation_direction===direction;
    const confirmed=payload.confirmedWarnings?.find(item=>item.direction===direction);
    const confirmedRules=confirmed?.policyFingerprint===currentFingerprint&&fingerprintMatches?new Set(confirmed.ruleIds):new Set<string>();
    const required=full.matches.filter(match=>match.action==='require_approval');
    if(required.length&&(!fingerprintMatches||!approvedHere||required.some(match=>!approvedRules.has(match.ruleId))))return this.#policyDenied(claim,full,'policy_changed');
    const warnings=full.matches.filter(match=>match.action==='warn');
    if(warnings.some(match=>!(approvedHere&&approvedRules.has(match.ruleId))&&!confirmedRules.has(match.ruleId)))return this.#policyDenied(claim,full,fingerprintMatches?'current_policy_denied':'policy_changed');
    let authorized=full;
    const exemptRules=new Set<string>([...(approvedHere?approvedRules:[]),...confirmedRules]);
    if((required.length||warnings.length)&&exemptRules.size){
      const remaining={...policy,rules:policy.rules.filter(rule=>!exemptRules.has(rule.id))};
      authorized=await this.#evaluate(this.#gateContext(row,payload,subject,model,'preflight',parts,remaining,`${direction}_authorized`,signal,projectId));
    }
    if(['block','require_approval','warn'].includes(authorized.action))return this.#policyDenied(claim,authorized,'current_policy_denied');
    assertProviderTransportAuthorized(authorized);return authorized;
  }

  async #providerNext(iterator:AsyncIterator<import('../../lib/providers/types.js').StreamEvent>,controller:AbortController,deadline:number):Promise<IteratorResult<import('../../lib/providers/types.js').StreamEvent>>{
    const remaining=Math.max(0,deadline-Date.now());
    let timer:NodeJS.Timeout|undefined,onAbort:()=>void=()=>{},closed=false;
    const close=()=>{if(closed)return;closed=true;try{const result=iterator.return?.();if(result)void result.catch(()=>undefined);}catch{/* best effort: the dispatch outcome remains indeterminate */}};
    // This timer is the completion mechanism for an upstream iterator that may ignore aborts. Keep
    // it referenced until the race settles so a quiet worker cannot abandon the pending release.
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(new Error('provider_timeout'));close();controller.abort();},remaining);});
    const aborted=new Promise<never>((_resolve,reject)=>{onAbort=()=>{close();reject(new Error('provider_aborted'));};controller.signal.addEventListener('abort',onAbort,{once:true});});
    try{return await Promise.race([iterator.next(),timeout,aborted]);}
    finally{if(timer)clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);}
  }

  async #evaluate(context:GateContext):Promise<GateVerdict>{
    if(context.abortSignal.aborted)throw new PredispatchError('worker_aborted');
    let onAbort:()=>void=()=>{};
    const aborted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new PredispatchError('worker_aborted'));context.abortSignal.addEventListener('abort',onAbort,{once:true});});
    try{return await Promise.race([this.#gate.evaluate(context),aborted]);}
    finally{context.abortSignal.removeEventListener('abort',onAbort);}
  }

  async #postflight(prepared:Prepared,claim:Claimed,output:string,signal:AbortSignal):Promise<{verdict:GateVerdict;text:string;withheld:boolean;policyFingerprint:string;subject:Subject}>{
    const db=forTenant({tenantId:claim.row.tenant_id}),groupIds=db.all(this.#q.groups,claim.row.requesting_user_id).map(value=>value.group_id),roles=db.all(this.#q.roles,claim.row.requesting_user_id).map(value=>value.role).filter((value):value is GatePrincipalRole=>['owner','admin','compliance','member'].includes(value)),subject:Subject={tenantId:claim.row.tenant_id,userId:claim.row.requesting_user_id,groupIds,roles},policy=this.#policy(db,subject,prepared.model.id,'postflight',['inbound']);
    const part={id:prepared.row.release_message_id!,source:'provider_response' as const,text:output,mimeType:'text/plain',fileId:null,provenance:{approvalId:claim.row.id}};
    const verdict=await this.#evaluate(this.#gateContext(claim.row,prepared.payload,subject,prepared.model,'postflight',[part],policy,'postflight',signal));
    const withheld=['block','require_approval','warn'].includes(verdict.action),text=withheld?'':verdict.displayParts?.[0]?.text??output;
    return {verdict,text,withheld,policyFingerprint:policy.fingerprint,subject};
  }

  #checkpoint(claim:Claimed,result:ApprovalReleaseResultV1):void{
    const sealed=sealApprovalResult(this.#key,result,{cryptoScheme:claim.row.payload_crypto_scheme,keyVersion:claim.row.key_version,
      wrappedDek:claim.row.payload_wrapped_dek,wrapNonce:claim.row.payload_wrap_nonce,kekVersion:claim.row.payload_kek_version}),db=forTenant({tenantId:claim.row.tenant_id});
    const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
      SET result_ciphertext=?,result_nonce=?,result_digest=?,release_phase='result_checkpointed',release_finalize_attempts=1,release_next_attempt_at_ms=NULL,release_lease_expires_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,sealed.ciphertext,sealed.nonce,sealed.digest,this.#now()+this.#leaseMs,claim.row.id,claim.leaseOwner);
    if(changed.changes!==1)throw new Error('approval_release_fence_lost');
  }

  async #finalize(claim:Claimed,result:ApprovalReleaseResultV1):Promise<void>{
    const row=this.#fresh(claim),reservationId=row.release_reservation_id,messageId=row.release_message_id,userMessageId=row.release_user_message_id;if(!reservationId||!messageId||!userMessageId)throw new Error('approval_release_not_prepared');
    const settlement=this.#settleResult(row,result),settled=settlement.settled;
    const db=forTenant({tenantId:row.tenant_id}),now=this.#now(),payload=this.#open(row);
    this.#audit.transact(tx=>{
      const current=db.get(this.#q.load,row.id);this.#assertLease(current,claim);
      if(!['open','triaged','in_review'].includes(current!.violation_status)){
        const terminal=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='release_indeterminate',release_phase='finalize_state_changed',release_error_code='approval_violation_changed',release_lease_owner=NULL,release_lease_expires_at_ms=NULL,release_next_attempt_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,now,current!.id,current!.version,claim.leaseOwner);
        if(terminal.changes!==1)throw new Error('approval_release_fence_lost');
        this.#finishTerminal(db,current!,now,'approval_violation_changed',false);tx.append(this.#failureEvent(current!,now,'approval_violation_changed',claim.attempt));return;
      }
      if(!this.#postflightFenceMatches(db,current!,result,settlement.model.id)){
        const terminal=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='release_indeterminate',release_phase='postflight_policy_changed',release_error_code='postflight_policy_changed',release_lease_owner=NULL,release_lease_expires_at_ms=NULL,release_next_attempt_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,now,current!.id,current!.version,claim.leaseOwner);
        if(terminal.changes!==1)throw new Error('approval_release_fence_lost');
        this.#finishTerminal(db,current!,now,'postflight_policy_changed',false);tx.append(this.#failureEvent(current!,now,'postflight_policy_changed',claim.attempt));return;
      }
      const part=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0`) as Database.Statement<[TenantId,...unknown[]]>,result.outputText,result.postflight.action==='redact'?'redacted_text':'text',messageId);
      if(part.changes!==1)throw new Error('approval_release_message_conflict');
      const message=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status=?,input_tokens=?,output_tokens=?,cost_microusd=?,policy_action=?,protected_item_count=?,provider_request_id=?,finish_reason=?,completed_at=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='pending' AND approval_id=?`) as Database.Statement<[TenantId,...unknown[]]>,result.postflight.withheld?'blocked':'complete',settled.chargedInputTokens,settled.chargedOutputTokens,settlement.providerCostMicrousd,result.postflight.withheld?result.postflight.action:'require_approval',result.postflight.protectedItemCount,result.providerRequestId,result.finishReason??'stop',now,messageId,row.id);
      if(message.changes!==1)throw new Error('approval_release_message_conflict');
      this.#insertDecision(db,row,result.preflight,userMessageId,'outbound','approved',now);
      for(const file of result.files)this.#insertDecision(db,row,file,userMessageId,'file','final',now,file.fileId);
      this.#insertDecision(db,row,result.postflight,messageId,'inbound','final',now);
      if(result.postflight.action!=='allow')this.#insertPostflightViolation(db,row,result,tx,now);
      const approval=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='released',released_at_ms=?,payload_terminal_at_ms=?,release_phase='completed',release_error_code=NULL,
        release_lease_owner=NULL,release_lease_expires_at_ms=NULL,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,now,now,row.id,claim.leaseOwner);
      if(approval.changes!==1)throw new Error('approval_release_fence_lost');
      const violation=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET status='approved',version=version+1,updated_at_ms=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND approval_id=? AND version=? AND status IN ('open','triaged','in_review')`) as Database.Statement<[TenantId,...unknown[]]>,now,row.violation_id,row.id,current!.violation_version);
      if(violation.changes!==1)throw new Error('approval_violation_changed');
      if(row.routing_decision_id&&db.run(this.#q.finishRouting,'completed',now,now,row.routing_decision_id).changes!==1)throw new Error('approval_release_fence_lost');
      completeApprovalRun({database:this.#database,db,tenantId:row.tenant_id,requestingUserId:row.requesting_user_id,sourceMessageId:row.message_id!,approvalId:row.id,decisionId:result.postflight.evaluationId,action:result.postflight.action,protectedItemCount:result.postflight.protectedItemCount,releaseUserMessageId:userMessageId,releaseMessageId:messageId,content:result.outputText,createdAt:now,modelId:settlement.model.id,provider:settlement.model.provider_key,inputTokens:settled.chargedInputTokens,outputTokens:settled.chargedOutputTokens,costMicrousd:settlement.customerChargeMicrousd,now});
      tx.append({tenantId:row.tenant_id,action:'gate.approval_released',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'approval',id:row.id},outcome:'success',context:{requestId:`approval:${row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:payload.conversationId,messageId,modelId:settlement.model.id,providerId:settlement.model.provider_key,gateAction:'require_approval',metadata:{approvalId:row.id,reviewNoteLength:row.decision_note?.length??0,originalDigest:row.payload_digest,releaseAttempt:claim.attempt,responseWithheld:result.postflight.withheld,routeDecisionId:row.routing_decision_id}});
      tx.append({tenantId:row.tenant_id,action:result.postflight.withheld?'chat.message_stopped':'chat.message_completed',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'message',id:messageId},outcome:result.postflight.withheld?'denied':'success',context:{requestId:`approval:${row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,conversationId:payload.conversationId,messageId,modelId:settlement.model.id,providerId:settlement.model.provider_key,metadata:{approvalId:row.id,inputTokens:settled.chargedInputTokens,outputTokens:settled.chargedOutputTokens,costUsdMicros:settlement.providerCostMicrousd,providerCostMicrousd:settlement.providerCostMicrousd,savingsMicrousd:settlement.savingsMicrousd,credentialSource:settlement.credentialSource}});
    });
  }

  #settleResult(row:ApprovalRow,result:ApprovalReleaseResultV1):ApprovalSettlement{return this.#settleUsage(row,result.usage,result.providerRequestId,result.finishReason,'complete',result.usage.outputTokens);}

  #postflightFenceMatches(db:TenantDb,row:ApprovalRow,result:ApprovalReleaseResultV1,modelId:string):boolean{
    const groupIds=db.all(this.#q.groups,row.requesting_user_id).map(value=>value.group_id),roles=db.all(this.#q.roles,row.requesting_user_id).map(value=>value.role).filter((value):value is GatePrincipalRole=>['owner','admin','compliance','member'].includes(value));
    if(!this.#sameStrings(groupIds,result.postflight.groupIds)||!this.#sameStrings(roles,result.postflight.roles))return false;
    try{return this.#policy(db,{tenantId:row.tenant_id,userId:row.requesting_user_id,groupIds,roles},modelId,'postflight',['inbound']).fingerprint===result.postflight.policyFingerprint;}
    catch{return false;}
  }

  #terminalizeFinalizeLimit(claim:Claimed):void{
    const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now();
    this.#audit.transact(tx=>{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='release_indeterminate',release_phase='finalize_failed',release_error_code='approval_finalize_failed',release_next_attempt_at_ms=NULL,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,now,row.id,row.version,claim.leaseOwner);if(changed.changes!==1)throw new Error('approval_release_fence_lost');this.#finishTerminal(db,row,now,'approval_finalize_failed',false);tx.append(this.#cancelEvent(row,now,'approval_finalize_failed'));});
  }

  #insertDecision(db:TenantDb,row:ApprovalRow,result:ApprovalReleaseResultV1['preflight']|ApprovalReleaseResultV1['postflight']|ApprovalReleaseResultV1['files'][number],messageId:string,direction:'outbound'|'inbound'|'file',status:string,now:number,fileId:string|null=null):void{
    db.run(this.#database.prepare(`INSERT OR IGNORE INTO gate_decisions(tenant_id,id,user_id,conversation_id,message_id,project_file_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,protected_item_count,redacted_excerpt,latency_ms,cache_hit,decided_at,reviewed_by_user_id,reviewed_at,review_note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,?,?,?,?)`) as Database.Statement<[TenantId,...unknown[]]>,result.evaluationId,row.requesting_user_id,row.conversation_id,messageId,fileId,direction,result.action,status,result.contentDigest,JSON.stringify(result.ruleIds),JSON.stringify(result.detectorKeys),result.protectedItemCount,result.latencyMs,now,status==='approved'?row.decision_by_user_id:null,status==='approved'?now:null,status==='approved'?row.decision_note:null);
  }

  #insertPostflightViolation(db:TenantDb,row:ApprovalRow,result:ApprovalReleaseResultV1,tx:AuditTransaction,now:number):void{
    const id=randomUUID(),action=result.postflight.action,detector=result.postflight.detectorKeys[0]??'gate';
    const receipt=tx.append({tenantId:row.tenant_id,action:result.postflight.withheld?'gate.response_withheld':action==='flag'?'gate.content_flagged':'gate.content_redacted',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'message',id:row.release_message_id},outcome:result.postflight.withheld?'denied':'success',context:{requestId:`approval:${row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.release_message_id,gateAction:action,detector,metadata:{approvalId:row.id,violationId:id,ruleIds:[...result.postflight.ruleIds],providerResponseDigest:result.postflight.contentDigest}});
    db.run(this.#database.prepare(`INSERT INTO policy_violations(tenant_id,id,audit_event_id,approval_id,subject_user_id,group_id,conversation_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?, 'inbound',?,?,?,?,?,?,?,?,?)`) as Database.Statement<[TenantId,...unknown[]]>,id,receipt.id,null,row.requesting_user_id,row.group_id,row.conversation_id,row.release_message_id,detector,action,action==='block'||action==='require_approval'?'high':'medium','open',JSON.stringify(result.postflight.ruleIds),`[${action.toUpperCase()}]`,result.postflight.contentDigest,now,now);
  }

  #markProviderStarted(claim:Claimed,prepared:Prepared,now:number,credentialSource:'platform'|'byok'):void{
    const db=forTenant({tenantId:claim.row.tenant_id});
    let terminalCode:string|null=null;
    const changed=this.#audit.transact(tx=>{
      const row=db.get(this.#q.load,claim.row.id);this.#assertLease(row,claim);
      const fenceCode=this.#dispatchFenceCode(db,row!,prepared,now);
      if(fenceCode){terminalCode=fenceCode;if(fenceCode==='expired')this.#expire(db,row!,now,tx);else this.#cancel(db,row!,now,tx,fenceCode);return 0;}
      if(!this.#ledger.heartbeat(prepared.reservation.reservationId,now)){terminalCode='approval_dispatch_without_reservation';this.#cancel(db,row!,now,tx,terminalCode);return 0;}
      if(row!.routing_decision_id&&db.run(this.#q.dispatchRouting,credentialSource,now,row!.routing_decision_id).changes!==1)throw new Error('approval_release_fence_lost');
      this.#insertDispatchMessages(db,row!,prepared,now);
      const update=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET provider_started_at_ms=?,release_phase='dispatching',release_lease_expires_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing' AND release_lease_owner=? AND provider_started_at_ms IS NULL AND expires_at_ms>? AND release_reservation_id=?`) as Database.Statement<[TenantId,...unknown[]]>,now,now+this.#leaseMs,claim.row.id,row!.version,claim.leaseOwner,now,prepared.reservation.reservationId);
      if(update.changes!==1)throw new Error('approval_release_fence_lost');
      tx.append({tenantId:claim.row.tenant_id,action:'chat.provider_called',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'message',id:prepared.row.release_message_id},outcome:'pending',context:{requestId:`approval:${claim.row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:claim.row.requesting_user_id,conversationId:prepared.payload.conversationId,messageId:prepared.row.release_message_id,modelId:prepared.model.id,providerId:prepared.model.provider_key,metadata:{approvalId:claim.row.id,reservationId:prepared.reservation.reservationId,credentialSource,routeDecisionId:prepared.row.routing_decision_id,releaseAttempt:claim.attempt}});return 1;});
    if(terminalCode)throw new ReleaseTerminalError(terminalCode);
    if(changed!==1)throw new Error('approval_release_fence_lost');
  }

  #dispatchFenceCode(db:TenantDb,row:ApprovalRow,prepared:Prepared,now:number):string|null {
    if(row.expires_at_ms<=now)return'expired';
    if(!['open','triaged','in_review'].includes(row.violation_status))return'approval_violation_changed';
    const conversation=db.get(this.#q.conversation,prepared.payload.conversationId,row.requesting_user_id);if(!conversation||conversation.project_id!==prepared.projectId)return'conversation_unavailable';
    const groupIds=db.all(this.#q.groups,row.requesting_user_id).map(value=>value.group_id),roles=db.all(this.#q.roles,row.requesting_user_id).map(value=>value.role).filter((value):value is GatePrincipalRole=>['owner','admin','compliance','member'].includes(value));
    if(!this.#sameStrings(groupIds,prepared.subject.groupIds)||!this.#sameStrings(roles,prepared.subject.roles))return'unauthorized';
    if(!prepared.route)return'model_unavailable';
    let effective;try{effective=resolveEffectiveModels(this.#database,{tenantId:row.tenant_id,userId:row.requesting_user_id,requestedModelId:prepared.model.id});}catch(error){return this.#code(error);}
    const model=db.get(this.#q.model,prepared.model.id);
    if(!model||!effective.models.some(item=>item.id===model.id)||!this.#sameModel(model,prepared.model))return'model_unavailable';
    const route=row.routing_decision_id?db.get(this.#q.route,row.routing_decision_id):undefined;
    if(!route||route.status!=='selected'||route.selected_model_catalog_id!==model.id||route.selected_platform_model_version_id!==model.platform_model_version_id||route.selected_provider!==model.provider_key)return'model_unavailable';
    try{
      const inputTokens=estimateRequiredInputTokens(this.#messagesText(prepared.messages));
      const live=loadRoutingCandidates(this.#database,{tenantId:row.tenant_id,userId:row.requesting_user_id,inputTokens,outputTokens:this.#routingOutputEstimate(prepared.payload),now})
        .find(candidate=>candidate.tenantModelId===model.id&&candidate.platformModelVersionId===model.platform_model_version_id&&candidate.provider===model.provider_key);
      if(!live)return'model_unavailable';
    }catch(error){return this.#code(error);}
    try{if(!this.#providerResolution(row.tenant_id,model.provider_key,prepared.credentialSource).provider.configured)return'provider_unavailable';}catch{return'provider_unavailable';}
    try{
      const subject:Subject={tenantId:row.tenant_id,userId:row.requesting_user_id,groupIds,roles},outbound=this.#policy(db,subject,model.id,'preflight',['outbound']),file=this.#policy(db,subject,model.id,'preflight',['file']);
      if(this.#combinedPolicyFingerprint(outbound,file)!==prepared.policyFingerprint)return'policy_changed';
      this.#assertAttachmentDispatchFence(db,prepared);
    }catch(error){return this.#code(error)==='approval_release_failed'?'policy_changed':this.#code(error);}
    const reservation=db.get(this.#q.reservation,prepared.reservation.reservationId);
    if(!reservation||reservation.status!=='active'||reservation.expires_at<=now||row.release_reservation_id!==prepared.reservation.reservationId)return'approval_dispatch_without_reservation';
    return null;
  }

  #assertAttachmentDispatchFence(db:TenantDb,prepared:Prepared):void {
    const attachments=prepared.payload.attachments??[];if(!attachments.length)return;
    const projectId=attachments[0]!.projectId;
    if(prepared.projectId!==projectId||attachments.some(attachment=>attachment.projectId!==projectId))throw new PredispatchError('attachment_project_changed');
    for(const attachment of attachments){
      const current=db.get(this.#q.file,attachment.fileId,attachment.projectId,prepared.row.requesting_user_id);
      if(!current||current.original_name!==attachment.name||current.mime_type!==attachment.mimeType||current.byte_size!==attachment.byteSize||current.sha256!==attachment.sha256||current.extracted_text!==attachment.extractedText||current.created_at!==attachment.createdAtMs)throw new PredispatchError('attachment_changed');
    }
  }

  #insertDispatchMessages(db:TenantDb,row:ApprovalRow,prepared:Prepared,now:number):void {
    const userMessageId=row.release_user_message_id,assistantId=row.release_message_id;if(!userMessageId||!assistantId)throw new PredispatchError('release_identity_missing');
    const existing=db.get(this.#q.releasedMessage,row.id);if(existing&&existing.id!==assistantId)throw new PredispatchError('approval_release_message_conflict');
    if(existing)return;
    if(prepared.payload.assistantId!==undefined)db.run(this.#database.prepare('UPDATE conversations SET assistant_id=(SELECT id FROM assistants WHERE tenant_id=? AND id=?) WHERE tenant_id=? AND id=? AND owner_user_id=?') as Database.Statement<[TenantId,string,TenantId,string,string]>,row.tenant_id,prepared.payload.assistantId,row.tenant_id,prepared.payload.conversationId,row.requesting_user_id);
    const sequence=db.get(this.#q.nextSequence,prepared.payload.conversationId)?.n??0,sourcePrompt=this.#parts(prepared.payload.messages).at(-1)?.text??'',kind=prepared.verdict.action==='redact'||prepared.authorizedPrompt!==sourcePrompt?'redacted_text':'text';
    db.run(this.#database.prepare(`INSERT INTO messages(tenant_id,id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at,approval_id)
      VALUES(?,?,?,?,?,'user','complete',?,?,NULL)`) as Database.Statement<[TenantId,...unknown[]]>,userMessageId,prepared.payload.conversationId,prepared.payload.assistantMessageId,row.requesting_user_id,sequence,now);
    db.run(this.#database.prepare("INSERT INTO message_parts(tenant_id,id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,?,?,?,'{}',?)") as Database.Statement<[TenantId,...unknown[]]>,randomUUID(),userMessageId,0,kind,prepared.authorizedPrompt,now);
    for(const [index,attachment] of (prepared.payload.attachments??[]).entries()){
      const inserted=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?))
        INSERT INTO message_parts(tenant_id,id,message_id,ordinal,kind,text_content,file_id,mime_type,metadata_json,created_at)
        SELECT (SELECT id FROM tenant_scope),?,?,?, ?,NULL,f.id,f.mime_type,?,?
        FROM project_files f
        JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id
        JOIN project_conversations pc ON pc.project_id=f.project_id AND pc.conversation_id=?
        JOIN conversations c ON c.tenant_id=f.tenant_id AND c.id=pc.conversation_id
        WHERE f.tenant_id=(SELECT id FROM tenant_scope) AND f.id=? AND f.project_id=?
          AND p.owner_user_id=? AND p.deleted_at IS NULL AND p.archived_at IS NULL
          AND c.owner_user_id=? AND c.status<>'deleted'
          AND f.original_name=? AND f.mime_type=? AND f.byte_size=? AND f.sha256=? AND f.extracted_text=? AND f.created_at=?
          AND f.deleted_at IS NULL AND f.content_purged_at IS NULL AND f.extraction_status='ready'`) as Database.Statement<[TenantId,...unknown[]]>,randomUUID(),userMessageId,index+1,attachment.mimeType.startsWith('image/')?'image_ref':'file_ref',JSON.stringify({approvalId:row.id,projectId:attachment.projectId}),now,prepared.payload.conversationId,attachment.fileId,attachment.projectId,row.requesting_user_id,row.requesting_user_id,attachment.name,attachment.mimeType,attachment.byteSize,attachment.sha256,attachment.extractedText,attachment.createdAtMs);
      if(inserted.changes!==1)throw new PredispatchError('attachment_changed');
    }
    db.run(this.#database.prepare(`INSERT INTO messages(tenant_id,id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,model_catalog_id,provider_key,created_at,approval_id)
      VALUES(?,?,?,?,NULL,'assistant','pending',?,?,?,?,?)`) as Database.Statement<[TenantId,...unknown[]]>,assistantId,prepared.payload.conversationId,userMessageId,sequence+1,prepared.model.id,prepared.model.provider_key,now,row.id);
    db.run(this.#database.prepare("INSERT INTO message_parts(tenant_id,id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','', '{}',?)") as Database.Statement<[TenantId,...unknown[]]>,randomUUID(),assistantId,now);
    db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status='blocked',error_code='APPROVAL_RELEASED',completed_at=?
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND status='pending'`) as Database.Statement<[TenantId,...unknown[]]>,now,prepared.payload.assistantMessageId);
  }

  #heartbeat(claim:Claimed,now=this.#now()):void{const db=forTenant({tenantId:claim.row.tenant_id});const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET release_lease_expires_at_ms=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,now+this.#leaseMs,claim.row.id,claim.leaseOwner);if(changed.changes!==1)throw new Error('approval_release_fence_lost');}

  #markFinalizeFailure(claim:Claimed,error:unknown):void{
    const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now(),terminal=row.release_finalize_attempts>=MAX_FINALIZE_ATTEMPTS,code=terminal?'approval_finalize_failed':this.#code(error),next=terminal?null:now+(FINALIZE_RETRY_MS[Math.max(0,row.release_finalize_attempts-1)]??30_000);
    const transition=()=>{
      const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status=?,release_phase=?,release_error_code=?,release_next_attempt_at_ms=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=CASE WHEN ?=1 THEN ? ELSE payload_terminal_at_ms END,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,terminal?'release_indeterminate':'releasing',terminal?'finalize_failed':'finalize_retry',code,next,terminal?1:0,now,row.id,row.version,claim.leaseOwner);
      if(changed.changes!==1)throw new Error('approval_release_fence_lost');
      if(terminal){db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='release_indeterminate'`) as Database.Statement<[TenantId,...unknown[]]>,row.id);this.#finishTerminal(db,row,now,'approval_finalize_failed',false);}
    };
    try{this.#audit.transact(tx=>{transition();tx.append(terminal?this.#cancelEvent(row,now,'approval_finalize_failed'):this.#finalizeRetryEvent(row,now,code,claim.attempt));});}
    catch(auditError){const key=`${row.tenant_id}:${row.id}`,failures=(this.#finalizeAuditBackoff.get(key)?.failures??0)+1;this.#finalizeAuditBackoff.set(key,{failures,nextAt:now+Math.min(60_000,1_000*2**Math.min(6,failures-1))});throw auditError;}
  }

  #markPredispatchFailure(claim:Claimed,error:unknown):void{
    const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now(),code=this.#code(error),terminal=claim.attempt>=MAX_ATTEMPTS;
    this.#audit.transact(tx=>{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status=?,release_phase=?,release_error_code=?,release_next_attempt_at_ms=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=CASE WHEN ?=1 THEN ? ELSE payload_terminal_at_ms END,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,terminal?'cancelled':'release_failed',terminal?'failed_terminal':'retry_wait',code,terminal?null:now+(RETRY_MS[claim.attempt-1]??30_000),terminal?1:0,now,row.id,claim.leaseOwner);if(changed.changes!==1)return;if(terminal){this.#transitionViolation(db,row,'cancelled',now);this.#denyGateDecision(db,row);this.#finishTerminal(db,row,now,'attempt_limit',true);tx.append(this.#cancelEvent(row,now,'attempt_limit'));}else tx.append(this.#failureEvent(row,now,code,claim.attempt));});
  }
  #markIndeterminate(claim:Claimed,error:unknown):void{const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now(),code=this.#code(error);this.#audit.transact(tx=>{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='release_indeterminate',release_phase='dispatch_outcome_unknown',release_error_code=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,code,now,row.id,claim.leaseOwner);if(changed.changes===1){this.#finishTerminal(db,row,now,'dispatch_outcome_unknown',false);tx.append(this.#failureEvent(row,now,'dispatch_outcome_unknown',claim.attempt));}});}

  #terminal(claim:Claimed,status:'cancelled'|'rejected',code:string):never{const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now();this.#audit.transact(tx=>{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status=?,decision_reason_code=?,release_phase='terminal',release_error_code=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,status,code,code,now,row.id,claim.leaseOwner);if(changed.changes!==1)throw new Error('approval_release_fence_lost');this.#transitionViolation(db,row,status==='rejected'?'rejected':'cancelled',now);this.#denyGateDecision(db,row);this.#finishTerminal(db,row,now,code,status==='cancelled');tx.append(status==='rejected'?this.#rejectEvent(row,now,code):this.#cancelEvent(row,now,code));});throw new ReleaseTerminalError(code);}
  #policyDenied(claim:Claimed,verdict:GateVerdict,code:string):never{const row=this.#fresh(claim),db=forTenant({tenantId:row.tenant_id}),now=this.#now();this.#audit.transact(tx=>{tx.append({tenantId:row.tenant_id,action:'gate.released_content_rechecked',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'approval',id:row.id},outcome:'denied',context:{requestId:`approval:${row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:verdict.action,detector:verdict.matches[0]?.detectorId??row.detector,metadata:{approvalId:row.id,originalRuleSetRevision:row.policy_revision,currentRuleSetRevision:this.#revision(verdict),result:code}});const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='rejected',decision_reason_code=?,release_phase='policy_denied',release_error_code=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='releasing' AND release_lease_owner=?`) as Database.Statement<[TenantId,...unknown[]]>,code,code,now,row.id,claim.leaseOwner);if(changed.changes!==1)throw new Error('approval_release_fence_lost');this.#transitionViolation(db,row,'rejected',now);this.#denyGateDecision(db,row);this.#finishTerminal(db,row,now,code,false);tx.append(this.#rejectEvent(row,now,code));});throw new ReleaseTerminalError(code);}

  #expire(db:TenantDb,row:ApprovalRow,now:number,tx:AuditTransaction):void{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='expired',decision_reason_code='expired',decided_at_ms=COALESCE(decided_at_ms,?),payload_terminal_at_ms=?,release_phase='terminal',release_lease_owner=NULL,release_lease_expires_at_ms=NULL,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=?`) as Database.Statement<[TenantId,...unknown[]]>,now,now,row.id,row.version);if(changed.changes!==1)return;this.#transitionViolation(db,row,'expired',now);this.#denyGateDecision(db,row);this.#finishTerminal(db,row,now,'expired',true);tx.append({tenantId:row.tenant_id,action:'gate.approval_expired',actor:{type:'service',id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'approval',id:row.id},outcome:'cancelled',context:{requestId:`approval:${row.id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'require_approval',detector:row.detector,metadata:{approvalId:row.id}});}
  #indeterminate(db:TenantDb,row:ApprovalRow,now:number,tx:AuditTransaction,code:string):void{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='release_indeterminate',release_phase='dispatch_outcome_unknown',release_error_code=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status='releasing'`) as Database.Statement<[TenantId,...unknown[]]>,code,now,row.id,row.version);if(changed.changes===1){this.#finishTerminal(db,row,now,code,false);tx.append(this.#failureEvent(row,now,code,row.release_attempts));}}
  #cancel(db:TenantDb,row:ApprovalRow,now:number,tx:AuditTransaction,code:string):void{const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests SET status='cancelled',release_phase='terminal',release_error_code=?,release_lease_owner=NULL,release_lease_expires_at_ms=NULL,payload_terminal_at_ms=?,result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=?`) as Database.Statement<[TenantId,...unknown[]]>,code,now,row.id,row.version);if(changed.changes===1){this.#transitionViolation(db,row,'cancelled',now);this.#denyGateDecision(db,row);this.#finishTerminal(db,row,now,code,true);tx.append(this.#cancelEvent(row,now,code));}}

  #transitionViolation(db:TenantDb,row:ApprovalRow,status:'approved'|'rejected'|'cancelled'|'expired'|'in_review',now:number):void{
    if(!['open','triaged','in_review'].includes(row.violation_status))return;
    const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET status=?,updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND approval_id=? AND version=? AND status IN ('open','triaged','in_review')`) as Database.Statement<[TenantId,...unknown[]]>,status,now,row.violation_id,row.id,row.violation_version);
    if(changed.changes!==1)throw new Error('approval_violation_changed');
  }
  #denyGateDecision(db:TenantDb,row:ApprovalRow):void{
    if(!row.gate_decision_id||!['pending_approval','approved'].includes(row.gate_decision_status??''))return;
    const changed=db.run(this.#database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions SET status='denied' WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status=?`) as Database.Statement<[TenantId,...unknown[]]>,row.gate_decision_id,row.gate_decision_status);
    if(changed.changes!==1)throw new Error('approval_release_fence_lost');
  }

  #finishTerminal(db:TenantDb,row:ApprovalRow,now:number,code:string,cancelled:boolean):void{
    if(row.routing_decision_id){const route=db.get(this.#q.route,row.routing_decision_id),status=row.provider_started_at_ms===null?'cancelled':'failed';if(route&&!['completed','cancelled','failed'].includes(route.status)&&db.run(this.#q.finishRouting,status,now,now,row.routing_decision_id).changes!==1)throw new Error('approval_release_fence_lost');}
    const errorCode=['dispatch_outcome_unknown','worker_lost_after_dispatch','approval_finalize_failed','approval_violation_changed','postflight_policy_changed'].includes(code)?'APPROVAL_RELEASE_INDETERMINATE':`APPROVAL_${code.replace(/[^a-zA-Z0-9]/gu,'_').toUpperCase()}`;terminalApprovalRun({database:this.#database,db,tenantId:row.tenant_id,requestingUserId:row.requesting_user_id,sourceMessageId:row.message_id??'',approvalId:row.id,gateDecisionId:row.gate_decision_id,errorCode,now,cancelled});
  }

  #settleFailure(prepared:Prepared,error:unknown,usage:Usage|null,providerRequestId:string|null,request:ChatRequest|null,observedOutputUtf8Bytes:number):void{
    if(usage)this.#settleUsage(prepared.row,usage,providerRequestId,'error','provider_error',usage.outputTokens);
    else if(request&&observedOutputUtf8Bytes>0){
      const inputEstimate=estimateUsage(request,''),outputTokens=Math.ceil(observedOutputUtf8Bytes/3),estimated:Usage={...inputEstimate,outputTokens,totalTokens:inputEstimate.inputTokens+outputTokens};
      this.#settleUsage(prepared.row,estimated,providerRequestId,'error','provider_error',outputTokens);
    }else this.#settleNoEvidence(prepared.row,prepared.reservation.pricingSnapshot.providerModel,this.#now(),providerRequestId);
    void error;
  }
  #settleUnknownReservation(db:TenantDb,row:ApprovalRow,now:number):void{
    if(!row.release_reservation_id)throw new Error('approval_dispatch_without_reservation');
    const reservation=db.get(this.#q.reservation,row.release_reservation_id);if(!reservation)throw new Error('approval_dispatch_without_reservation');
    const meta=JSON.parse(reservation.metadata_json) as Partial<ReservationMeta>;
    if(!Number.isSafeInteger(meta.output)||Number(meta.output)<0||typeof meta.pricing?.providerModel!=='string')throw new Error('approval_reservation_metadata_invalid');
    this.#settleNoEvidence(row,meta.pricing.providerModel,now,null);
  }
  #settleNoEvidence(row:ApprovalRow,providerModel:string,now:number,providerRequestId:string|null):ApprovalSettlement{
    if(!row.release_reservation_id)throw new Error('approval_release_not_prepared');
    const settled=this.#ledger.settle({reservationId:row.release_reservation_id,providerRequestId,providerModel,
      actualInputTokens:0,actualCachedInputTokens:0,actualOutputTokens:0,actualCostMicros:0,locallyCountedOutputTokens:0,
      usageQuality:'estimated',finishReason:'unknown',outcome:'provider_error',now});
    return this.#attributeSettlement(row,settled,null,0,now,this.#releaseContext(row,true));
  }
  #settleUsage(row:ApprovalRow,usage:Pick<Usage,'inputTokens'|'outputTokens'|'cachedInputTokens'|'estimated'>|null,providerRequestId:string|null,finishReason:string|null,outcome:'complete'|'provider_error',locallyCountedOutputTokens:number):ApprovalSettlement{
    if(!row.release_reservation_id)throw new Error('approval_release_not_prepared');
    const context=this.#releaseContext(row),pricing=this.#q.catalogPricing.get(row.tenant_id,context.model.id);
    if(context.route&&!pricing)throw new Error('approval_reservation_metadata_invalid');
    const actualCost=usage&&pricing?estimateModelCostMicrousd({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens,
      inputMicrousdPerMillion:pricing.input_price,outputMicrousdPerMillion:pricing.output_price,cachedInputMicrousdPerMillion:pricing.cached_price}):null;
    const settled=this.#ledger.settle({reservationId:row.release_reservation_id,providerRequestId,providerModel:context.model.model_key,actualInputTokens:usage?.inputTokens??null,
      actualCachedInputTokens:usage?.cachedInputTokens??null,actualOutputTokens:usage?.outputTokens??null,...(actualCost===null?{}:{actualCostMicros:actualCost}),locallyCountedOutputTokens,
      usageQuality:usage?(usage.estimated?'estimated':'provider_actual'):'estimated',finishReason,outcome,now:this.#now()});
    return this.#attributeSettlement(row,settled,usage,actualCost,this.#now(),context);
  }
  #releaseContext(row:ApprovalRow,allowUnknownCredential=false):ReleaseContext{
    const db=forTenant({tenantId:row.tenant_id}),payload=this.#open(row);
    if(!row.routing_decision_id){
      const model=db.get(this.#q.settlementModel,payload.model.catalogId);if(!model||model.provider_key!==payload.model.provider)throw new Error('approval_reservation_metadata_invalid');
      const credentialSource=this.#providerStartCredential(db,row);
      if(!credentialSource&&!allowUnknownCredential)throw new Error('approval_reservation_metadata_invalid');
      return{model,route:null,credentialSource:credentialSource??'legacy_unknown'};
    }
    const route=db.get(this.#q.route,row.routing_decision_id);
    if(!route||!route.selected_model_catalog_id||!route.selected_provider)throw new Error('approval_reservation_metadata_invalid');
    const model=db.get(this.#q.settlementModel,route.selected_model_catalog_id);
    if(!model||model.provider_key!==route.selected_provider)throw new Error('approval_reservation_metadata_invalid');
    return{model,route,credentialSource:route.credential_source??'platform'};
  }
  #providerStartCredential(db:TenantDb,row:ApprovalRow):'platform'|'byok'|null{
    if(!row.release_message_id||!row.release_reservation_id)return null;
    for(const event of db.all(this.#q.providerStarts,row.release_message_id)){
      try{
        const metadata=JSON.parse(event.metadata_json) as {approvalId?:unknown;reservationId?:unknown;credentialSource?:unknown};
        if(metadata.approvalId===row.id&&metadata.reservationId===row.release_reservation_id&&(metadata.credentialSource==='platform'||metadata.credentialSource==='byok'))return metadata.credentialSource;
      }catch{/* A malformed unrelated audit row cannot supply billing attribution. */}
    }
    return null;
  }
  #attributeSettlement(row:ApprovalRow,settled:SettlementResult,usage:Pick<Usage,'cachedInputTokens'>|null,actualProviderCost:number|null,now:number,known?:ReleaseContext):ApprovalSettlement{
    const context=known??this.#releaseContext(row),providerCost=actualProviderCost??settled.chargedCostMicros;
    const baselineCost=context.route?.baseline_cost_microusd??null;
    const billing=calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource:context.credentialSource==='byok'?'byok':'platform',baselineCostMicrousd:baselineCost});
    const db=forTenant({tenantId:row.tenant_id}),linked=db.run(this.#q.linkUsageBilling,providerCost,billing.customerChargeMicrousd,context.credentialSource,baselineCost,billing.savingsMicrousd,
      context.route?.selected_platform_model_version_id??context.model.platform_model_version_id,row.routing_decision_id,settled.usageEventId);
    if(linked.changes!==1)throw new Error('ledger_invariant_violation');
    return{settled,providerCostMicrousd:providerCost,customerChargeMicrousd:billing.customerChargeMicrousd,baselineCostMicrousd:baselineCost,savingsMicrousd:billing.savingsMicrousd,model:context.model,route:context.route,credentialSource:context.credentialSource};
  }
  #fresh(claim:Claimed):ApprovalRow{const row=forTenant({tenantId:claim.row.tenant_id}).get(this.#q.load,claim.row.id);this.#assertLease(row,claim);return row!;}
  #assertLease(row:ApprovalRow|undefined,claim:Claimed):void{if(!row||row.status!=='releasing'||row.release_lease_owner!==claim.leaseOwner)throw new Error('approval_release_fence_lost');}
  #open(row:ApprovalRow):ApprovalEnvelopePayloadV1{const digest=createHash('sha256').update(row.payload_ciphertext).digest('hex');if(digest!==row.payload_digest)throw new PredispatchError('payload_digest_mismatch');const payload=openApprovalEnvelope(this.#key,{tenantId:row.tenant_id,approvalId:row.id,violationId:row.violation_id,ciphertext:row.payload_ciphertext,nonce:row.payload_nonce,keyVersion:row.key_version,cryptoScheme:row.payload_crypto_scheme,wrappedDek:row.payload_wrapped_dek,wrapNonce:row.payload_wrap_nonce,kekVersion:row.payload_kek_version});this.#validatePayload(payload,row);return payload;}
  #openResult(row:ApprovalRow):ApprovalReleaseResultV1{if(!row.result_ciphertext||!row.result_nonce||!row.result_digest)throw new Error('approval_result_missing');if(createHash('sha256').update(row.result_ciphertext).digest('hex')!==row.result_digest)throw new Error('approval_result_digest_mismatch');const result=openApprovalResult(this.#key,{tenantId:row.tenant_id,approvalId:row.id,ciphertext:row.result_ciphertext,nonce:row.result_nonce,keyVersion:row.key_version,cryptoScheme:row.payload_crypto_scheme,wrappedDek:row.payload_wrapped_dek,wrapNonce:row.payload_wrap_nonce,kekVersion:row.payload_kek_version});this.#validateResult(result,row);return result;}
  #validatePayload(payload:ApprovalEnvelopePayloadV1,row:ApprovalRow):void{
    const messagesValid=Array.isArray(payload.messages)&&payload.messages.length>0&&payload.messages.every(message=>message&&['system','developer','user','assistant','tool'].includes(message.role)&&Array.isArray(message.content)&&message.content.every((part:unknown)=>typeof part==='object'&&part!==null&&(part as {type?:unknown}).type==='text'&&typeof (part as {text?:unknown}).text==='string'));
    const attachments=payload.attachments;
    const confirmedWarnings=payload.confirmedWarnings;
    let attachmentCodePoints=0;
    const attachmentsValid=attachments===undefined||(Array.isArray(attachments)&&attachments.length<=10&&attachments.every(attachment=>{
      if(!attachment||typeof attachment.fileId!=='string'||typeof attachment.projectId!=='string'||typeof attachment.name!=='string'||!attachment.name||typeof attachment.mimeType!=='string'||!attachment.mimeType||!Number.isSafeInteger(attachment.byteSize)||attachment.byteSize<1||attachment.byteSize>25*1024*1024||!/^[0-9a-f]{64}$/u.test(attachment.sha256)||typeof attachment.extractedText!=='string'||!Number.isSafeInteger(attachment.createdAtMs)||attachment.createdAtMs<0)return false;
      attachmentCodePoints+=Array.from(attachment.extractedText).length;return attachmentCodePoints<=1_000_000;
    }));
    const warningsValid=confirmedWarnings===undefined||(Array.isArray(confirmedWarnings)&&confirmedWarnings.length<=2&&new Set(confirmedWarnings.map(item=>item.direction)).size===confirmedWarnings.length&&confirmedWarnings.every(item=>(item.direction==='file'||item.direction==='outbound')&&/^[0-9a-f]{64}$/u.test(item.policyFingerprint)&&item.ruleIds.length>0&&item.ruleIds.length<=100&&item.ruleIds.every((id:string)=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(item.ruleIds).size===item.ruleIds.length));
    const outputEstimate=payload.model?.estimatedOutputTokens;
    if(payload.assistantId!==undefined&&(typeof payload.assistantId!=='string'||payload.assistantId.length!==36))throw new PredispatchError('approval_payload_invalid');
    if(payload.assistantPrompt!==undefined&&typeof payload.assistantPrompt!=='string')throw new PredispatchError('approval_payload_invalid');
    if(payload.requestingUserId!==row.requesting_user_id||payload.conversationId!==row.conversation_id||payload.sourceMessageId!==row.message_id||payload.pass!=='preflight'||(payload.tone!==undefined&&!['default','concise','detailed','formal','friendly'].includes(payload.tone))||(payload.role!==undefined&&!['default','coach','creative','critic','debate','support'].includes(payload.role))||!messagesValid||!attachmentsValid||!warningsValid||typeof payload.model?.catalogId!=='string'||typeof payload.model?.modelKey!=='string'||!['openai','anthropic','google','xai','openrouter','venice','nvidia'].includes(payload.model?.provider)||!['none','low','medium','high'].includes(payload.model?.reasoningEffort)||!Number.isSafeInteger(payload.model?.maxOutputTokens)||payload.model.maxOutputTokens<1||(outputEstimate!==undefined&&(!Number.isSafeInteger(outputEstimate)||outputEstimate<1))||typeof payload.policy?.fingerprint!=='string'||!/^[0-9a-f]{64}$/u.test(payload.policy.fingerprint))throw new PredispatchError(attachmentsValid&&warningsValid?'approval_payload_invalid':'attachment_invalid');
  }
  #routingOutputEstimate(payload:ApprovalEnvelopePayloadV1):number{return payload.model.estimatedOutputTokens??ROUTING_OUTPUT_TOKEN_ESTIMATE;}
  #validateResult(result:ApprovalReleaseResultV1,row:ApprovalRow):void{
    const actions=new Set<GateAction>(['allow','flag','redact','mask','warn','block','require_approval']);
    const decision=(value:ApprovalReleaseResultV1['preflight']|ApprovalReleaseResultV1['postflight']|ApprovalReleaseResultV1['files'][number]):boolean=>typeof value?.evaluationId==='string'&&actions.has(value.action)&&Array.isArray(value.ruleIds)&&value.ruleIds.every(id=>typeof id==='string')&&Array.isArray(value.detectorKeys)&&value.detectorKeys.every(id=>typeof id==='string')&&typeof value.contentDigest==='string'&&/^[0-9a-f]{64}$/u.test(value.contentDigest)&&Number.isSafeInteger(value.latencyMs)&&value.latencyMs>=0;
    const usage=result.usage,postflight=result.postflight,roles=new Set(['owner','admin','compliance','member']);
    if(result.tenantId!==row.tenant_id||result.approvalId!==row.id||typeof result.outputText!=='string'||Array.from(result.outputText).length>this.#maxResponseCodePoints||!(result.providerRequestId===null||typeof result.providerRequestId==='string')||!(result.finishReason===null||typeof result.finishReason==='string')||!usage||![usage.inputTokens,usage.outputTokens,usage.cachedInputTokens].every(value=>Number.isSafeInteger(value)&&value>=0)||typeof usage.estimated!=='boolean'||!decision(result.preflight)||!decision(postflight)||typeof postflight.withheld!=='boolean'||typeof postflight.policyFingerprint!=='string'||!/^[0-9a-f]{64}$/u.test(postflight.policyFingerprint)||!Array.isArray(postflight.groupIds)||postflight.groupIds.length>1000||postflight.groupIds.some(id=>typeof id!=='string'||id.length<1||id.length>256)||new Set(postflight.groupIds).size!==postflight.groupIds.length||!Array.isArray(postflight.roles)||postflight.roles.length>4||postflight.roles.some(role=>!roles.has(role))||new Set(postflight.roles).size!==postflight.roles.length||!Array.isArray(result.files)||result.files.length>10||!result.files.every(file=>decision(file)&&typeof file.fileId==='string'&&typeof file.projectId==='string'&&Number.isSafeInteger(file.currentRevision)&&file.currentRevision>=0))throw new Error('approval_result_invalid');
  }

  #providerResolution(tenantId:string,provider:ProviderId,fallback:'platform'|'byok'|'legacy_unknown'):{provider:ChatProvider;credentialSource:'platform'|'byok'}{
    return this.#tenantProviders?.resolve(tenantId,provider)??{provider:this.#providers.get(provider),credentialSource:fallback==='byok'?'byok':'platform'};
  }
  #policy(db:TenantDb,subject:Subject,modelId:string,pass:'preflight'|'postflight',directions:readonly ('outbound'|'inbound'|'file')[]):ResolvedPolicySnapshot{const rows=db.all(this.#q.policies,JSON.stringify(directions),subject.userId,JSON.stringify(subject.groupIds),modelId);return resolvePolicy({tenantId:subject.tenantId,modelId,subject,pass,policyVersion:1,rules:rows.map((row,index)=>({id:row.id,revision:row.revision,name:row.name,detectorKind:row.detector_kind,action:row.action,passMask:row.pass_mask,priority:row.priority,scopeType:row.scope_type,scopeId:row.scope_id,config:JSON.parse(row.config_json) as Record<string,unknown>,failureMode:row.failure_mode,sourceOrder:index})),nowMs:this.#now()});}
  #combinedPolicyFingerprint(outbound:ResolvedPolicySnapshot,file:ResolvedPolicySnapshot):string{return createHash('sha256').update(`${outbound.fingerprint}\n${file.fingerprint}`).digest('hex');}
  #sameStrings(left:readonly string[],right:readonly string[]):boolean{return left.length===right.length&&left.every((value,index)=>value===right[index]);}
  #sameModel(left:ModelRow,right:ModelRow):boolean{return left.id===right.id&&left.provider_key===right.provider_key&&left.model_key===right.model_key&&left.context_window===right.context_window&&left.max_output_tokens===right.max_output_tokens&&left.input_microusd_per_million===right.input_microusd_per_million&&left.output_microusd_per_million===right.output_microusd_per_million&&left.capabilities_json===right.capabilities_json&&left.platform_model_version_id===right.platform_model_version_id;}
  #gateContext(row:ApprovalRow,payload:ApprovalEnvelopePayloadV1,subject:Subject,model:ModelRow,pass:'preflight'|'postflight',parts:GateContext['parts'],policySnapshot:ResolvedPolicySnapshot,phase:string,abortSignal:AbortSignal,projectId:string|null=null):GateContext{return{evaluationId:randomUUID(),requestId:`approval:${row.id}`,pass,subject,conversationId:payload.conversationId,messageId:pass==='preflight'?(row.release_user_message_id??payload.sourceMessageId):row.release_message_id,projectId,providerId:model.provider_key,modelId:model.id,locale:'en',nowMs:this.#now(),parts,policySnapshot,abortSignal,confirmedWarningToken:null,metadata:{approvalId:row.id,approvalReleasePhase:phase}};}
  #parts(messages:readonly ChatMessage[],role?:string,tone?:string,assistantPrompt?:string,assistantId?:string):GateContext['parts']{const last=messages.length-1,parts:GateContext['parts'][number][]=messages.map((message,index)=>({id:`message:${index}`,source:index===last&&message.role==='user'?'user_prompt':'conversation_history',text:message.content.filter(part=>part.type==='text').map(part=>part.text).join(''),mimeType:'text/plain',fileId:null,provenance:{messageIndex:index,role:message.role}}));const persona=composePersona(role,tone);if(persona)parts.push({id:'system:persona',source:'system_persona',text:persona,mimeType:'text/plain',fileId:null,provenance:{role:role??'default',tone:tone??'default'}});if(assistantPrompt)parts.push({id:'system:assistant',source:'system_persona',text:assistantPrompt,mimeType:'text/plain',fileId:null,provenance:{...(assistantId?{assistantId}:{})}});return parts;}
  #messagesText(messages:readonly ChatMessage[]):string{return messages.flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:part.type==='document'&&part.source.kind==='text'?[part.source.text]:[])).join('\n');}
  #protocol(provider:ProviderId):ProviderProtocol{return provider==='anthropic'?'anthropic_messages':provider==='google'?'google_generate_content':provider==='openai'?'openai_responses':'openai_chat_completions';}
  #ruleIds(verdict:GateVerdict):string[]{return [...new Set(verdict.matches.map(match=>match.ruleId))];}
  #detectors(verdict:GateVerdict):string[]{return [...new Set(verdict.matches.map(match=>match.detectorKind))];}
  #revision(verdict:GateVerdict):number{return Math.max(1,...verdict.matches.map(match=>match.ruleRevision).filter(Number.isSafeInteger));}
  #decisionResult(verdict:GateVerdict,payload:ApprovalEnvelopePayloadV1,digest:string):ApprovalReleaseResultV1['preflight']{return{evaluationId:verdict.evaluationId,action:verdict.action,ruleIds:this.#ruleIds(verdict),detectorKeys:this.#detectors(verdict),protectedItemCount:verdict.redactions.length+verdict.masks.length,contentDigest:digest,latencyMs:Math.ceil(verdict.timings.totalUs/1000),currentRevision:Math.max(payload.policy.revision,this.#revision(verdict))};}
  #jsonIds(value:string):string[]{try{const parsed=JSON.parse(value) as unknown;return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];}catch{return[];}}
  #code(error:unknown):string{
    if(error instanceof PredispatchError&&SAFE_FAILURE_CODES.has(error.code))return error.code;
    const value=error as {code?:unknown;message?:unknown;name?:unknown;kind?:unknown};
    if(typeof value?.code==='string'&&SAFE_FAILURE_CODES.has(value.code))return value.code;
    if(value?.name==='ProviderError'&&typeof value.kind==='string')return'provider_failed';
    if(typeof value?.message==='string'&&SAFE_FAILURE_CODES.has(value.message))return value.message;
    return'approval_release_failed';
  }
  #failureEvent(row:ApprovalRow,now:number,code:string,attempt:number){return{tenantId:row.tenant_id,action:'gate.approval_released' as const,actor:{type:'service' as const,id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system' as const},target:{type:'approval' as const,id:row.id},outcome:'failure' as const,context:{requestId:`approval:${row.id}`,traceId:null,source:'worker' as const,occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'require_approval' as const,detector:row.detector,metadata:{approvalId:row.id,releaseAttempt:attempt,failureCode:code}};}
  #finalizeRetryEvent(row:ApprovalRow,now:number,code:string,attempt:number){return{tenantId:row.tenant_id,action:'gate.released_content_rechecked' as const,actor:{type:'service' as const,id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system' as const},target:{type:'approval' as const,id:row.id},outcome:'failure' as const,context:{requestId:`approval:${row.id}`,traceId:null,source:'worker' as const,occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.release_message_id,gateAction:'require_approval' as const,detector:row.detector,metadata:{approvalId:row.id,releaseAttempt:attempt,failureCode:code,phase:'finalize'}};}
  #cancelEvent(row:ApprovalRow,now:number,code:string){return{tenantId:row.tenant_id,action:'gate.approval_cancelled' as const,actor:{type:'service' as const,id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system' as const},target:{type:'approval' as const,id:row.id},outcome:'cancelled' as const,context:{requestId:`approval:${row.id}`,traceId:null,source:'worker' as const,occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'require_approval' as const,detector:row.detector,metadata:{approvalId:row.id,reasonCode:code}};}
  #rejectEvent(row:ApprovalRow,now:number,code:string){return{tenantId:row.tenant_id,action:'gate.approval_rejected' as const,actor:{type:'service' as const,id:this.#workerId,sessionId:null,ip:null,userAgent:null,authMethod:'system' as const},target:{type:'approval' as const,id:row.id},outcome:'denied' as const,context:{requestId:`approval:${row.id}`,traceId:null,source:'worker' as const,occurredAtMs:now},subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'require_approval' as const,detector:row.detector,metadata:{approvalId:row.id,violationId:row.violation_id,reasonCode:code,reviewNoteLength:row.decision_note?.length??0}};}
}

class PredispatchError extends Error{constructor(readonly code:string){super(code);this.name='PredispatchError';}}
class ReleaseTerminalError extends Error{constructor(readonly code:string){super(code);this.name='ReleaseTerminalError';}}
