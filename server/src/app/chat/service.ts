import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditService, AuditTransaction } from '../../lib/audit/index.js';
import { GATE_ACTION_RANK } from '../../lib/gate/action.js';
import { assertProviderTransportAuthorized, resolvePolicy, type GateEngine, type GateContext, type GateVerdict, type ResolvedPolicySnapshot } from '../../lib/gate/index.js';
import {
  calculateUsageBilling, eligibleRoutingCandidates, estimateModelCostMicrousd, GovernanceLedger, loadRoutingCandidates,
  ROUTING_OUTPUT_TOKEN_ESTIMATE, selectFastMultiModelPlan, selectSingleRoute,
  type FastMultiModelPlan, type ReservationGrant, type RoutingCandidate, type RoutingEffort,
  type SettlementInput, type SingleRouteSelection,
} from '../../lib/governance/index.js';
import { estimateUsage } from '../../lib/providers/metering.js';
import type { ProviderRegistry } from '../../lib/providers/registry.js';
import type { TenantProviderRegistry } from '../../lib/providers/tenant-registry.js';
import type { ChatMessage, ChatProvider, ChatRequest, ModelCatalogEntry, ReasoningEffort, StreamEvent as ProviderEvent, Usage } from '../../lib/providers/types.js';
import { supportsReasoningEffort } from '../../lib/providers/reasoning-capability.js';
import type { ApiError, ChatInput, ChatRun, EditResendInput, GateAction, Message, Provider, RegenerateInput, StreamEvent, ToneKey, UsageSummary } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { forTenant, type TenantDb } from '../../lib/db.js';
import type { TenantContext } from '../../lib/http/index.js';
import type { ChatGateResult, ChatPipelineServices, ChatReservation, ProviderChunk } from '../../routes/chat.js';
import type { WarnedRunPipeline } from './confirm-run.js';
import { protectedContentDigest, protectedIdempotencyDigest, sealApprovalEnvelope } from './approval-envelope.js';
import { assembleAuthorizedProviderContext } from './attachment-context.js';
import { estimateRequiredInputTokens } from '../../lib/token-estimate.js';
import { runMultiModel, type MultiModelExecution, type MultiModelExecutionResult } from './multi-model.js';
import { MULTI_MODEL_WORKFLOW_LEASE_MS } from './multi-model-recovery.js';
import { composePersona, type RoleKey } from './personas.js';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';

export const estimateChatInputTokens=estimateRequiredInputTokens;

type Input = ChatInput | RegenerateInput | EditResendInput;
type Mode = 'create' | 'regenerate' | 'edit-resend';

interface ModelRow { id:string; provider_key:Provider; model_key:string; display_name:string; context_window:number; max_output_tokens:number; input_microusd_per_million:number; output_microusd_per_million:number; cached_input_microusd_per_million:number|null; capabilities_json:string;platform_model_version_id:string|null }
interface ConversationRow { id:string;project_id:string|null;tone:string|null;role:string|null;assistant_id:string|null }
interface AssistantRunRow { system_prompt:string;model_catalog_id:string }
interface MessageRow { id:string;conversation_id:string;parent_message_id:string|null;role:'user'|'assistant';status:string;sequence_no:number;model_catalog_id:string|null;provider_key:Provider|null;input_tokens:number|null;output_tokens:number|null;cost_microusd:number|null;policy_action:GateAction|null;created_at:number;text_content:string|null }
interface AttachmentRow { id:string;project_id:string;original_name:string;mime_type:string;byte_size:number;sha256:string;extraction_status:string;extracted_text:string|null;created_at:number;deleted_at:number|null;content_purged_at:number|null }
interface PolicyRow { id:string;revision:number;name:string;direction:'outbound'|'inbound'|'file';detector_kind:'keyword'|'pii'|'secret'|'source_code'|'classification_tag'|'prompt_injection'|'semantic_policy'|'institution_name';action:GateAction;pass_mask:'preflight'|'postflight'|'both';priority:number;scope_type:'org'|'group'|'user'|'model';scope_id:string;config_json:string;failure_mode:'open'|'closed'|'escalate' }
interface RuleProjectionRow { severity:'low'|'medium'|'high'|'critical';scope_type:'tenant'|'group'|'user'|'model';scope_id:string|null;detector_key:string }
interface ExistingViolationRow { id:string;approval_id:string|null;status:string;gate_action:GateAction }
interface IdempotencyRow { id:string;request_sha256:string;status:'claimed'|'dispatching'|'completed'|'failed';run_id:string|null;response_json:string|null }
interface WarningExpiryRow { tenant_id:TenantId;evaluation_id:string;user_id:string|null;conversation_id:string|null;message_id:string|null;direction:'outbound'|'file';matched_detector_keys_json:string;idempotency_id:string|null;run_id:string|null;assistant_message_id:string|null;response_json:string|null }
interface ConfirmedWarning { readonly evaluationId:string;readonly token:string;readonly policyFingerprint:string;readonly ruleIds:readonly string[] }
interface RunState { tenantId:TenantId;userId:string;run:ChatRun;assistant:Message;model:ModelRow;messages:readonly ChatMessage[];providerMessages:readonly ChatMessage[]|null;outboundText:string;attachments:readonly AttachmentRow[];projectId:string|null;attachmentContextTruncated:boolean;reasoningEffort:ReasoningEffort;idempotencyId:string;preflight:GateVerdict|null;preflightDirection:'outbound'|'file';postflight:GateVerdict|null;reservation:ReservationGrant|null;usage:Usage|null;providerRequestId:string|null;finishReason:string|null;postflightText:string;cancelled:boolean;pendingPersistence:(()=>void)|null;newConversation:boolean;parentMessageId:string|null;sequenceNo:number;editedFromMessageId:string|null;confirmedWarnings:Partial<Record<'outbound'|'file',ConfirmedWarning>>;submittedAction:'chat.message_submitted'|'chat.message_regenerated'|'chat.message_edited_resubmitted';submitted:boolean;routingMode:'auto'|'single'|'multi_model';routingEffort:RoutingEffort;routingPreferredProvider:'openai'|'anthropic'|'google'|'xai'|null;routingPreferredModelId:string|null;routingTaskText:string;routingEstimatedOutputTokens:number;routeDecisionId:string|null;routeSelection:SingleRouteSelection|null;multiPlan:FastMultiModelPlan|null;multiWorkflowId:string|null;providerCostMicrousd:number|null;customerChargeMicrousd:number|null;baselineCostMicrousd:number|null;savingsMicrousd:number|null;credentialSource:'platform'|'byok'|'legacy_unknown' }
interface RunState { tone?:ToneKey }
interface RunState { role?:RoleKey }
interface RunState { assistantId?:string;assistantPrompt?:string }
interface RunState { error?:ApiError['error'] }
interface RunState { failurePartialMessageId?:string|null;failureGateNotice?:Extract<StreamEvent,{event:'gate.notice'}>['data'] }

interface ProviderExecutionRow {id:string;status:string;execution_role:string;model_catalog_id:string;platform_model_version_id:string;provider_key:Provider;credential_source:'platform'|'byok';input_tokens:number|null;output_tokens:number|null;provider_cost_microusd:number|null;provider_request_id:string|null;result_ciphertext:Buffer|null;result_nonce:Buffer|null;result_key_version:number|null}
interface MultiWorkflowRow {routing_decision_id:string;run_id:string;user_id:string;conversation_id:string|null;assistant_message_id:string|null;status:string}

interface EvaluatedPreflight { readonly direction:'outbound'|'file';readonly verdict:GateVerdict;readonly evaluatedText:string }
const MAX_CHAT_FILES=10,MAX_CHAT_FILE_CODE_POINTS=1_000_000;

export function protectedPromptItemCount(verdicts:readonly GateVerdict[],promptPartId:string,attachmentPartIds:ReadonlySet<string>):number {
  return verdicts.reduce((count,verdict)=>count+[...verdict.redactions,...verdict.masks].filter(item=>item.partId===promptPartId||attachmentPartIds.has(item.partId)).length,0);
}

export function enforceMultiModelApprovalBoundary(mode:'auto'|'single'|'multi_model',verdict:GateVerdict):GateVerdict {
  if(mode!=='multi_model'||verdict.disposition!=='pending_approval')return verdict;
  // The durable approval worker releases one provider call. Treating a five-round route as that
  // single call would bypass the advertised workflow, so fail closed before an approval is queued.
  return {...verdict,action:'block',disposition:'blocked',providerParts:null,displayParts:null,warningToken:null,
    approvalRequestId:null,failureCodes:[...verdict.failureCodes,'multi_model_approval_requires_single_route']};
}

export interface GovernedChatDependencies {
  readonly database:Database.Database;
  readonly gate:GateEngine;
  readonly providers:Pick<ProviderRegistry,'get'>;
  readonly tenantProviders?:Pick<TenantProviderRegistry,'resolve'>;
  readonly audit:AuditService;
  readonly approvalPayloadKey:Uint8Array;
  readonly now?:()=>number;
  readonly waitingRunTtlMs?:number;
  readonly warningSweepRetryBaseMs?:number;
  readonly warningSweepRetryMaxMs?:number;
  readonly logger?:Pick<Console,'error'>;
  readonly multiModelResultKey?:Uint8Array;
}

const GATE_AUDIT_ACTIONS={
  flag:'gate.content_flagged',redact:'gate.content_redacted',mask:'gate.content_masked',warn:'gate.warning_presented',
  block:'gate.content_blocked',require_approval:'gate.approval_requested',
} as const;

function closesReplayStream(event:StreamEvent):boolean {
  if(event.event==='run.completed'||event.event==='run.failed'||event.event==='run.cancelled')return true;
  return event.event==='run.status'&&(event.data.status==='awaiting_confirmation'||event.data.status==='awaiting_approval');
}

interface DurableRunResponse { run:ChatRun;assistant:Message;error?:ApiError['error'];partialMessageId?:string|null;gateNotice?:Extract<StreamEvent,{event:'gate.notice'}>['data'] }

export function durableReplayEvents(id:string,response:DurableRunResponse):StreamEvent[]{
  const created:StreamEvent={event:'run.created',data:{run:response.run}};
  if(response.run.status==='completed'){
    const usage:UsageSummary={inputTokens:response.assistant.inputTokens??0,outputTokens:response.assistant.outputTokens??0,totalTokens:(response.assistant.inputTokens??0)+(response.assistant.outputTokens??0),costUsd:response.assistant.costUsd??0,modelId:response.assistant.modelId!,provider:response.assistant.provider!,budgetWarnings:[]};
    return[created,{event:'message.created',data:{runId:id,message:response.assistant}},{event:'run.completed',data:{runId:id,conversationId:response.run.conversationId,message:response.assistant,usage}}];
  }
  if(response.run.status==='failed')return[created,...(response.gateNotice?[{event:'gate.notice' as const,data:response.gateNotice}]:[]),{event:'run.failed',data:{runId:id,error:response.error??{code:'INTERNAL_ERROR',message:'The model request could not be completed',requestId:id,retryable:false},partialMessageId:response.partialMessageId!==undefined?response.partialMessageId:response.assistant.id}}];
  if(response.run.status==='cancelled')return[created,{event:'run.cancelled',data:{runId:id,partialMessageId:response.assistant.id,usage:null}}];
  return[created,{event:'run.status',data:{runId:id,status:response.run.status}}];
}

/** Application adapter for the route catalog. SQL is prepared once and every request query is tenant-prefixed. */
export class GovernedChatApplication implements ChatPipelineServices {
  readonly #database:Database.Database;
  readonly #gate:GateEngine;
  readonly #providers:Pick<ProviderRegistry,'get'>;
  readonly #tenantProviders:Pick<TenantProviderRegistry,'resolve'>|null;
  readonly #audit:AuditService;
  readonly #approvalPayloadKey:Buffer;
  readonly #ledger:GovernanceLedger;
  readonly #multiModelResultKey:Buffer;
  readonly #now:()=>number;
  readonly #waitingRunTtlMs:number;
  readonly #warningSweepRetryBaseMs:number;
  readonly #warningSweepRetryMaxMs:number;
  readonly #logger:Pick<Console,'error'>;
  readonly #multiWorkflowOwner=`multi-chat:${process.pid}:${randomUUID()}`;
  readonly #runs=new Map<string,RunState>();
  readonly #events=new Map<string,Array<{id:number;event:StreamEvent}>>();
  readonly #eventWaiters=new Map<string,Set<()=>void>>();
  readonly #aborters=new Map<string,AbortController>();
  #warningSweepTimer:NodeJS.Timeout|null=null;
  #warningSweepFailures=0;
  readonly #q;

  constructor(deps:GovernedChatDependencies) {
    this.#database=deps.database; this.#gate=deps.gate; this.#providers=deps.providers; this.#tenantProviders=deps.tenantProviders??null; this.#audit=deps.audit;
    if(deps.approvalPayloadKey.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');
    this.#approvalPayloadKey=Buffer.from(deps.approvalPayloadKey);
    this.#multiModelResultKey=Buffer.from(deps.multiModelResultKey??createHash('sha256').update(this.#approvalPayloadKey).update('multi-model-result-v1').digest());
    if(this.#multiModelResultKey.byteLength!==32)throw new TypeError('Multi-model result key must be 32 bytes');
    this.#ledger=new GovernanceLedger(deps.database); this.#now=deps.now??Date.now;
    this.#waitingRunTtlMs=deps.waitingRunTtlMs??10*60_000;
    this.#warningSweepRetryBaseMs=deps.warningSweepRetryBaseMs??1_000;this.#warningSweepRetryMaxMs=deps.warningSweepRetryMaxMs??60_000;
    this.#logger=deps.logger??console;
    if(!Number.isSafeInteger(this.#waitingRunTtlMs)||this.#waitingRunTtlMs<1)throw new TypeError('waitingRunTtlMs must be a positive integer');
    if(!Number.isSafeInteger(this.#warningSweepRetryBaseMs)||this.#warningSweepRetryBaseMs<1||!Number.isSafeInteger(this.#warningSweepRetryMaxMs)||this.#warningSweepRetryMaxMs<this.#warningSweepRetryBaseMs)throw new TypeError('warning sweep retry delays are invalid');
    this.#q={
      conversation:deps.database.prepare<[TenantId,string,string],ConversationRow>(`SELECT c.id,c.tone,c.role,c.assistant_id,(SELECT pc.project_id FROM project_conversations pc WHERE pc.conversation_id=c.id) project_id
        FROM conversations c WHERE c.tenant_id=? AND c.id=? AND c.owner_user_id=? AND c.status<>'deleted'`),
      message:deps.database.prepare<[TenantId,string,string],MessageRow>(`SELECT m.id,m.conversation_id,m.parent_message_id,m.role,m.status,m.sequence_no,m.model_catalog_id,m.provider_key,m.input_tokens,m.output_tokens,m.cost_microusd,m.policy_action,m.created_at,p.text_content FROM messages m JOIN conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id LEFT JOIN message_parts p ON p.message_id=m.id AND p.ordinal=0 WHERE m.tenant_id=? AND m.id=? AND c.owner_user_id=? AND c.status<>'deleted'`),
      history:deps.database.prepare<[TenantId,string,string,number|null,number],MessageRow>(`SELECT m.id,m.conversation_id,m.parent_message_id,m.role,m.status,m.sequence_no,m.model_catalog_id,m.provider_key,m.input_tokens,m.output_tokens,m.cost_microusd,m.policy_action,m.created_at,p.text_content FROM messages m JOIN conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id LEFT JOIN message_parts p ON p.message_id=m.id AND p.ordinal=0 WHERE m.tenant_id=? AND m.conversation_id=? AND c.owner_user_id=? AND c.status<>'deleted' AND m.status IN ('complete','stopped') AND (? IS NULL OR m.sequence_no<?) ORDER BY m.sequence_no`),
      model:deps.database.prepare<[TenantId,string],ModelRow>(`SELECT m.id,m.provider_key,m.model_key,m.display_name,m.context_window,m.max_output_tokens,
        m.input_microusd_per_million,m.output_microusd_per_million,m.cached_input_microusd_per_million,m.capabilities_json,m.platform_model_version_id
        FROM model_catalog m WHERE m.tenant_id=? AND m.id=? AND m.enabled=1`),
      groups:deps.database.prepare<[TenantId,string],{group_id:string}>('SELECT group_id FROM group_members WHERE tenant_id=? AND user_id=? ORDER BY group_id'),
      providerCredential:deps.database.prepare<[TenantId,Provider],{credential_source:'environment'|'encrypted'}>('SELECT credential_source FROM provider_config WHERE tenant_id=? AND provider_key=? AND enabled=1'),
      project:deps.database.prepare<[TenantId,string,string],{id:string}>('SELECT id FROM projects WHERE tenant_id=? AND id=? AND owner_user_id=? AND deleted_at IS NULL'),
      file:deps.database.prepare<[TenantId,string,string],AttachmentRow>(`SELECT f.id,f.project_id,f.original_name,f.mime_type,f.byte_size,f.sha256,f.extraction_status,f.extracted_text,f.created_at,f.deleted_at,f.content_purged_at
        FROM project_files f JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id
        WHERE f.tenant_id=? AND f.id=? AND p.owner_user_id=? AND p.deleted_at IS NULL`),
      messageFiles:deps.database.prepare<[TenantId,string,string],AttachmentRow>(`SELECT f.id,f.project_id,f.original_name,f.mime_type,f.byte_size,f.sha256,f.extraction_status,f.extracted_text,f.created_at,f.deleted_at,f.content_purged_at
        FROM message_parts mp JOIN project_files f ON f.tenant_id=mp.tenant_id AND f.id=mp.file_id
        JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id
        WHERE mp.tenant_id=? AND mp.message_id=? AND p.owner_user_id=? ORDER BY mp.ordinal`),
      nextSequence:deps.database.prepare<[TenantId,string],{n:number}>('SELECT COALESCE(MAX(sequence_no),-1)+1 n FROM messages WHERE tenant_id=? AND conversation_id=?'),
      getAssistantForRun:deps.database.prepare<[TenantId,string],AssistantRunRow>('SELECT system_prompt,model_catalog_id FROM assistants WHERE tenant_id=? AND id=?'),
      insertConversation:deps.database.prepare('INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,tone,role,assistant_id,created_at,updated_at) VALUES(?,?,?,? ,\'active\',?,?,?,?,?)'),
      updateConversationPersona:deps.database.prepare('UPDATE conversations SET tone=?,role=?,assistant_id=?,updated_at=? WHERE tenant_id=? AND id=? AND owner_user_id=?'),
      insertMessage:deps.database.prepare('INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,model_catalog_id,provider_key,created_at,edited_from_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
      insertPart:deps.database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text',?,'{}',?)"),
      insertFilePart:deps.database.prepare(`WITH q(tenant_id,q_id,q_message,q_ordinal,q_kind,q_file,q_mime,q_metadata,q_at,q_project,q_user) AS (VALUES(?,?,?,?,?,?,?,?,?,?,?))
        INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,file_id,mime_type,metadata_json,created_at)
        SELECT q.q_id,q.tenant_id,q.q_message,q.q_ordinal,q.q_kind,q.q_file,q.q_mime,q.q_metadata,q.q_at FROM q
        WHERE EXISTS(SELECT 1 FROM messages m JOIN conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
          WHERE m.tenant_id=q.tenant_id AND m.id=q.q_message AND c.owner_user_id=q.q_user)
        AND EXISTS(SELECT 1 FROM project_files f JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id
          WHERE f.tenant_id=q.tenant_id AND f.id=q.q_file AND f.project_id=q.q_project AND f.extraction_status='ready'
          AND f.extracted_text IS NOT NULL AND f.deleted_at IS NULL AND f.content_purged_at IS NULL AND p.owner_user_id=q.q_user AND p.deleted_at IS NULL)`),
      linkProject:deps.database.prepare(`WITH q(tenant_id,q_project,q_conversation,q_user,q_at) AS (VALUES(?,?,?,?,?))
        INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at)
        SELECT q.q_project,q.q_conversation,q.q_user,q.q_at FROM q
        WHERE EXISTS(SELECT 1 FROM projects p WHERE p.tenant_id=q.tenant_id AND p.id=q.q_project AND p.owner_user_id=q.q_user AND p.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM conversations c WHERE c.tenant_id=q.tenant_id AND c.id=q.q_conversation AND c.owner_user_id=q.q_user AND c.status<>'deleted')
        ON CONFLICT(conversation_id) DO NOTHING`),
      projectLink:deps.database.prepare<[TenantId,string],{project_id:string}>('SELECT pc.project_id FROM project_conversations pc JOIN conversations c ON c.id=pc.conversation_id WHERE c.tenant_id=? AND pc.conversation_id=?'),
      updatePart:deps.database.prepare("UPDATE message_parts SET text_content=?,kind=? WHERE tenant_id=? AND message_id=? AND ordinal=0"),
      updateSubmittedPart:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0"),
      updateProtectedItemCount:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET protected_item_count=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?"),
      completeMessage:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status=?,input_tokens=?,output_tokens=?,cost_microusd=?,policy_action=?,protected_item_count=?,provider_request_id=?,finish_reason=?,completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?"),
      updateAssistantRoute:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET model_catalog_id=?,provider_key=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND status='pending'"),
      failMessage:deps.database.prepare("UPDATE messages SET status=?,error_code=?,policy_action=?,completed_at=? WHERE tenant_id=? AND id=?"),
      touchConversation:deps.database.prepare('UPDATE conversations SET updated_at=? WHERE tenant_id=? AND id=?'),
      policies:deps.database.prepare<[TenantId,string,string,string,string],PolicyRow>(`SELECT r.id,r.updated_at revision,p.name,r.direction,CASE d.kind WHEN 'classification' THEN 'classification_tag' WHEN 'injection' THEN 'prompt_injection' WHEN 'semantic' THEN 'semantic_policy' WHEN 'institution' THEN 'institution_name' WHEN 'regex' THEN 'keyword' ELSE d.kind END detector_kind,r.action,CASE r.direction WHEN 'inbound' THEN 'postflight' ELSE 'preflight' END pass_mask,r.priority,CASE r.scope_type WHEN 'tenant' THEN 'org' ELSE r.scope_type END scope_type,COALESCE(r.scope_id,r.tenant_id) scope_id,r.config_json,'closed' failure_mode FROM policy_rules r JOIN policies p ON p.tenant_id=r.tenant_id AND p.id=r.policy_id AND p.enabled=1 AND p.deleted_at IS NULL JOIN detector_definitions d ON d.id=r.detector_id AND d.enabled=1 AND (d.tenant_id=r.tenant_id OR d.tenant_id IS NULL) WHERE r.tenant_id=? AND r.enabled=1 AND (r.scope_type='tenant' OR (r.scope_type='user' AND r.scope_id=?) OR (r.scope_type='group' AND r.scope_id IN (SELECT value FROM json_each(?))) OR (r.scope_type='model' AND r.scope_id=?)) AND r.direction=? ORDER BY r.priority DESC,r.id`),
      insertDecision:deps.database.prepare("INSERT INTO gate_decisions(tenant_id,id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,protected_item_count,redacted_excerpt,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)") as Database.Statement<[TenantId,...unknown[]]>,
      insertViolation:deps.database.prepare("INSERT INTO policy_violations(tenant_id,id,audit_event_id,approval_id,subject_user_id,group_id,conversation_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,due_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)") as Database.Statement<[TenantId,...unknown[]]>,
      insertApproval:deps.database.prepare("INSERT INTO policy_approval_requests(tenant_id,id,violation_id,gate_decision_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,policy_revision,expires_at_ms,created_at_ms,routing_decision_id) VALUES(?,?,?,?,?,?,?,?,?,?,'dek_v2','available',?,?,?,?,?,?,?)") as Database.Statement<[TenantId,...unknown[]]>,
      ruleProjection:deps.database.prepare<[TenantId,string],RuleProjectionRow>(`WITH tenant_scope(id) AS (VALUES (?)) SELECT r.severity,r.scope_type,r.scope_id,d.key detector_key FROM policy_rules r JOIN detector_definitions d ON d.id=r.detector_id JOIN json_each(?) matched ON matched.value=r.id WHERE r.tenant_id=(SELECT id FROM tenant_scope) ORDER BY CASE r.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,CAST(matched.key AS INTEGER) LIMIT 1`),
      existingViolation:deps.database.prepare<[TenantId,string,string],ExistingViolationRow>('SELECT id,approval_id,status,gate_action FROM policy_violations WHERE tenant_id=? AND message_id=? AND direction=? ORDER BY created_at_ms LIMIT 1'),
      strengthenViolation:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET audit_event_id=?,approval_id=COALESCE(?,approval_id),group_id=?,detector=?,gate_action=?,severity=?,status='open',rule_ids_json=?,redacted_excerpt=?,content_digest=?,due_at_ms=COALESCE(?,due_at_ms),updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?"),
      resolveConfirmedWarning:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET status='resolved',version=version+1,updated_at_ms=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('open','triaged','in_review')"),
      idempotency:deps.database.prepare<[TenantId,string,string,string,string],IdempotencyRow>('SELECT id,request_sha256,status,run_id,response_json FROM idempotency_records WHERE tenant_id=? AND actor_user_id=? AND method=? AND path=? AND idempotency_key=?'),
      idempotencyRun:deps.database.prepare<[TenantId,string,string],IdempotencyRow>('SELECT id,request_sha256,status,run_id,response_json FROM idempotency_records WHERE tenant_id=? AND actor_user_id=? AND run_id=?'),
      insertIdempotency:deps.database.prepare('INSERT INTO idempotency_records(id,tenant_id,actor_user_id,method,path,idempotency_key,request_sha256,status,run_id,conversation_id,user_message_id,assistant_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'claimed\',?,?,?,?,?,?)'),
      dispatchIdempotency:deps.database.prepare("UPDATE idempotency_records SET status='dispatching',updated_at=? WHERE tenant_id=? AND id=? AND status='claimed'"),
      checkpointCredentialSource:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE budget_reservations
        SET metadata_json=json_set(metadata_json,'$.credentialSource',?)
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='active'`),
      finishIdempotency:deps.database.prepare("UPDATE idempotency_records SET status=?,response_json=?,updated_at=?,completed_at=? WHERE tenant_id=? AND id=?"),
      waitingIdempotency:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET response_json=?,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='claimed'"),
      dueWarnings:deps.database.prepare<[number,number],WarningExpiryRow>(`SELECT d.tenant_id,d.id evaluation_id,d.user_id,d.conversation_id,d.message_id,d.direction,d.matched_detector_keys_json,
        i.id idempotency_id,i.run_id,i.assistant_message_id,i.response_json
        FROM gate_decisions d
        LEFT JOIN idempotency_records i ON i.tenant_id=d.tenant_id AND i.actor_user_id=d.user_id AND i.user_message_id=d.message_id AND i.status='claimed'
        WHERE d.status='awaiting_confirmation' AND d.final_action='warn' AND d.direction IN ('outbound','file') AND d.decided_at+?<=?
        ORDER BY d.decided_at,d.id`),
      nextWarningDue:deps.database.prepare<[number],{due:number|null}>("SELECT MIN(decided_at+?) due FROM gate_decisions WHERE status='awaiting_confirmation' AND final_action='warn' AND direction IN ('outbound','file')"),
      expireWarningDecision:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions SET status='denied' WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='awaiting_confirmation' AND final_action='warn'"),
      expireWarningViolation:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations SET status='expired',updated_at_ms=?,version=version+1 WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND direction=? AND gate_action='warn' AND status IN ('open','triaged','in_review')"),
      expireWarningMessage:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status='blocked',error_code='WARNING_EXPIRED',policy_action='warn',completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND status='pending'"),
      expireWarningPart:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content='Request was not sent.',kind='text' WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0"),
      expireWarningRun:deps.database.prepare("WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET status='failed',response_json=COALESCE(?,response_json),updated_at=?,completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='claimed'"),
      insertRoutingDecision:deps.database.prepare(`INSERT INTO routing_decisions(id,tenant_id,idempotency_key,run_id,user_id,mode,requested_provider,requested_model_catalog_id,requested_effort,
        selected_model_catalog_id,selected_platform_model_version_id,selected_provider,selected_reasoning_effort,vendor_jurisdiction_constraint,processing_region_constraint,
        baseline_platform_model_version_id,baseline_cost_microusd,credential_source,route_reason_json,status,created_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'any','any',?,?,?,?,'selected',?,?)`),
      attachRoutingDecision:deps.database.prepare('UPDATE routing_decisions SET conversation_id=?,assistant_message_id=?,updated_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?'),
      dispatchRoutingDecision:deps.database.prepare("UPDATE routing_decisions SET status='dispatching',updated_at_ms=?,version=version+1 WHERE tenant_id=? AND id=? AND status='selected'"),
      finishRoutingDecision:deps.database.prepare("UPDATE routing_decisions SET status=?,completed_at_ms=?,updated_at_ms=?,version=version+1 WHERE tenant_id=? AND id=? AND status IN ('selected','dispatching')"),
      updateRoutingSelection:deps.database.prepare(`UPDATE routing_decisions SET selected_model_catalog_id=?,selected_platform_model_version_id=?,selected_provider=?,selected_reasoning_effort=?,
        credential_source=?,route_reason_json=?,updated_at_ms=?,version=version+1 WHERE tenant_id=? AND id=?`),
      linkUsageBilling:deps.database.prepare(`UPDATE usage_records SET provider_cost_microusd=?,customer_charge_microusd=?,credential_source=?,baseline_cost_microusd=?,savings_microusd=?,
        platform_model_version_id=?,routing_decision_id=? WHERE tenant_id=? AND id=?`),
      insertMultiWorkflow:deps.database.prepare(`INSERT OR IGNORE INTO multi_model_workflows(id,tenant_id,routing_decision_id,run_id,user_id,conversation_id,assistant_message_id,status,created_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,?,?,'planned',?,?)`),
      insertProviderExecution:deps.database.prepare(`INSERT OR IGNORE INTO provider_executions(id,tenant_id,workflow_id,routing_decision_id,ordinal,execution_role,idempotency_key,model_catalog_id,
        platform_model_version_id,provider_key,credential_source,status,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,'planned',?)`),
      providerExecution:deps.database.prepare<[TenantId,string,number],ProviderExecutionRow>('SELECT id,status,execution_role,model_catalog_id,platform_model_version_id,provider_key,credential_source,input_tokens,output_tokens,provider_cost_microusd,provider_request_id,result_ciphertext,result_nonce,result_key_version FROM provider_executions WHERE tenant_id=? AND workflow_id=? AND ordinal=?'),
      providerExecutions:deps.database.prepare<[TenantId,string],ProviderExecutionRow & {ordinal:number}>('SELECT id,ordinal,status,execution_role,model_catalog_id,platform_model_version_id,provider_key,credential_source,input_tokens,output_tokens,provider_cost_microusd,provider_request_id,result_ciphertext,result_nonce,result_key_version FROM provider_executions WHERE tenant_id=? AND workflow_id=? ORDER BY ordinal'),
      multiWorkflow:deps.database.prepare<[TenantId,string],MultiWorkflowRow>('SELECT routing_decision_id,run_id,user_id,conversation_id,assistant_message_id,status FROM multi_model_workflows WHERE tenant_id=? AND id=?'),
      startProviderExecution:deps.database.prepare("UPDATE provider_executions SET credential_source=?,status='streaming',started_at_ms=COALESCE(started_at_ms,?),version=version+1 WHERE tenant_id=? AND id=? AND status='planned'"),
      finishProviderExecution:deps.database.prepare(`UPDATE provider_executions SET status='succeeded',provider_request_id=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,provider_cost_microusd=?,customer_charge_microusd=?,
        baseline_cost_microusd=?,savings_microusd=?,result_ciphertext=?,result_nonce=?,result_key_version=1,result_digest=?,completed_at_ms=?,version=version+1 WHERE tenant_id=? AND id=? AND status='streaming'`),
      billFailedProviderExecution:deps.database.prepare(`UPDATE provider_executions SET status='failed',provider_request_id=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,provider_cost_microusd=?,customer_charge_microusd=?,
        completed_at_ms=?,version=version+1 WHERE tenant_id=? AND id=? AND status='streaming'`),
      failProviderExecution:deps.database.prepare("UPDATE provider_executions SET status='failed',completed_at_ms=?,version=version+1 WHERE tenant_id=? AND id=? AND status IN ('planned','streaming')"),
      claimMultiWorkflow:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows
        SET status='running',next_execution_ordinal=1,lease_owner=?,lease_expires_at_ms=?,attempts=attempts+1,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='planned' AND lease_owner IS NULL`),
      heartbeatMultiWorkflow:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows
        SET lease_expires_at_ms=?,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND lease_owner=? AND status IN ('running','consolidating') AND lease_expires_at_ms>?`),
      advanceMultiWorkflow:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows
        SET status=?,next_execution_ordinal=?,lease_expires_at_ms=?,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND lease_owner=? AND status IN ('running','consolidating') AND lease_expires_at_ms>?`),
      finishMultiWorkflow:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE multi_model_workflows
        SET status=?,next_execution_ordinal=?,completed_at_ms=?,failure_code=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=?,version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND lease_owner=? AND status IN ('running','consolidating') AND lease_expires_at_ms>?`),
      linkMultiUsage:deps.database.prepare('UPDATE provider_executions SET usage_record_id=? WHERE tenant_id=? AND workflow_id=? AND usage_record_id IS NULL AND provider_cost_microusd IS NOT NULL'),
      multiBilling:deps.database.prepare<[TenantId,string],{customer_charge:number;provider_cost:number;input_tokens:number;output_tokens:number;cached_input_tokens:number;platform_count:number;success_count:number}>(`SELECT COALESCE(SUM(customer_charge_microusd),0) customer_charge,COALESCE(SUM(provider_cost_microusd),0) provider_cost,
        COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
        COALESCE(SUM(CASE WHEN credential_source='platform' THEN 1 ELSE 0 END),0) platform_count,COUNT(*) success_count
        FROM provider_executions WHERE tenant_id=? AND workflow_id=? AND status IN ('succeeded','failed','indeterminate') AND provider_cost_microusd IS NOT NULL`),
      catalogPricing:deps.database.prepare<[TenantId,string],{input_price:number;output_price:number;cached_price:number|null}>('SELECT input_microusd_per_million input_price,output_microusd_per_million output_price,cached_input_microusd_per_million cached_price FROM model_catalog WHERE tenant_id=? AND id=?'),
    } as const;
    this.#expireDueWarnings();this.#scheduleDurableWarningSweep();
  }

  async createRun(tenant:TenantContext,input:Input,mode:Mode,idempotency:{key:string;requestHash:string;method:string;path:string}) {
    const tdb=tenant.db; const now=this.#now();
    // requestHash is deterministic but unkeyed. Persist only a tenant-derived HMAC so a database or
    // backup cannot be used to test guesses for low-entropy employee prompts.
    const requestDigest=protectedIdempotencyDigest(this.#approvalPayloadKey,tenant.principal.tenantId,idempotency.requestHash);
    const existing=tdb.get(this.#q.idempotency,tenant.principal.userId,idempotency.method,idempotency.path,idempotency.key);if(existing){if(existing.request_sha256!==requestDigest)throw new Error('IDEMPOTENCY_KEY_REUSED');if(existing.response_json){const saved=JSON.parse(existing.response_json) as {run:ChatRun;assistant:Message};return{run:saved.run,assistant:saved.assistant,providerRequest:{runId:saved.run.id},outboundText:'',replay:true};}const state=existing.run_id?this.#runs.get(existing.run_id):undefined;if(state)return{run:state.run,assistant:state.assistant,providerRequest:{runId:state.run.id},outboundText:state.outboundText,replay:true};throw new Error('IDEMPOTENCY_REPLAY_UNAVAILABLE');}
    const target=mode==='create'?null:this.#ownedMessage(tdb,(input as RegenerateInput|EditResendInput).messageId,tenant.principal.userId);
    if(mode!=='create'&&!target) throw Object.assign(new Error('Source message was not found'),{code:'RESOURCE_NOT_FOUND'});
    let source=target;
    if(mode==='regenerate'){
      if(target?.role!=='assistant'||!target.parent_message_id)throw Object.assign(new Error('Source message was not found'),{code:'RESOURCE_NOT_FOUND'});
      source=this.#ownedMessage(tdb,target.parent_message_id,tenant.principal.userId);
      if(source?.role!=='user'||source.conversation_id!==target.conversation_id)throw Object.assign(new Error('Source message was not found'),{code:'RESOURCE_NOT_FOUND'});
    } else if(mode==='edit-resend'&&target?.role!=='user')throw Object.assign(new Error('Source message was not found'),{code:'RESOURCE_NOT_FOUND'});
    const content=mode==='regenerate'?(source?.text_content??''):('content' in input?input.content:'');
    const requestedEffort='reasoningEffort' in input?input.reasoningEffort:undefined;
    if(requestedEffort!==undefined&&!['low','medium','high'].includes(requestedEffort))throw new TypeError('reasoningEffort must be low, medium, or high');
    const createInput=input as ChatInput;
    const conversationId=mode==='create'?(createInput.conversationId??randomUUID()):source!.conversation_id;
    const ownedConversation=(mode!=='create'||createInput.conversationId)?this.#ownedConversation(tdb,conversationId,tenant.principal.userId):null;
    if((mode!=='create'||createInput.conversationId)&&!ownedConversation)throw Object.assign(new Error('Conversation was not found'),{code:'RESOURCE_NOT_FOUND'});
    const requestedTone='tone' in input?input.tone:undefined;
    const tone:ToneKey=requestedTone??(ownedConversation?.tone as ToneKey|null)??'default';
    const requestedRole='role' in input?input.role:undefined;
    const role:RoleKey=requestedRole??(ownedConversation?.role as RoleKey|null)??'default';
    const assistantId='assistantId' in input?(input.assistantId??null):(ownedConversation?.assistant_id??null);
    const assistantRow=assistantId?tdb.get(this.#q.getAssistantForRun,assistantId):undefined;
    if(assistantId&&!assistantRow)throw Object.assign(new Error('The selected assistant is not available'),{code:'MODEL_NOT_ALLOWED',reason:'chat_model_not_allowed'});
    const newConversation=mode==='create'&&!createInput.conversationId;
    const parent=mode==='create'?(createInput.parentMessageId??null):source!.parent_message_id;
    if(mode==='create'&&parent){
      const ownedParent=newConversation?undefined:this.#ownedMessage(tdb,parent,tenant.principal.userId);
      if(!ownedParent||ownedParent.conversation_id!==conversationId||ownedParent.role!=='assistant')throw Object.assign(new Error('Parent message was not found'),{code:'RESOURCE_NOT_FOUND'});
    }
    const requestedMode='mode' in input?input.mode:undefined;
    const explicitModel='modelId' in input?input.modelId:undefined;
    const hasRoutingSelector=requestedMode!==undefined||explicitModel!==undefined||('provider' in input&&input.provider!==undefined);
    // Only old clients that sent no routing selector inherit the source model. Explicit auto,
    // provider, and multi-model requests must be routed again from the current prompt and effort.
    const requestedModel=assistantRow?.model_catalog_id??explicitModel??(!hasRoutingSelector?(mode==='regenerate'?target?.model_catalog_id:source?.model_catalog_id)??undefined:undefined);
    const routingMode=assistantRow?'single':requestedMode??(requestedModel?'single':'auto');
    const routingEffort:RoutingEffort=requestedEffort==='low'?'fast':requestedEffort==='high'?'deep':'standard';
    const preferredProvider='provider' in input?input.provider:undefined;
    const suppliedIds='fileIds' in input?input.fileIds:undefined;
    const inherited=source?tdb.all(this.#q.messageFiles,source.id,tenant.principal.userId).map(file=>file.id):[];
    const requestedIds=mode==='regenerate'?inherited:mode==='edit-resend'&&suppliedIds===undefined?inherited:suppliedIds??[];
    if(!Array.isArray(requestedIds)||requestedIds.some(id=>typeof id!=='string'))
      throw Object.assign(new Error('Attachment ids must be a list of strings'),{code:'VALIDATION_FAILED',reason:'chat_attachments_invalid'});
    if(requestedIds.length>MAX_CHAT_FILES)
      throw Object.assign(new Error(`A message can attach at most ${MAX_CHAT_FILES} files`),{code:'VALIDATION_FAILED',reason:'chat_too_many_attachments'});
    if(new Set(requestedIds).size!==requestedIds.length)throw Object.assign(new Error('Attachment ids must be unique'),{code:'VALIDATION_FAILED',reason:'chat_attachments_invalid'});
    const attachments=requestedIds.map(id=>this.#ownedReadyFile(tdb,id,tenant.principal.userId));
    const extractedPoints=attachments.reduce((sum,file)=>sum+Array.from(file.extracted_text!).length,0);
    if(extractedPoints>MAX_CHAT_FILE_CODE_POINTS)throw Object.assign(new Error('Attached file text is too large for a governed chat run'),{code:'VALIDATION_FAILED',reason:'chat_attachment_text_too_large'});
    const fileProjects=[...new Set(attachments.map(file=>file.project_id))];
    if(fileProjects.length>1)throw Object.assign(new Error('All attachments in one message must belong to the same project'),{code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'});
    const explicitProject=mode==='create'?(createInput.projectId??null):null;
    const existingProject=ownedConversation?.project_id??null;
    if(existingProject&&explicitProject&&existingProject!==explicitProject)throw Object.assign(new Error('Conversation and attachment project do not match'),{code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'});
    const projectId=existingProject??explicitProject??fileProjects[0]??null;
    if(projectId&&!tdb.get(this.#q.project,projectId,tenant.principal.userId))throw Object.assign(new Error('Project was not found'),{code:'RESOURCE_NOT_FOUND',reason:'chat_project_unavailable'});
    if(fileProjects[0]&&projectId!==fileProjects[0])throw Object.assign(new Error('Attachments must belong to the conversation project'),{code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'});
    const routingTaskText=`${content}\n${attachments.map(file=>file.extracted_text??'').join('\n')}`;
    const estimatedInput=this.#estimateInput(routingTaskText),estimatedOutput=ROUTING_OUTPUT_TOKEN_ESTIMATE;
    let routeSelection:SingleRouteSelection|null=null,multiPlan:FastMultiModelPlan|null=null,model:ModelRow|undefined;
    const routeUnavailableReason=routingMode==='multi_model'?'chat_multi_model_unavailable':requestedModel?'chat_model_not_allowed':preferredProvider?'chat_provider_not_allowed':'chat_no_models_available';
    const candidates=loadRoutingCandidates(this.#database,{tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,inputTokens:estimatedInput,outputTokens:estimatedOutput,now});
    if(routingMode==='multi_model'){
      multiPlan=selectFastMultiModelPlan(candidates);
      const representative=[...multiPlan.executions].sort((left,right)=>right.candidate.estimatedProviderCostMicrousd-left.candidate.estimatedProviderCostMicrousd)[0]?.candidate;
      model=representative?tdb.get(this.#q.model,representative.tenantModelId):undefined;
      if(!model)throw Object.assign(new Error('Multi-model routing could not resolve its governed model'),{code:'MODEL_NOT_ALLOWED',reason:'chat_multi_model_unavailable'});
    }else{
      routeSelection=selectSingleRoute({mode:routingMode,effort:routingEffort,...(!assistantRow&&preferredProvider?{preferredProvider}:{}),...(requestedModel?{preferredTenantModelId:requestedModel}:{}),
        taskText:routingTaskText,stableRoutingKey:`${tenant.principal.tenantId}:${tenant.principal.userId}:${conversationId}`},candidates);
      model=tdb.get(this.#q.model,routeSelection.selected.tenantModelId);
      if(!model||model.platform_model_version_id!==routeSelection.selected.platformModelVersionId
        ||model.provider_key!==routeSelection.selected.provider||model.model_key!==routeSelection.selected.providerModel)
        throw Object.assign(new Error('The routed model metadata changed'),{code:'MODEL_NOT_ALLOWED',reason:routeUnavailableReason});
    }
    if(!model)throw Object.assign(new Error('No model is available'),{code:'MODEL_NOT_ALLOWED',reason:routeUnavailableReason});
    const parsedCapabilities=JSON.parse(model.capabilities_json) as unknown;
    const reasoningEffort:ReasoningEffort=routeSelection?.reasoningEffort??(routingMode==='multi_model'?'none':supportsReasoningEffort(model.provider_key,model.model_key,Array.isArray(parsedCapabilities)?parsedCapabilities.map(String):[])?requestedEffort??'medium':'none');
    const seq=tdb.get(this.#q.nextSequence,conversationId)?.n??0,userId=randomUUID(),assistantMessageId=randomUUID(),runId=randomUUID(),idempotencyId=randomUUID();
    const routeDecisionId=routeSelection||multiPlan?randomUUID():null,multiWorkflowId=multiPlan?randomUUID():null;
    const run:ChatRun={id:runId,conversationId,userMessageId:userId,assistantMessageId,status:'gating',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:new Date(now).toISOString()};
    const assistant=this.#publicMessage({id:assistantMessageId,conversation_id:conversationId,parent_message_id:userId,role:'assistant',status:'pending',sequence_no:seq+1,model_catalog_id:model.id,provider_key:model.provider_key,input_tokens:null,output_tokens:null,cost_microusd:null,policy_action:null,created_at:now,text_content:''});
    const branchAt=mode==='create'?null:source!.sequence_no;
    const history:ChatMessage[]=[...tdb.all(this.#q.history,conversationId,tenant.principal.userId,branchAt,branchAt??0).map(row=>({role:row.role,content:[{type:'text' as const,text:row.text_content??''}]})),{role:'user',content:[{type:'text',text:content}]}];
    try{this.#database.transaction(()=>{
      this.#q.insertIdempotency.run(idempotencyId,tenant.principal.tenantId,tenant.principal.userId,idempotency.method,idempotency.path,idempotency.key,requestDigest,runId,conversationId,userId,assistantMessageId,now,now);
      if(routeDecisionId)this.#q.insertRoutingDecision.run(routeDecisionId,tenant.principal.tenantId,`chat:${idempotencyId}`,runId,tenant.principal.userId,routingMode,assistantRow?null:preferredProvider??null,requestedModel??null,routingEffort,
        routeSelection?.selected.tenantModelId??null,routeSelection?.selected.platformModelVersionId??null,routeSelection?.selected.provider??null,routeSelection?.reasoningEffort??null,
        routeSelection?.baseline.platformModelVersionId??null,routeSelection?.baselineCostMicrousd??null,
        routeSelection?.selected.credentialSource??null,JSON.stringify(routeSelection?.reasons??[`mode:${routingMode}`,'vendor:any','processing:any']),now,now);
    }).immediate();}catch(error){const claimed=tdb.get(this.#q.idempotency,tenant.principal.userId,idempotency.method,idempotency.path,idempotency.key);if(!claimed||claimed.request_sha256!==requestDigest)throw new Error('IDEMPOTENCY_KEY_REUSED');if(claimed.response_json){const saved=JSON.parse(claimed.response_json) as {run:ChatRun;assistant:Message};return{run:saved.run,assistant:saved.assistant,providerRequest:{runId:saved.run.id},outboundText:'',replay:true};}const state=claimed.run_id?this.#runs.get(claimed.run_id):undefined;if(state)return{run:state.run,assistant:state.assistant,providerRequest:{runId:state.run.id},outboundText:state.outboundText,replay:true};throw error;}
    const routedCredential=routeSelection?.selected.credentialSource??multiPlan?.executions[0]?.candidate.credentialSource;
    if(!routedCredential)throw Object.assign(new Error('The governed route has no credential source'),{code:'MODEL_NOT_ALLOWED',reason:routeUnavailableReason});
    const state:RunState={tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,run,assistant,model,messages:history,providerMessages:null,outboundText:content,attachments,projectId,attachmentContextTruncated:false,reasoningEffort,idempotencyId,preflight:null,preflightDirection:'outbound',postflight:null,reservation:null,usage:null,providerRequestId:null,finishReason:null,postflightText:'',cancelled:false,pendingPersistence:null,newConversation,parentMessageId:parent,sequenceNo:seq,editedFromMessageId:mode==='edit-resend'?source!.id:null,confirmedWarnings:{},submittedAction:mode==='regenerate'?'chat.message_regenerated':mode==='edit-resend'?'chat.message_edited_resubmitted':'chat.message_submitted',submitted:false,routingMode,routingEffort,routingPreferredProvider:assistantRow?null:preferredProvider??null,routingPreferredModelId:requestedModel??null,routingTaskText,routingEstimatedOutputTokens:estimatedOutput,routeDecisionId,routeSelection,multiPlan,multiWorkflowId,providerCostMicrousd:null,customerChargeMicrousd:null,baselineCostMicrousd:routeSelection?.baselineCostMicrousd??null,savingsMicrousd:null,credentialSource:routedCredential};
    state.tone=tone;
    state.role=role;
    if(assistantId)state.assistantId=assistantId;
    if(assistantRow)state.assistantPrompt=assistantRow.system_prompt;
    this.#runs.set(runId,state);
    return {run,assistant,providerRequest:{runId},outboundText:content};
  }

  stop():void{if(this.#warningSweepTimer){clearTimeout(this.#warningSweepTimer);this.#warningSweepTimer=null;}}

  async gate(tenant:TenantContext,input:{direction:'outbound'|'inbound'|'file';text:string;runId:string},signal:AbortSignal):Promise<ChatGateResult> {
    const state=this.#state(tenant,input.runId); if(input.direction==='file') throw new Error('File gate is not a chat operation');
    if(input.direction==='outbound')return this.#gatePreflight(tenant,state,input.text,signal);
    const parts=[{id:state.assistant.id,source:'provider_response' as const,text:input.text,mimeType:'text/plain',fileId:null,provenance:{}}];
    const policy=this.#policy(tenant,this.#groups(tenant),state.model.id,'postflight','inbound');
    const verdict=await this.#gate.evaluate(this.#gateContext(tenant,state,'postflight',signal,parts,policy,'inbound'));
    if(!state.postflight||GATE_ACTION_RANK[verdict.action]>=GATE_ACTION_RANK[state.postflight.action])state.postflight=verdict;
    const durableApprovalId=this.#audit.transact(tx=>this.#persistDecision(tenant,state,verdict,input.text,'inbound',tx.append));
    const effective=verdict.displayParts?.[0]?.text??'',replacements=[...verdict.redactions.map(item=>({originalSpan:item.originalSpan,replacement:item.token})),...verdict.masks.map(item=>({originalSpan:item.originalSpan,replacement:item.replacement}))];
    return {decisionId:verdict.evaluationId,action:verdict.action,direction:'inbound',protectedItemCount:replacements.length,effectiveText:effective,replacements,message:this.#gateMessage(verdict.action),...(verdict.warningToken?{confirmationToken:verdict.warningToken}:{}),...(durableApprovalId?{approvalId:durableApprovalId}:{})};
  }

  async reserveBudget(tenant:TenantContext,run:ChatRun):Promise<ChatReservation> {
    const state=this.#state(tenant,run.id); if(!state.preflight) throw new Error('Pre-flight gate has not authorized this run');
    this.#assertAttachmentsCurrent(tenant,state);
    assertProviderTransportAuthorized(state.preflight);
    if(!state.providerMessages)throw new Error('Complete provider context was not authorized');
    const groups=tenant.db.all(this.#q.groups,tenant.principal.userId).map(x=>x.group_id);
    const providerText=state.providerMessages.flatMap(message=>message.content).filter(part=>part.type==='text').map(part=>part.text).join('\n');
    const now=this.#now();
    if(state.routeSelection){
      const candidates=loadRoutingCandidates(this.#database,{tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,inputTokens:this.#estimateInput(providerText),outputTokens:state.routingEstimatedOutputTokens,now});
      const routingIntent={mode:state.routingMode as 'auto'|'single',effort:state.routingEffort,
        ...(state.routingPreferredProvider?{preferredProvider:state.routingPreferredProvider}:{}),
        ...(state.routingPreferredModelId?{preferredTenantModelId:state.routingPreferredModelId}:{}),
        taskText:state.routingTaskText,stableRoutingKey:`${tenant.principal.tenantId}:${tenant.principal.userId}:${state.run.conversationId}`};
      const selection=selectSingleRoute(routingIntent,candidates);
      this.#applyRouteSelection(tenant,state,selection,now);
    }
    if(state.multiPlan){
      const candidates=loadRoutingCandidates(this.#database,{tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,inputTokens:this.#estimateInput(providerText),outputTokens:512,now});
      const plan=selectFastMultiModelPlan(candidates),representative=[...plan.executions].sort((left,right)=>right.candidate.estimatedProviderCostMicrousd-left.candidate.estimatedProviderCostMicrousd)[0]?.candidate;
      const model=representative?tenant.db.get(this.#q.model,representative.tenantModelId):undefined;if(!model)throw Object.assign(new Error('Multi-model routing could not be revalidated'),{code:'MODEL_NOT_ALLOWED',reason:'chat_multi_model_unavailable'});
      if(model.id!==state.model.id){state.model=model;Object.assign(state.assistant,{modelId:model.id,provider:model.provider_key});if(tenant.db.run(this.#q.updateAssistantRoute,model.id,model.provider_key,state.assistant.id).changes!==1)throw new Error('Multi-model route could not update the pending assistant');state.providerMessages=assembleAuthorizedProviderContext({messages:state.providerMessages,attachments:[],modelContextWindow:model.context_window,configuredMaxOutput:model.max_output_tokens}).messages;}
      state.multiPlan=plan;
    }
    const multi=state.multiPlan!==null;
    const estimatedInputTokens=multi?this.#estimateInput(providerText)*5+10*512:this.#estimateInput(providerText);
    const requestedMaxOutputTokens=multi?Math.min(state.model.max_output_tokens,5*512):state.model.max_output_tokens;
    let grant:ReservationGrant|undefined;
    try{
      grant=this.#ledger.reserve({idempotencyKey:`chat:${state.idempotencyId}`,tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,groupIds:groups,conversationId:run.conversationId,messageId:state.assistant.id,modelId:state.model.id,provider:state.model.provider_key,estimatedInputTokens,requestedMaxOutputTokens,now});
      if(state.multiPlan&&state.multiWorkflowId&&state.routeDecisionId){
        this.#database.transaction(()=>{
          this.#q.insertMultiWorkflow.run(state.multiWorkflowId,tenant.principal.tenantId,state.routeDecisionId!,run.id,tenant.principal.userId,run.conversationId,state.assistant.id,now,now);
          for(const execution of state.multiPlan!.executions)this.#q.insertProviderExecution.run(randomUUID(),tenant.principal.tenantId,state.multiWorkflowId,state.routeDecisionId!,execution.ordinal,execution.role,
            `multi:${state.multiWorkflowId}:${execution.ordinal}`,execution.candidate.tenantModelId,execution.candidate.platformModelVersionId,execution.candidate.provider,execution.candidate.credentialSource,now);
          const workflow=tenant.db.get(this.#q.multiWorkflow,state.multiWorkflowId!);
          if(!workflow||workflow.routing_decision_id!==state.routeDecisionId||workflow.run_id!==run.id||workflow.user_id!==tenant.principal.userId||workflow.conversation_id!==run.conversationId||workflow.assistant_message_id!==state.assistant.id||workflow.status!=='planned')throw new Error('Multi-model workflow replay does not match its immutable plan');
          const rows=tenant.db.all(this.#q.providerExecutions,state.multiWorkflowId!);if(rows.length!==5)throw new Error('Multi-model workflow did not persist exactly five executions');
          for(const execution of state.multiPlan!.executions){const row=rows.find(item=>item.ordinal===execution.ordinal);if(!row||row.status!=='planned'||row.execution_role!==execution.role||row.model_catalog_id!==execution.candidate.tenantModelId||row.platform_model_version_id!==execution.candidate.platformModelVersionId||row.provider_key!==execution.candidate.provider)throw new Error('Multi-model execution replay does not match its immutable plan');}
        }).immediate();
      }
    }catch(error){if(grant)this.#ledger.release(grant.reservationId,'chat workflow persistence failed',now);throw error;}
    if(!grant)throw new Error('Chat budget reservation was not created');
    state.reservation=grant; return {id:grant.reservationId};
  }

  async dispatchStarted(tenant:TenantContext,run:ChatRun,reservation:ChatReservation):Promise<void>{const state=this.#state(tenant,run.id);if(state.reservation?.reservationId!==reservation.id)throw new Error('Reservation does not authorize this dispatch');this.#assertAttachmentsCurrent(tenant,state);const now=this.#now();this.#audit.transact(tx=>{const changed=this.#q.dispatchIdempotency.run(now,tenant.principal.tenantId,state.idempotencyId);if(changed.changes!==1)throw new Error('Idempotency claim is not dispatchable');if(state.routeDecisionId&&this.#q.dispatchRoutingDecision.run(now,tenant.principal.tenantId,state.routeDecisionId).changes!==1)throw new Error('Routing decision is not dispatchable');if(state.multiWorkflowId&&tenant.db.run(this.#q.claimMultiWorkflow,this.#multiWorkflowOwner,now+MULTI_MODEL_WORKFLOW_LEASE_MS,now,state.multiWorkflowId).changes!==1)throw new Error('Multi-model workflow is not dispatchable');this.#auditEvent(tenant,state,'chat.provider_called','success',{reservationId:reservation.id,reasoningEffort:state.reasoningEffort,routingMode:state.routingMode},tx.append);});state.run={...state.run,status:'streaming'};}
  async heartbeatReservation(tenant:TenantContext,run:ChatRun,reservation:ChatReservation):Promise<void>{
    const state=this.#state(tenant,run.id),now=this.#now();
    if(state.reservation?.reservationId!==reservation.id)throw new Error('Reservation changed while streaming');
    if(!this.#ledger.heartbeat(reservation.id,now))throw new Error('Chat budget reservation expired while streaming');
    if(state.multiWorkflowId&&tenant.db.run(this.#q.heartbeatMultiWorkflow,now+MULTI_MODEL_WORKFLOW_LEASE_MS,now,state.multiWorkflowId,this.#multiWorkflowOwner,now).changes!==1)throw new Error('Multi-model workflow lease expired while streaming');
  }

  async *streamProvider(tenant:TenantContext,_request:unknown,authorized:{preflightDecisionId:string;reservationId:string;effectiveText:string},signal:AbortSignal):AsyncIterable<ProviderChunk> {
    const state=[...this.#runs.values()].find(x=>x.tenantId===tenant.principal.tenantId&&x.userId===tenant.principal.userId&&x.preflight?.evaluationId===authorized.preflightDecisionId);
    if(!state||state.reservation?.reservationId!==authorized.reservationId) throw new Error('Provider request is not gate and budget authorized');
    assertProviderTransportAuthorized(state.preflight!);
    if(state.multiPlan&&state.multiWorkflowId){
      const controller=new AbortController();this.#aborters.set(state.run.id,controller);const relay=()=>controller.abort();signal.addEventListener('abort',relay,{once:true});
      try{
        const byOrdinal=new Map<number,RoutingCandidate>(state.multiPlan.executions.map(execution=>[execution.ordinal,execution.candidate]));
        const targets=[...new Map(state.multiPlan.executions.map(execution=>[execution.candidate.tenantModelId,{catalogId:execution.candidate.tenantModelId,provider:execution.candidate.provider,modelKey:execution.candidate.providerModel,displayName:execution.candidate.displayName}])).values()];
        const governedContext=(state.providerMessages??[]).map(message=>`${message.role.toUpperCase()}: ${message.content.filter(part=>part.type==='text').map(part=>part.text).join('')}`).join('\n\n');
        const result=await runMultiModel({workflowId:state.multiWorkflowId,originalPrompt:governedContext||authorized.effectiveText,targets,signal:controller.signal,port:{
          execute:(input,roundSignal)=>this.#executeMultiRound(tenant,state,input,roundSignal),
          authorizeOutput:async(input,roundSignal)=>{
            const candidate=byOrdinal.get(input.ordinal);if(!candidate)throw new Error('Multi-model execution plan changed');
            const prior=state.model,target=tenant.db.get(this.#q.model,candidate.tenantModelId);if(!target)throw new Error('Multi-model target disappeared');
            state.model=target;
            // The lease is stamped after the gate returns, not before it: gating can take seconds and
            // an earlier reading would hand the recovery worker a workflow that only looks abandoned.
            try{const verdict=await this.gate(tenant,{direction:'inbound',text:input.text,runId:state.run.id},roundSignal);if(verdict.action==='block'||verdict.action==='warn'||verdict.action==='require_approval')throw Object.assign(new Error('Multi-model intermediate output was withheld by policy'),{code:'GATE_BLOCKED'});const now=this.#now();if(tenant.db.run(this.#q.advanceMultiWorkflow,input.ordinal===5?'consolidating':'running',input.ordinal+1,now+MULTI_MODEL_WORKFLOW_LEASE_MS,now,state.multiWorkflowId,this.#multiWorkflowOwner,now).changes!==1)throw new Error('Multi-model workflow lease was lost');return verdict.effectiveText;}
            finally{state.model=prior;}
          },
        }});
        state.providerCostMicrousd=result.providerCostMicrousd;
        const aggregate=this.#q.multiBilling.get(tenant.principal.tenantId,state.multiWorkflowId),source=(aggregate?.platform_count??0)>0?'platform':'byok';
        state.customerChargeMicrousd=aggregate?.customer_charge??0;state.credentialSource=source;state.savingsMicrousd=null;
        state.usage={inputTokens:result.inputTokens,outputTokens:result.outputTokens,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:result.inputTokens+result.outputTokens,estimated:false,source:'provider'};
        state.providerRequestId=`multi:${state.multiWorkflowId}`;state.finishReason='stop';
        const completedAt=this.#now();if(tenant.db.run(this.#q.finishMultiWorkflow,'completed',6,completedAt,null,completedAt,state.multiWorkflowId,this.#multiWorkflowOwner,completedAt).changes!==1)throw new Error('Multi-model workflow completion fence was lost');
        yield{type:'text',text:result.text};
        yield{type:'usage',inputTokens:result.inputTokens,outputTokens:result.outputTokens,costUsd:(aggregate?.provider_cost??0)/1_000_000};
        return;
      }catch(error){
        const aggregate=this.#q.multiBilling.get(tenant.principal.tenantId,state.multiWorkflowId);
        if((aggregate?.success_count??0)>0){
          state.providerCostMicrousd=aggregate!.provider_cost;state.customerChargeMicrousd=aggregate!.customer_charge;
          state.credentialSource=aggregate!.platform_count>0?'platform':'byok';state.providerRequestId=`multi:${state.multiWorkflowId}:partial`;state.finishReason='error';
          state.usage={inputTokens:aggregate!.input_tokens,outputTokens:aggregate!.output_tokens,reasoningTokens:0,cachedInputTokens:aggregate!.cached_input_tokens,cacheWriteTokens:0,toolInputTokens:0,totalTokens:aggregate!.input_tokens+aggregate!.output_tokens,estimated:false,source:'provider'};
        }
        const failedAt=this.#now();tenant.db.run(this.#q.finishMultiWorkflow,signal.aborted?'cancelled':'failed',1,null,signal.aborted?'multi_model_cancelled':'multi_model_execution_failed',failedAt,state.multiWorkflowId,this.#multiWorkflowOwner,failedAt);throw error;
      }
      finally{signal.removeEventListener('abort',relay);this.#aborters.delete(state.run.id);}
    }
    // Rebuild the final user part from the verdict. This is also used for retries/fallbacks by callers.
    const messages=state.providerMessages;
    if(!messages)throw new Error('Complete provider context was not authorized');
    const entry=this.#catalogEntry(state.model); const resolved=this.#providerFor(tenant.principal.tenantId,state.model.provider_key,state.credentialSource),provider=resolved.provider;state.credentialSource=resolved.credentialSource;
    // This is the actual registry resolution, not the route's earlier prediction. Persist it against
    // the exact reservation before entering provider code so restart billing can distinguish platform
    // markup from BYOK zero-charge without guessing from mutable provider configuration.
    if(tenant.db.run(this.#q.checkpointCredentialSource,state.credentialSource,state.reservation.reservationId).changes!==1)
      throw new Error('Provider credential source could not be checkpointed before dispatch');
    const controller=new AbortController(); this.#aborters.set(state.run.id,controller); const relay=()=>controller.abort(); signal.addEventListener('abort',relay,{once:true});
    const request:ChatRequest={context:{requestId:tenant.requestId,streamId:state.run.id,tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,groupIds:[],conversationId:state.run.conversationId,sourceMessageId:state.run.userMessageId,locale:'en'},provider:state.model.provider_key,protocol:entry.protocol,model:state.model.model_key,messages,tools:[],toolChoice:'none',maxOutputTokens:state.reservation.allowedMaxOutputTokens,reasoningEffort:state.reasoningEffort,stop:[],metadata:{gateDecisionId:authorized.preflightDecisionId},signal:controller.signal};
    let cumulative='',usage:Usage|null=null;
    try {
      for await(const event of provider.stream(request)){
        if(event.type==='start')state.providerRequestId=event.providerRequestId??request.context.requestId;
        else if(state.providerRequestId===null)state.providerRequestId=request.context.requestId;
        const chunk=this.#providerChunk(event);
        if(event.type==='finish')state.finishReason=event.reason;
        if(event.type==='usage'){usage=event.usage;state.usage=event.usage;}
        if(chunk&&chunk.type!=='usage'){cumulative+=chunk.text;state.postflightText=cumulative;yield chunk;}
      }
      const finalUsage=usage??estimateUsage(request,cumulative);state.usage=finalUsage;this.#recordStateBilling(state,finalUsage);
      yield {type:'usage',inputTokens:finalUsage.inputTokens,outputTokens:finalUsage.outputTokens,costUsd:(state.providerCostMicrousd??0)/1_000_000};
    }catch(error){
      if(state.providerRequestId!==null||usage!==null||cumulative.length>0){
        const partialUsage=usage??estimateUsage(request,cumulative);state.usage=partialUsage;state.postflightText=cumulative;state.finishReason??='error';this.#recordStateBilling(state,partialUsage);
      }
      throw error;
    }
    finally { signal.removeEventListener('abort',relay);this.#aborters.delete(state.run.id); }
  }

  async persistEvent(tenant:TenantContext,runId:string,eventId:number,event:StreamEvent):Promise<void>{const state=this.#state(tenant,runId);const list=this.#events.get(runId)??[];list.push({id:eventId,event});if(list.length>256)list.shift();this.#events.set(runId,list);const waiting=this.#eventWaiters.get(runId);if(waiting){this.#eventWaiters.delete(runId);for(const wake of waiting)wake();}if(event.event==='run.status'&&event.data.status==='awaiting_confirmation')this.#scheduleDurableWarningSweep();else if((event.event==='run.status'&&event.data.status==='awaiting_approval')||event.event==='run.completed'||event.event==='run.failed'||event.event==='run.cancelled')this.#cleanupRun(runId);}

  async complete(tenant:TenantContext,run:ChatRun,assistant:Message,text:string,usage:UsageSummary,reservation:ChatReservation,protectedItemCount?:number):Promise<Message>{
    const state=this.#state(tenant,run.id);const settled=this.#settle(state,reservation,'complete',usage.inputTokens,usage.outputTokens);const now=this.#now();
    const billed=state.providerCostMicrousd??settled.chargedCostMicros,count=protectedItemCount??(state.postflight?state.postflight.redactions.length+state.postflight.masks.length:0);
    const completed={...state.assistant,content:text,inputTokens:settled.chargedInputTokens,outputTokens:settled.chargedOutputTokens,costUsd:billed/1_000_000,gate:state.postflight?{decisionId:state.postflight.evaluationId,action:state.postflight.action,direction:'inbound' as const,detectorCount:new Set(state.postflight.matches.map(match=>match.detectorKind)).size,protectedItemCount:count,approvalId:null,userNotice:null}:null};
    state.pendingPersistence=()=>{this.#q.updatePart.run(text,(state.postflight?.redactions.length??0)>0?'redacted_text':'text',tenant.principal.tenantId,state.assistant.id);this.#q.completeMessage.run(tenant.principal.tenantId,'complete',settled.chargedInputTokens,settled.chargedOutputTokens,billed,state.postflight?.action??'allow',count,state.providerRequestId,state.finishReason??'stop',now,state.assistant.id);this.#q.touchConversation.run(now,tenant.principal.tenantId,run.conversationId);if(state.routeDecisionId)this.#q.finishRoutingDecision.run('completed',now,now,tenant.principal.tenantId,state.routeDecisionId);};
    state.run={...state.run,status:'completed'};state.assistant=completed;state.postflightText=text;return completed;
  }

  async fail(tenant:TenantContext,run:ChatRun,reservation:ChatReservation|null,error:ApiError['error'],replay:{partialMessageId:string|null;gateNotice?:Extract<StreamEvent,{event:'gate.notice'}>['data']}):Promise<void>{
    const state=this.#state(tenant,run.id),aborted=state.cancelled||error.message==='Run cancelled';
    if(reservation&&state.reservation){if(state.usage||state.providerRequestId)this.#settle(state,reservation,aborted?'client_aborted':'provider_error',state.usage?.inputTokens??null,state.usage?.outputTokens??null);else this.#ledger.release(reservation.id,aborted?'client disconnected before provider acceptance':'provider failed before acceptance',this.#now());}
    const now=this.#now();state.pendingPersistence=()=>{this.#q.failMessage.run(aborted?'stopped':'failed',error.code,state.preflight?.action??null,now,tenant.principal.tenantId,state.assistant.id);if(state.routeDecisionId)this.#q.finishRoutingDecision.run(aborted?'cancelled':'failed',now,now,tenant.principal.tenantId,state.routeDecisionId);if(state.multiWorkflowId)tenant.db.run(this.#q.finishMultiWorkflow,aborted?'cancelled':'failed',1,null,aborted?'multi_model_cancelled':error.code,now,state.multiWorkflowId,this.#multiWorkflowOwner,now);};state.run={...state.run,status:aborted?'cancelled':'failed'};state.error=error;state.failurePartialMessageId=replay.partialMessageId;if(replay.gateNotice)state.failureGateNotice=replay.gateNotice;else delete state.failureGateNotice;
  }
  async audit(tenant:TenantContext,run:ChatRun,outcome:'success'|'failure'|'denied',metadata:Readonly<Record<string,unknown>>):Promise<void>{const state=this.#state(tenant,run.id);this.#auditEvent(tenant,state,outcome==='success'?'chat.message_completed':'chat.message_stopped',outcome,metadata);state.pendingPersistence?.();state.pendingPersistence=null;const now=this.#now(),response=JSON.stringify({run:state.run,assistant:state.assistant,...(state.run.status==='failed'&&state.error?{error:state.error,...(state.failurePartialMessageId!==undefined?{partialMessageId:state.failurePartialMessageId}:{}),...(state.failureGateNotice?{gateNotice:state.failureGateNotice}:{})}:{})});this.#q.finishIdempotency.run(outcome==='success'?'completed':'failed',response,now,now,tenant.principal.tenantId,state.idempotencyId);}
  async getRun(tenant:TenantContext,id:string):Promise<ChatRun|null>{const saved=tenant.db.get(this.#q.idempotencyRun,tenant.principal.userId,id);if(saved?.response_json)return(JSON.parse(saved.response_json) as {run:ChatRun}).run;const state=this.#runs.get(id);return state?.tenantId===tenant.principal.tenantId&&state.userId===tenant.principal.userId?state.run:null;}
  async *replay(tenant:TenantContext,id:string,after:number,signal:AbortSignal){const saved=tenant.db.get(this.#q.idempotencyRun,tenant.principal.userId,id);if(saved?.response_json){const response=JSON.parse(saved.response_json) as DurableRunResponse,events=durableReplayEvents(id,response);for(let index=0;index<events.length;index++)if(index+1>after)yield{id:index+1,event:events[index]!};return;}const state=this.#runs.get(id);if(state?.tenantId===tenant.principal.tenantId&&state.userId===tenant.principal.userId){let cursor=after;while(!signal.aborted){const available=(this.#events.get(id)??[]).filter(item=>item.id>cursor);for(const item of available){if(signal.aborted)return;cursor=item.id;yield item;if(closesReplayStream(item.event))return;}
      // Register before checking the buffer again. An event can arrive while the consumer handles the
      // last yield; the second check closes that lost-wakeup window without polling the database.
      let wake=()=>{};const pending=new Promise<void>(resolve=>{const finish=()=>{signal.removeEventListener('abort',finish);const waiters=this.#eventWaiters.get(id);waiters?.delete(finish);if(waiters?.size===0)this.#eventWaiters.delete(id);resolve();};wake=finish;const waiters=this.#eventWaiters.get(id)??new Set<()=>void>();waiters.add(finish);this.#eventWaiters.set(id,waiters);signal.addEventListener('abort',finish,{once:true});});
      if(signal.aborted||(this.#events.get(id)??[]).some(item=>item.id>cursor))wake();
      await pending;
    }return;}throw new Error('Chat run was not found');}
  async cancel(tenant:TenantContext,id:string):Promise<'accepted'|'terminal'|'missing'>{const saved=tenant.db.get(this.#q.idempotencyRun,tenant.principal.userId,id);if(saved?.response_json){const response=JSON.parse(saved.response_json) as {run:ChatRun};if(['completed','failed','cancelled'].includes(response.run.status))return'terminal';}const state=this.#runs.get(id);if(!state||state.tenantId!==tenant.principal.tenantId||state.userId!==tenant.principal.userId)return'missing';if(['completed','failed','cancelled'].includes(state.run.status))return'terminal';state.cancelled=true;this.#aborters.get(id)?.abort();return'accepted';}
  /**
   * Hands a confirmed warning back its run. The text the user actually typed survives only here: a
   * warned preflight returns `providerParts:null`, so what reached `message_parts` is the placeholder
   * `#gateMessage('warn')` and the row cannot be used to reconstruct the send.
   *
   * The token is taken as an argument and never read from the request body. `assertProviderTransportAuthorized`
   * only tests it for truthiness, so a token accepted from the caller would skip verification, single
   * use and the audit entry all at once — the whole point of the confirmation.
   */
  async authorizeWarnedRun(tenant:TenantContext,evaluationId:string,confirmation:{token:string;policyFingerprint:string}):Promise<{run:ChatRun;assistant:Message;providerRequest:unknown;outboundText:string;mode:'auto'|'single'|'multi_model'}|null>{
    const state=[...this.#runs.values()].find(x=>x.tenantId===tenant.principal.tenantId&&x.userId===tenant.principal.userId&&x.preflight?.evaluationId===evaluationId&&x.preflight.disposition==='await_user_confirmation');
    if(!state)return null;
    this.#assertAttachmentsCurrent(tenant,state);
    const preflight=state.preflight;if(!preflight)return null;
    const file=state.preflightDirection==='file';
    const ruleIds=[...new Set(preflight.matches.filter(match=>match.action==='warn'&&(file?match.partId.startsWith('file:'):!match.partId.startsWith('file:'))).map(match=>match.ruleId))];
    if(ruleIds.length===0)throw new Error('Confirmed warning has no matching rule');
    state.confirmedWarnings[state.preflightDirection]={evaluationId,...confirmation,ruleIds};
    return {run:state.run,assistant:state.assistant,providerRequest:{runId:state.run.id},outboundText:state.outboundText,mode:state.routingMode};
  }

  policyFingerprint(tenant:TenantContext):string {
    const state=[...this.#runs.values()].find(run=>run.tenantId===tenant.principal.tenantId&&run.userId===tenant.principal.userId);
    if(state)return this.#preflightPolicies(tenant,state).fingerprint;
    const durable=this.#database.prepare<[TenantId,string],{model_id:string}>(`SELECT m.model_catalog_id model_id FROM idempotency_records i JOIN messages m ON m.tenant_id=i.tenant_id AND m.id=i.assistant_message_id
      WHERE i.tenant_id=? AND i.actor_user_id=? AND m.model_catalog_id IS NOT NULL ORDER BY i.updated_at DESC LIMIT 1`).get(tenant.principal.tenantId,tenant.principal.userId);
    if(!durable)throw new Error('No governed run is available for policy fingerprinting');
    const groups=this.#groups(tenant),outbound=this.#policy(tenant,groups,durable.model_id,'preflight','outbound'),file=this.#policy(tenant,groups,durable.model_id,'preflight','file');
    return createHash('sha256').update(`${outbound.fingerprint}\n${file.fingerprint}`).digest('hex');
  }

  #recordStateBilling(state:RunState,usage:Usage):void {
    const providerCost=estimateModelCostMicrousd({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cachedInputTokens:usage.cachedInputTokens,
      inputMicrousdPerMillion:state.model.input_microusd_per_million,
      outputMicrousdPerMillion:state.model.output_microusd_per_million,
      cachedInputMicrousdPerMillion:state.model.cached_input_microusd_per_million});
    const billing=calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource:state.credentialSource==='byok'?'byok':'platform'});
    state.providerCostMicrousd=providerCost;state.customerChargeMicrousd=billing.customerChargeMicrousd;
  }

  #settle(state:RunState,reservation:ChatReservation,outcome:SettlementInput['outcome'],input:number|null,output:number|null){
    const now=this.#now(),settled=this.#ledger.settle({reservationId:reservation.id,providerRequestId:state.providerRequestId,providerModel:state.model.model_key,actualInputTokens:input,actualCachedInputTokens:state.usage?.cachedInputTokens??null,actualOutputTokens:output,...(state.providerCostMicrousd===null?{}:{actualCostMicros:state.providerCostMicrousd}),locallyCountedOutputTokens:output??this.#estimateInput(state.postflightText),usageQuality:state.usage?'provider_actual':'estimated',finishReason:state.finishReason,outcome,now});
    const providerCost=state.providerCostMicrousd??settled.chargedCostMicros,source=state.credentialSource;
    let baselineCost:number|null=null;
    if(state.routeSelection){
      const pricing=this.#database.prepare<[string,string],{input_price:number;output_price:number;cached_price:number|null}>(`SELECT input_microusd_per_million input_price,
        output_microusd_per_million output_price,cached_input_microusd_per_million cached_price FROM model_catalog WHERE tenant_id=? AND id=?`)
        .get(state.tenantId,state.routeSelection.baseline.tenantModelId);
      if(pricing)baselineCost=estimateModelCostMicrousd({inputTokens:settled.chargedInputTokens,outputTokens:settled.chargedOutputTokens,cachedInputTokens:state.usage?.cachedInputTokens??0,inputMicrousdPerMillion:pricing.input_price,outputMicrousdPerMillion:pricing.output_price,cachedInputMicrousdPerMillion:pricing.cached_price});
    }
    const billing=calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource:source==='byok'?'byok':'platform',baselineCostMicrousd:baselineCost});
    state.providerCostMicrousd=providerCost;state.customerChargeMicrousd=state.customerChargeMicrousd??billing.customerChargeMicrousd;state.baselineCostMicrousd=baselineCost;state.savingsMicrousd=billing.savingsMicrousd;
    this.#q.linkUsageBilling.run(providerCost,state.customerChargeMicrousd,source,baselineCost,state.savingsMicrousd,state.routeSelection?.selected.platformModelVersionId??state.model.platform_model_version_id,state.routeDecisionId,state.tenantId,settled.usageEventId);
    if(state.multiWorkflowId)this.#q.linkMultiUsage.run(settled.usageEventId,state.tenantId,state.multiWorkflowId);
    return settled;
  }
  #applyRouteSelection(tenant:TenantContext,state:RunState,selection:SingleRouteSelection,now:number):void {
    const changedModel=state.model.id!==selection.selected.tenantModelId;
    if(changedModel){
      const model=tenant.db.get(this.#q.model,selection.selected.tenantModelId);if(!model)throw new Error('Selected route disappeared before dispatch');
      state.model=model;state.reasoningEffort=selection.reasoningEffort;
      Object.assign(state.assistant,{modelId:model.id,provider:model.provider_key});
      if(tenant.db.run(this.#q.updateAssistantRoute,model.id,model.provider_key,state.assistant.id).changes!==1)throw new Error('Selected route could not update the pending assistant');
      if(!state.providerMessages)throw new Error('Authorized provider context is unavailable');
      state.providerMessages=assembleAuthorizedProviderContext({messages:state.providerMessages,attachments:[],modelContextWindow:model.context_window,configuredMaxOutput:model.max_output_tokens}).messages;
    }
    state.routeSelection=selection;state.credentialSource=selection.selected.credentialSource;state.baselineCostMicrousd=selection.baselineCostMicrousd;
    if(state.routeDecisionId){
      const updated=this.#q.updateRoutingSelection.run(selection.selected.tenantModelId,selection.selected.platformModelVersionId,selection.selected.provider,selection.reasoningEffort,
        selection.selected.credentialSource,JSON.stringify(selection.reasons),now,tenant.principal.tenantId,state.routeDecisionId);
      if(updated.changes!==1)throw new Error('Routing decision could not be finalized');
    }
  }
  #providerFor(tenantId:string,provider:Provider,fallback:'platform'|'byok'|'legacy_unknown'):{provider:ChatProvider;credentialSource:'platform'|'byok'}{return this.#tenantProviders?.resolve(tenantId,provider)??{provider:this.#providers.get(provider),credentialSource:fallback==='byok'?'byok':'platform'};}
  async #executeMultiRound(tenant:TenantContext,state:RunState,input:MultiModelExecution,signal:AbortSignal):Promise<MultiModelExecutionResult>{
    const row=this.#q.providerExecution.get(tenant.principal.tenantId,input.workflowId,input.ordinal);
    if(!row||row.execution_role!==input.step||row.model_catalog_id!==input.target.catalogId||row.provider_key!==input.target.provider)throw new Error('Multi-model execution does not match its durable plan');
    if(row.status==='succeeded'){
      if(!row.result_ciphertext||!row.result_nonce||row.result_key_version!==1||row.input_tokens===null||row.output_tokens===null||row.provider_cost_microusd===null)throw new Error('Multi-model checkpoint is incomplete');
      return{text:this.#openMultiResult(tenant.principal.tenantId,input.workflowId,input.ordinal,row.result_ciphertext,row.result_nonce),inputTokens:row.input_tokens,outputTokens:row.output_tokens,providerCostMicrousd:row.provider_cost_microusd,providerRequestId:row.provider_request_id};
    }
    if(row.status!=='planned')throw new Error('Multi-model execution is not safely dispatchable');
    let request:ChatRequest|null=null,text='',usage:Usage|null=null,providerRequestId:string|null=null,streamStarted=false;
    let credentialSource:ProviderExecutionRow['credential_source']=row.credential_source;
    try{
      const now=this.#now(),model=tenant.db.get(this.#q.model,input.target.catalogId);if(!model||model.platform_model_version_id!==row.platform_model_version_id)throw new Error('Multi-model target metadata changed');
      const live=eligibleRoutingCandidates({},loadRoutingCandidates(this.#database,{tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,inputTokens:this.#estimateInput(input.prompt),outputTokens:512,now})).find(candidate=>candidate.tenantModelId===row.model_catalog_id&&candidate.platformModelVersionId===row.platform_model_version_id&&candidate.provider===row.provider_key);
      if(!live||!live.multiModelEligible||live.speedClass!=='fast'||live.qualityTier!==1)throw Object.assign(new Error('Multi-model authorization changed before dispatch'),{code:'MODEL_NOT_ALLOWED',reason:'chat_multi_model_unavailable'});
      const resolved=this.#providerFor(tenant.principal.tenantId,input.target.provider,row.credential_source);credentialSource=resolved.credentialSource;if(this.#q.startProviderExecution.run(credentialSource,this.#now(),tenant.principal.tenantId,row.id).changes!==1)throw new Error('Multi-model execution is not safely dispatchable');const provider=resolved.provider,entry=this.#catalogEntry(model);
      const capabilities=JSON.parse(model.capabilities_json) as unknown,reasoning:ReasoningEffort=supportsReasoningEffort(model.provider_key,model.model_key,Array.isArray(capabilities)?capabilities.map(String):[])?'low':'none';
      const perRound=Math.floor((state.reservation?.allowedMaxOutputTokens??0)/5);if(perRound<16)throw Object.assign(new Error('Budget cannot reserve five bounded multi-model rounds'),{code:'BUDGET_HARD_LIMIT'});
      request={context:{requestId:`${tenant.requestId}:${input.ordinal}`,streamId:`${state.run.id}:${input.ordinal}`,tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,groupIds:[],conversationId:state.run.conversationId,sourceMessageId:state.run.userMessageId,locale:'en'},provider:model.provider_key,protocol:entry.protocol,model:model.model_key,messages:[{role:'user',content:[{type:'text',text:input.prompt}]}],tools:[],toolChoice:'none',maxOutputTokens:Math.min(512,perRound),reasoningEffort:reasoning,stop:[],metadata:{gateDecisionId:state.preflight?.evaluationId??'',multiModelWorkflowId:input.workflowId,multiModelOrdinal:String(input.ordinal),multiModelStep:input.step},signal};
      for await(const event of provider.stream(request)){streamStarted=true;if(event.type==='start')providerRequestId=event.providerRequestId??request.context.requestId;else{providerRequestId??=request.context.requestId;if(event.type==='text_delta')text+=event.delta;else if(event.type==='usage')usage=event.usage;}}
      const measured=usage??estimateUsage(request,text),pricing=this.#q.catalogPricing.get(tenant.principal.tenantId,row.model_catalog_id);if(!pricing)throw new Error('Multi-model catalogue pricing disappeared');const providerCost=estimateModelCostMicrousd({inputTokens:measured.inputTokens,outputTokens:measured.outputTokens,cachedInputTokens:measured.cachedInputTokens,inputMicrousdPerMillion:pricing.input_price,outputMicrousdPerMillion:pricing.output_price,cachedInputMicrousdPerMillion:pricing.cached_price});
      const billed=calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource}),sealed=this.#sealMultiResult(tenant.principal.tenantId,input.workflowId,input.ordinal,text),at=this.#now();
      const changed=this.#q.finishProviderExecution.run(providerRequestId,measured.inputTokens,measured.outputTokens,measured.cachedInputTokens,providerCost,billed.customerChargeMicrousd,null,null,sealed.ciphertext,sealed.nonce,createHash('sha256').update(sealed.ciphertext).digest('hex'),at,tenant.principal.tenantId,row.id);
      if(changed.changes!==1)throw new Error('Multi-model checkpoint could not be committed');
      return{text,inputTokens:measured.inputTokens,outputTokens:measured.outputTokens,providerCostMicrousd:providerCost,providerRequestId};
    }catch(error){
      let billedFailure=false;
      if(request&&streamStarted){
        const measured=usage??estimateUsage(request,text),pricing=this.#q.catalogPricing.get(tenant.principal.tenantId,row.model_catalog_id);
        if(pricing){
          const providerCost=estimateModelCostMicrousd({inputTokens:measured.inputTokens,outputTokens:measured.outputTokens,cachedInputTokens:measured.cachedInputTokens,inputMicrousdPerMillion:pricing.input_price,outputMicrousdPerMillion:pricing.output_price,cachedInputMicrousdPerMillion:pricing.cached_price});
          const billed=calculateUsageBilling({providerCostMicrousd:providerCost,credentialSource});
          billedFailure=this.#q.billFailedProviderExecution.run(providerRequestId??request.context.requestId,measured.inputTokens,measured.outputTokens,measured.cachedInputTokens,providerCost,billed.customerChargeMicrousd,this.#now(),tenant.principal.tenantId,row.id).changes===1;
        }
      }
      if(!billedFailure)this.#q.failProviderExecution.run(this.#now(),tenant.principal.tenantId,row.id);
      throw error;
    }
  }
  #sealMultiResult(tenantId:string,workflowId:string,ordinal:number,text:string):{ciphertext:Buffer;nonce:Buffer}{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#multiModelResultKey,nonce);cipher.setAAD(Buffer.from(`${CRYPTO_NAMESPACE}:multi-result:v1:${tenantId}:${workflowId}:${ordinal}`));const body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return{ciphertext:Buffer.concat([cipher.getAuthTag(),body]),nonce};}
  #openMultiResult(tenantId:string,workflowId:string,ordinal:number,ciphertext:Buffer,nonce:Buffer):string{if(ciphertext.byteLength<17||nonce.byteLength!==12)throw new Error('Multi-model checkpoint envelope is invalid');const decipher=createDecipheriv('aes-256-gcm',this.#multiModelResultKey,nonce);decipher.setAAD(Buffer.from(`${CRYPTO_NAMESPACE}:multi-result:v1:${tenantId}:${workflowId}:${ordinal}`));decipher.setAuthTag(ciphertext.subarray(0,16));return Buffer.concat([decipher.update(ciphertext.subarray(16)),decipher.final()]).toString('utf8');}
  #state(tenant:TenantContext,id:string):RunState{const state=this.#runs.get(id);if(!state||state.tenantId!==tenant.principal.tenantId||state.userId!==tenant.principal.userId)throw new Error('Chat run was not found');return state;}
  #assertAttachmentsCurrent(tenant:TenantContext,state:RunState):void {
    const currentProject=tenant.db.get(this.#q.projectLink,state.run.conversationId)?.project_id??null;
    if(!state.newConversation&&currentProject!==state.projectId)throw Object.assign(new Error('Conversation project changed after the run was prepared'),{code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'});
    for(const attachment of state.attachments){
      const current=this.#ownedReadyFile(tenant.db,attachment.id,tenant.principal.userId);
      if(current.project_id!==attachment.project_id||current.original_name!==attachment.original_name||current.mime_type!==attachment.mime_type||current.byte_size!==attachment.byte_size||current.sha256!==attachment.sha256||current.extracted_text!==attachment.extracted_text||current.created_at!==attachment.created_at)
        throw Object.assign(new Error('Attachment changed after the run was prepared'),{code:'VALIDATION_FAILED',reason:'chat_attachment_unavailable'});
      if(state.projectId!==current.project_id)throw Object.assign(new Error('Attachment project changed after the run was prepared'),{code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'});
    }
  }
  #expireDueWarnings():number {
    const now=this.#now(),rows=this.#q.dueWarnings.all(this.#waitingRunTtlMs,now);let expired=0;
    for(const row of rows){
      const db=forTenant({tenantId:row.tenant_id});
      const changed=this.#audit.transact(tx=>{
        if(db.run(this.#q.expireWarningDecision,row.evaluation_id).changes!==1)return false;
        if(row.message_id)db.run(this.#q.expireWarningViolation,now,row.message_id,row.direction);
        if(row.assistant_message_id){db.run(this.#q.expireWarningMessage,now,row.assistant_message_id);db.run(this.#q.expireWarningPart,row.assistant_message_id);}
        let response:string|null=null;
        const memory=row.run_id?this.#runs.get(row.run_id):undefined;
        const saved=row.response_json?JSON.parse(row.response_json) as {run:ChatRun;assistant:Message}:memory?{run:memory.run,assistant:memory.assistant}:null;
        if(saved)response=JSON.stringify({run:{...saved.run,status:'cancelled'},assistant:{...saved.assistant,content:'Request was not sent.'}});
        if(row.idempotency_id)db.run(this.#q.expireWarningRun,response,now,now,row.idempotency_id);
        let detectors:unknown=[];try{detectors=JSON.parse(row.matched_detector_keys_json);}catch{detectors=[];}
        const detector=Array.isArray(detectors)&&typeof detectors[0]==='string'?detectors[0]:null;
        tx.append({tenantId:row.tenant_id,action:'gate.warning_declined',actor:{type:'service',id:'chat-warning-expiry',sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'message',id:row.message_id??row.evaluation_id},outcome:'cancelled',context:{requestId:`warning:${row.evaluation_id}`,traceId:null,source:'worker',occurredAtMs:now},subjectUserId:row.user_id,conversationId:row.conversation_id,messageId:row.message_id,gateAction:'warn',detector,metadata:{evaluationId:row.evaluation_id,reasonCode:'warning_expired'}});
        return true;
      });
      if(changed){expired++;if(row.run_id)this.#cleanupRun(row.run_id);}
    }
    return expired;
  }
  #scheduleDurableWarningSweep():void {
    if(this.#warningSweepTimer){clearTimeout(this.#warningSweepTimer);this.#warningSweepTimer=null;}
    const due=this.#q.nextWarningDue.get(this.#waitingRunTtlMs)?.due;if(due===null||due===undefined)return;
    const retryFloor=this.#warningSweepFailures===0?0:Math.min(2_147_483_647,this.#warningSweepRetryMaxMs,this.#warningSweepRetryBaseMs*2**Math.min(30,this.#warningSweepFailures-1));
    const delay=Math.max(retryFloor,Math.max(0,Math.min(2_147_483_647,due-this.#now())));
    this.#warningSweepTimer=setTimeout(()=>{this.#warningSweepTimer=null;try{this.#expireDueWarnings();this.#warningSweepFailures=0;}catch{this.#warningSweepFailures++;this.#logger.error('Warning expiry sweep failed');}finally{this.#scheduleDurableWarningSweep();}},delay);
    this.#warningSweepTimer.unref();
  }
  #cleanupRun(id:string):void {
    this.#aborters.get(id)?.abort();this.#aborters.delete(id);this.#runs.delete(id);this.#events.delete(id);
    const waiting=this.#eventWaiters.get(id);this.#eventWaiters.delete(id);for(const wake of waiting??[])wake();
  }
  #ownedConversation(db:TenantDb,id:string,user:string):ConversationRow|undefined{return db.get(this.#q.conversation,id,user);}
  #ownedMessage(db:TenantDb,id:string,user:string):MessageRow|undefined{return db.get(this.#q.message,id,user);}
  #ownedReadyFile(db:TenantDb,id:string,user:string):AttachmentRow {
    const file=db.get(this.#q.file,id,user);
    if(!file||file.deleted_at!==null)throw Object.assign(new Error('Attachment was not found'),{code:'RESOURCE_NOT_FOUND',reason:'chat_attachment_unavailable'});
    if(file.content_purged_at!==null||file.extraction_status!=='ready'||file.extracted_text===null)
      throw Object.assign(new Error('Attachment extraction did not complete safely'),{code:'VALIDATION_FAILED',reason:'chat_attachment_unavailable'});
    return file;
  }
  #groups(tenant:TenantContext):string[]{return tenant.db.all(this.#q.groups,tenant.principal.userId).map(x=>x.group_id);}
  #estimateInput(text:string):number{return estimateChatInputTokens(text);}
  #publicMessage(r:MessageRow):Message{return{id:r.id,conversationId:r.conversation_id,parentMessageId:r.parent_message_id,role:r.role,content:r.text_content??'',modelId:r.model_catalog_id,provider:r.provider_key,createdAt:new Date(r.created_at).toISOString(),inputTokens:r.input_tokens,outputTokens:r.output_tokens,costUsd:r.cost_microusd===null?null:r.cost_microusd/1_000_000,gate:null,attachments:[],version:1};}
  #catalogEntry(m:ModelRow):ModelCatalogEntry{return{id:`${m.provider_key}:${m.model_key}`,provider:m.provider_key,protocol:m.provider_key==='anthropic'?'anthropic_messages':m.provider_key==='google'?'google_generate_content':m.provider_key==='openai'?'openai_responses':'openai_chat_completions',upstreamModel:m.model_key,displayName:m.display_name,contextWindowTokens:m.context_window,maxOutputTokens:m.max_output_tokens,modalities:{textInput:true,textOutput:true,imageInput:false,pdfInput:false,audioInput:false,audioOutput:false},supportsTools:false,supportsReasoning:false,supportsReasoningStream:false,inputUsdPerMillion:m.input_microusd_per_million/1_000_000,outputUsdPerMillion:m.output_microusd_per_million/1_000_000,cachedInputUsdPerMillion:null,verification:'verify',verifiedAt:null,notes:'Tenant catalog'};}
  #providerChunk(e:ProviderEvent):ProviderChunk|null{if(e.type==='text_delta')return{type:'text',text:e.delta};if(e.type==='reasoning_delta')return{type:'reasoning',text:e.delta};if(e.type==='usage')return{type:'usage',inputTokens:e.usage.inputTokens,outputTokens:e.usage.outputTokens,costUsd:0};return null;}
  #gateContext(tenant:TenantContext,state:RunState,pass:'preflight'|'postflight',signal:AbortSignal,parts:GateContext['parts'],policySnapshot:ResolvedPolicySnapshot,direction:'outbound'|'inbound'|'file'):GateContext{
    const groups=this.#groups(tenant);
    const confirmed=pass==='preflight'&&direction!=='inbound'?state.confirmedWarnings[direction]:null;
    const confirmedWarningToken=confirmed?.policyFingerprint===policySnapshot.fingerprint
      ? confirmed.token
      : null;
    return {evaluationId:randomUUID(),requestId:tenant.requestId,pass,
      subject:{tenantId:tenant.principal.tenantId,userId:tenant.principal.userId,groupIds:groups,roles:tenant.principal.roles},
      conversationId:state.run.conversationId,messageId:pass==='preflight'?state.run.userMessageId:state.assistant.id,
      projectId:state.projectId,providerId:state.model.provider_key,modelId:state.model.id,locale:'en',nowMs:this.#now(),parts,
      policySnapshot,abortSignal:signal,confirmedWarningToken,metadata:{runId:state.run.id,direction}};
  }
  #policy(tenant:TenantContext,groups:readonly string[],modelId:string,pass:'preflight'|'postflight',direction:'outbound'|'inbound'|'file'):ResolvedPolicySnapshot{const tenantId=tenant.principal.tenantId,rows=tenant.db.all(this.#q.policies,tenant.principal.userId,JSON.stringify(groups),modelId,direction);const rules=rows.map((x,i)=>({id:x.id,revision:x.revision,name:x.name,detectorKind:x.detector_kind,action:x.action,passMask:x.pass_mask,priority:x.priority,scopeType:x.scope_type,scopeId:x.scope_id,config:JSON.parse(x.config_json) as Record<string,unknown>,failureMode:x.failure_mode,sourceOrder:i}));return resolvePolicy({tenantId,modelId,subject:{tenantId,userId:tenant.principal.userId,groupIds:groups,roles:tenant.principal.roles},pass,policyVersion:1,rules,nowMs:this.#now()});}
  #preflightPolicies(tenant:TenantContext,state:RunState):{outbound:ResolvedPolicySnapshot;file:ResolvedPolicySnapshot;fingerprint:string}{
    // Follow-up: auto/multi-model routing may change the dispatched model after this outbound snapshot.
    const groups=this.#groups(tenant),outbound=this.#policy(tenant,groups,state.model.id,'preflight','outbound'),file=this.#policy(tenant,groups,state.model.id,'preflight','file');
    const fingerprint=createHash('sha256').update(`${outbound.fingerprint}\n${file.fingerprint}`).digest('hex');
    return {outbound:{...outbound,fingerprint},file:{...file,fingerprint},fingerprint};
  }
  async #gatePreflight(tenant:TenantContext,state:RunState,text:string,signal:AbortSignal):Promise<ChatGateResult>{
    if(text!==state.outboundText)throw new Error('Run content changed after it was prepared');
    const policies=this.#preflightPolicies(tenant,state),evaluations:EvaluatedPreflight[]=[];
    for(const direction of ['file','outbound'] as const)if(state.confirmedWarnings[direction]?.policyFingerprint!==policies.fingerprint)delete state.confirmedWarnings[direction];
    let fileVerdict:GateVerdict|null=null,outboundVerdict:GateVerdict|null=null;
    if(state.attachments.length){
      const parts=state.attachments.map((file,index)=>({id:`file:${file.id}`,source:'file_extraction' as const,text:file.extracted_text!,mimeType:file.mime_type,fileId:file.id,provenance:{attachmentIndex:index,sha256:file.sha256}}));
      fileVerdict=await this.#gate.evaluate(this.#gateContext(tenant,state,'preflight',signal,parts,policies.file,'file'));
      evaluations.push({direction:'file',verdict:fileVerdict,evaluatedText:parts.map(part=>part.text).join('\n\u0000\n')});
    }
    if(!fileVerdict||fileVerdict.disposition==='allow_provider_call'){
      const last=state.messages.length-1,parts:GateContext['parts'][number][]=state.messages.map((message,index)=>({id:`message:${index}`,source:index===last?'user_prompt' as const:'conversation_history' as const,text:message.content.filter(part=>part.type==='text').map(part=>part.text).join(''),mimeType:'text/plain',fileId:null,provenance:{messageIndex:index,role:message.role}}));
      const persona=composePersona(state.role,state.tone);if(persona)parts.push({id:'system:persona',source:'system_persona',text:persona,mimeType:'text/plain',fileId:null,provenance:{role:state.role??'default',tone:state.tone??'default'}});
      if(state.assistantId){const assistant=tenant.db.get(this.#q.getAssistantForRun,state.assistantId);if(assistant){state.assistantPrompt=assistant.system_prompt;parts.push({id:'system:assistant',source:'system_persona',text:assistant.system_prompt,mimeType:'text/plain',fileId:null,provenance:{assistantId:state.assistantId}});}}
      outboundVerdict=await this.#gate.evaluate(this.#gateContext(tenant,state,'preflight',signal,parts,policies.outbound,'outbound'));
      evaluations.push({direction:'outbound',verdict:outboundVerdict,evaluatedText:text});
    }
    const effectiveEvaluations=evaluations.map(item=>({...item,verdict:enforceMultiModelApprovalBoundary(state.routingMode,item.verdict)}));
    const verdict=this.#combinePreflight(effectiveEvaluations);
    state.preflight=verdict;
    state.preflightDirection=effectiveEvaluations.find(item=>item.verdict.evaluationId===verdict.evaluationId)?.direction??'outbound';
    state.run={...state.run,status:verdict.disposition==='await_user_confirmation'?'awaiting_confirmation':verdict.disposition==='pending_approval'?'awaiting_approval':'gating'};
    state.providerMessages=verdict.disposition==='allow_provider_call'&&outboundVerdict
      ? this.#providerContext(state,outboundVerdict,fileVerdict)
      : null;
    const promptId=`message:${state.messages.length-1}`;
    const authorized=outboundVerdict?.providerParts?.find(part=>part.id===promptId)?.text??this.#gateMessage(verdict.action);
    const protectedItemCount=protectedPromptItemCount(effectiveEvaluations.map(item=>item.verdict),promptId,new Set(state.attachments.map(file=>`file:${file.id}`)));
    const durableApprovalId=this.#persistPreflight(tenant,state,verdict,authorized,effectiveEvaluations,protectedItemCount);
    return {decisionId:verdict.evaluationId,action:verdict.action,direction:state.preflightDirection,protectedItemCount,effectiveText:state.providerMessages?authorized:'',message:this.#gateMessage(verdict.action),
      ...(verdict.warningToken?{confirmationToken:verdict.warningToken}:{}),...(durableApprovalId?{approvalId:durableApprovalId}:{})};
  }
  #combinePreflight(evaluations:readonly EvaluatedPreflight[]):GateVerdict{
    if(!evaluations.length)throw new Error('Pre-flight gate made no decision');
    const selected=evaluations.reduce((strongest,item)=>{
      const rank=GATE_ACTION_RANK[item.verdict.action],strongestRank=GATE_ACTION_RANK[strongest.verdict.action];
      if(rank!==strongestRank)return rank>strongestRank?item:strongest;
      return strongest.verdict.disposition==='allow_provider_call'&&item.verdict.disposition!=='allow_provider_call'?item:strongest;
    });
    const allowed=evaluations.every(item=>item.verdict.disposition==='allow_provider_call');
    const timings=evaluations.reduce((sum,item)=>({resolveUs:sum.resolveUs+item.verdict.timings.resolveUs,normalizeUs:sum.normalizeUs+item.verdict.timings.normalizeUs,deterministicUs:sum.deterministicUs+item.verdict.timings.deterministicUs,semanticUs:sum.semanticUs+item.verdict.timings.semanticUs,vaultUs:sum.vaultUs+item.verdict.timings.vaultUs,totalUs:sum.totalUs+item.verdict.timings.totalUs}),{resolveUs:0,normalizeUs:0,deterministicUs:0,semanticUs:0,vaultUs:0,totalUs:0});
    return {...selected.verdict,disposition:allowed?'allow_provider_call':selected.verdict.disposition,
      matches:evaluations.flatMap(item=>item.verdict.matches),providerParts:allowed?evaluations.flatMap(item=>item.verdict.providerParts??[]):null,
      redactions:evaluations.flatMap(item=>item.verdict.redactions),masks:evaluations.flatMap(item=>item.verdict.masks),degraded:evaluations.some(item=>item.verdict.degraded),
      failureCodes:evaluations.flatMap(item=>item.verdict.failureCodes),timings};
  }
  #providerContext(state:RunState,outbound:GateVerdict,file:GateVerdict|null):readonly ChatMessage[]{
    assertProviderTransportAuthorized(outbound);if(file)assertProviderTransportAuthorized(file);
    const authorizedMessages=new Map(outbound.providerParts.map(part=>[part.id,part.text]));
    const authorizedFiles=new Map((file?.providerParts??[]).map(part=>[part.fileId,part.text]));
    if(state.messages.some((_message,index)=>!authorizedMessages.has(`message:${index}`))
      ||state.attachments.some(item=>!authorizedFiles.has(item.id)))
      throw new Error('Gate verdict omitted required provider context');
    const messages=state.messages.map((message,index)=>({...message,content:[{type:'text' as const,text:authorizedMessages.get(`message:${index}`)??''}]}));
    let assembled;
    try{assembled=assembleAuthorizedProviderContext({messages,attachments:state.attachments.map(item=>({id:item.id,text:authorizedFiles.get(item.id)??''})),modelContextWindow:state.model.context_window,configuredMaxOutput:state.model.max_output_tokens});}
    catch{throw Object.assign(new Error('The message and attachments exceed the selected model context window'),{code:'VALIDATION_FAILED',reason:'chat_context_too_large'});}
    state.attachmentContextTruncated=assembled.attachmentContextTruncated;
    const systemText=[authorizedMessages.get('system:assistant'),authorizedMessages.get('system:persona')].filter((part):part is string=>part!==undefined).join('\n\n');
    return systemText?[{role:'system',content:[{type:'text',text:systemText}]},...assembled.messages]:assembled.messages;
  }
  #persistPreflight(tenant:TenantContext,state:RunState,v:GateVerdict,authorized:string,evaluations:readonly EvaluatedPreflight[],protectedItemCount:number):string|null {
    if(state.submitted)return this.#audit.transact(tx=>{
      const projected=evaluations.reduce<string|null>((approval,item)=>this.#persistDecision(tenant,state,item.verdict,item.evaluatedText,item.direction,tx.append)??approval,null);
      if(tenant.db.run(this.#q.updateProtectedItemCount,protectedItemCount,state.run.userMessageId).changes!==1)throw new Error('Submitted message protected-item count could not be finalized');
      // The first warned pass stores only a safe stand-in. Once every direction has been authorized,
      // replace it with the exact outbound provider part in the same transaction as the decisions.
      // A file confirmation alone must never make the still-unconfirmed prompt durable.
      if(v.disposition==='allow_provider_call'){
        const kind=v.redactions.length>0||(v.action!=='mask'&&authorized!==state.outboundText)?'redacted_text':'text';
        const changed=tenant.db.run(this.#q.updateSubmittedPart,authorized,kind,state.run.userMessageId);
        if(changed.changes!==1)throw new Error('Submitted message text could not be finalized');
      }
      this.#syncWaitingRun(tenant,state);
      return projected;
    });
    const now=this.#now(),title=authorized.slice(0,80)||'New conversation';
    const approvalId=this.#audit.transact(tx=>{
      if(state.newConversation){
        this.#q.insertConversation.run(state.run.conversationId,tenant.principal.tenantId,tenant.principal.userId,title,state.tone??'default',state.role??'default',state.assistantId??null,now,now);
        if(state.projectId)tenant.db.run(this.#q.linkProject,state.projectId,state.run.conversationId,tenant.principal.userId,now);
      }else{
        if(this.#q.updateConversationPersona.run(state.tone??'default',state.role??'default',state.assistantId??null,now,tenant.principal.tenantId,state.run.conversationId,tenant.principal.userId).changes!==1)throw new Error('Conversation persona could not be persisted');
        const currentProject=tenant.db.get(this.#q.projectLink,state.run.conversationId)?.project_id??null;
        if(currentProject!==state.projectId)throw new Error('Conversation project changed before message persistence');
      }
      if(state.projectId&&tenant.db.get(this.#q.projectLink,state.run.conversationId)?.project_id!==state.projectId)throw new Error('Conversation project changed while attaching files');
      this.#q.insertMessage.run(state.run.userMessageId,tenant.principal.tenantId,state.run.conversationId,state.parentMessageId,tenant.principal.userId,'user',v.action==='block'?'blocked':'complete',state.sequenceNo,null,null,now,state.editedFromMessageId);
      if(tenant.db.run(this.#q.updateProtectedItemCount,protectedItemCount,state.run.userMessageId).changes!==1)throw new Error('Submitted message protected-item count could not be stored');
      this.#q.insertPart.run(randomUUID(),tenant.principal.tenantId,state.run.userMessageId,authorized,now);
      const fileEvaluation=evaluations.find(item=>item.direction==='file');
      state.attachments.forEach((file,index)=>{const metadata=JSON.stringify({gateDecisionId:fileEvaluation?.verdict.evaluationId??null,gateAction:fileEvaluation?.verdict.action??'allow',contextTruncated:state.attachmentContextTruncated});const result=tenant.db.run(this.#q.insertFilePart,randomUUID(),state.run.userMessageId,index+1,file.mime_type.startsWith('image/')?'image_ref':'file_ref',file.id,file.mime_type,metadata,now,file.project_id,tenant.principal.userId);if(result.changes!==1)throw new Error('Attachment ownership or extraction state changed before persistence');tx.append({tenantId:tenant.principal.tenantId,action:'chat.file_extracted',actor:{type:'user',id:tenant.principal.userId,sessionId:tenant.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'file',id:file.id},outcome:'success',context:{requestId:tenant.requestId,traceId:null,source:'http',occurredAtMs:now},projectId:file.project_id,conversationId:state.run.conversationId,messageId:state.run.userMessageId,gateAction:fileEvaluation?.verdict.action??'allow',metadata:{access:'policy_scan',gateDecisionId:fileEvaluation?.verdict.evaluationId??null,characters:file.extracted_text?.length??0,providerReleased:v.disposition==='allow_provider_call'}});});
      this.#q.insertMessage.run(state.assistant.id,tenant.principal.tenantId,state.run.conversationId,state.run.userMessageId,null,'assistant','pending',state.sequenceNo+1,state.model.id,state.model.provider_key,now,null);
      this.#q.insertPart.run(randomUUID(),tenant.principal.tenantId,state.assistant.id,'',now);
      if(state.routeDecisionId){const linked=this.#q.attachRoutingDecision.run(state.run.conversationId,state.assistant.id,now,tenant.principal.tenantId,state.routeDecisionId);if(linked.changes!==1)throw new Error('Routing decision could not be attributed to the persisted run');}
      const projected=evaluations.reduce<string|null>((approval,item)=>this.#persistDecision(tenant,state,item.verdict,item.evaluatedText,item.direction,tx.append)??approval,null);
      this.#auditEvent(tenant,state,state.submittedAction,'success',{fileIds:state.attachments.map(file=>file.id),projectId:state.projectId},tx.append);
      this.#syncWaitingRun(tenant,state);
      return projected??v.approvalRequestId;
    });
    state.submitted=true;state.newConversation=false;
    return approvalId;
  }
  #syncWaitingRun(tenant:TenantContext,state:RunState):void {
    const waiting=state.run.status==='awaiting_confirmation'||state.run.status==='awaiting_approval';
    const response=waiting?JSON.stringify({run:state.run,assistant:state.assistant}):null;
    const changed=tenant.db.run(this.#q.waitingIdempotency,response,this.#now(),state.idempotencyId);
    if(changed.changes!==1)throw new Error('Idempotency waiting state could not be persisted');
  }
  #persistDecision(tenant:TenantContext,state:RunState,v:GateVerdict,evaluatedText:string,direction:'outbound'|'inbound'|'file',append:AuditTransaction['append']):string|null {
    const now=this.#now(),tenantId=tenant.principal.tenantId,messageId=direction==='inbound'?state.assistant.id:state.run.userMessageId;
    const ruleIds=[...new Set(v.matches.map(match=>match.ruleId))],detectorKeys=[...new Set(v.matches.map(match=>match.detectorKind))];
    // The legacy column is named content_sha256, but a bare hash of an employee prompt is an offline
    // dictionary oracle. New rows carry a tenant-keyed HMAC with the same 64-character shape.
    const contentDigest=protectedContentDigest(this.#approvalPayloadKey,tenantId,evaluatedText);
    tenant.db.run(this.#q.insertDecision,v.evaluationId,tenant.principal.userId,state.run.conversationId,messageId,
      direction,v.action,
      v.disposition==='await_user_confirmation'?'awaiting_confirmation':v.disposition==='pending_approval'?'pending_approval':'final',
      contentDigest,JSON.stringify(ruleIds),JSON.stringify(detectorKeys),v.redactions.length+v.masks.length,null,
      Math.ceil(v.timings.totalUs/1000),0,now);
    if(v.action==='allow')return null;

    const approvalId=direction!=='inbound'&&v.action==='require_approval'?v.approvalRequestId:null;
    if(direction!=='inbound'&&v.action==='require_approval'&&!approvalId)throw new Error('Approval verdict is missing its request id');
    const matched=v.matches.find(match=>match.action===v.action)??v.matches[0];
    const projectionRuleIds=v.matches.filter(match=>match.action===v.action).map(match=>match.ruleId);
    const rule=tenant.db.get(this.#q.ruleProjection,JSON.stringify(projectionRuleIds.length?projectionRuleIds:ruleIds));
    const groupId=rule?.scope_type==='group'?rule.scope_id:null;
    const detector=rule?.detector_key??matched?.detectorId??matched?.detectorKind??'gate';
    // Streaming postflight scans overlap by design. Keep one incident per message and direction,
    // retaining its strongest verdict; gate_decisions still records every evaluation.
    const existing=tenant.db.get(this.#q.existingViolation,messageId,direction);
    if(existing){
      if(v.action==='warn'&&v.disposition==='allow_provider_call')tenant.db.run(this.#q.resolveConfirmedWarning,now,existing.id);
      if(GATE_ACTION_RANK[v.action]<=GATE_ACTION_RANK[existing.gate_action])return existing.approval_id;
    }
    const violationId=existing?.id??randomUUID();
    // A match-local "safe" excerpt can still contain an adjacent match's raw secret. Queue rows are
    // long-lived and searchable, so persist a content-free action label rather than nearby prompt text.
    const excerpt=`[${v.action.toUpperCase()}]`;
    const severity=rule?.severity??matched?.confidence??(v.action==='block'||v.action==='require_approval'?'high':'medium');
    const expiresAt=approvalId===null?null:now+24*60*60_000,dueAt=v.action==='warn'?now+this.#waitingRunTtlMs:expiresAt;
    const responseWithheld=direction==='inbound'&&(v.action==='warn'||v.action==='require_approval');
    const actionMetadata=v.action==='redact'?{placeholderCount:v.redactions.length}
      :v.action==='mask'?{maskCount:v.masks.length,replacements:v.masks.map(mask=>mask.replacement)}
      :v.action==='warn'?{warningId:v.evaluationId,expiresAtMs:dueAt}
      :v.action==='block'?{reasonCode:detector}
      :v.action==='require_approval'?{approvalId,expiresAtMs:expiresAt}
      :{};
    const receipt=append({tenantId,action:responseWithheld?'gate.response_withheld':GATE_AUDIT_ACTIONS[v.action],
      actor:{type:'user',id:tenant.principal.userId,sessionId:tenant.principal.sessionId,ip:null,userAgent:null,authMethod:null},
      target:{type:'message',id:messageId},outcome:v.action==='block'||responseWithheld?'denied':v.action==='warn'||v.action==='require_approval'?'pending':'success',
      context:{requestId:tenant.requestId,traceId:null,source:'http',occurredAtMs:now},subjectUserId:tenant.principal.userId,
      groupId,projectId:state.projectId,conversationId:state.run.conversationId,messageId,modelId:state.model.id,providerId:state.model.provider_key,
      gateAction:v.action,detector,metadata:{evaluationId:v.evaluationId,direction,violationId,ruleIds,matchCount:v.matches.length,ruleCount:ruleIds.length,
        policySnapshotId:v.policySnapshotId,degraded:v.degraded,...actionMetadata,
        ...(responseWithheld?{providerResponseDigest:contentDigest}:{})}});
    if(existing)tenant.db.run(this.#q.strengthenViolation,receipt.id,approvalId,groupId,detector,v.action,severity,
      JSON.stringify(ruleIds),excerpt,contentDigest,dueAt,now,violationId);
    else tenant.db.run(this.#q.insertViolation,violationId,receipt.id,approvalId,tenant.principal.userId,groupId,
      state.run.conversationId,messageId,direction,detector,v.action,severity,'open',
      JSON.stringify(ruleIds),excerpt,contentDigest,dueAt,now,now);
    if(approvalId){
      const policyRevision=Math.max(1,...v.matches.map(match=>match.ruleRevision).filter(Number.isSafeInteger));
      const sealed=sealApprovalEnvelope(this.#approvalPayloadKey,{schemaVersion:1,tenantId,approvalId,violationId,
        evaluationId:v.evaluationId,runId:state.run.id,requestingUserId:tenant.principal.userId,
        conversationId:state.run.conversationId,sourceMessageId:state.run.userMessageId,assistantMessageId:state.assistant.id,
        pass:'preflight',tone:state.tone??'default',role:state.role??'default',...(state.assistantId?{assistantId:state.assistantId}:{}),...(state.assistantPrompt!==undefined?{assistantPrompt:state.assistantPrompt}:{}),messages:state.messages,attachments:state.attachments.map(file=>({fileId:file.id,projectId:file.project_id,
          name:file.original_name,mimeType:file.mime_type,byteSize:file.byte_size,sha256:file.sha256,
          extractedText:file.extracted_text!,createdAtMs:file.created_at})),confirmedWarnings:Object.entries(state.confirmedWarnings).flatMap(([direction,warning])=>warning?[{direction:direction as 'outbound'|'file',policyFingerprint:warning.policyFingerprint,ruleIds:warning.ruleIds}]:[]),model:{catalogId:state.model.id,provider:state.model.provider_key,
          modelKey:state.model.model_key,maxOutputTokens:state.model.max_output_tokens,estimatedOutputTokens:state.routingEstimatedOutputTokens,reasoningEffort:state.reasoningEffort},
        policy:{snapshotId:v.policySnapshotId,fingerprint:v.policyFingerprint,revision:policyRevision},createdAtMs:now});
      tenant.db.run(this.#q.insertApproval,approvalId,violationId,v.evaluationId,tenant.principal.userId,'pending',sealed.ciphertext,
        sealed.nonce,sealed.keyVersion,sealed.digest,sealed.wrappedDek,sealed.wrapNonce,sealed.kekVersion,policyRevision,expiresAt,now,state.routeDecisionId);
    }
    return approvalId;
  }
  #gateMessage(action:GateAction):string{return action==='allow'?'Allowed':action==='flag'?'Allowed and flagged':action==='redact'?'Sensitive content was redacted':action==='mask'?'Sensitive content was masked':action==='warn'?'Confirmation is required':action==='require_approval'?'Approval is required':'Blocked by policy';}
  #auditEvent(tenant:TenantContext,state:RunState,action:'chat.message_submitted'|'chat.message_completed'|'chat.message_stopped'|'chat.message_regenerated'|'chat.message_edited_resubmitted'|'chat.provider_called',outcome:'success'|'failure'|'denied',metadata:Readonly<Record<string,unknown>>,append=this.#audit.append.bind(this.#audit)):void{append({tenantId:tenant.principal.tenantId,action,actor:{type:'user',id:tenant.principal.userId,sessionId:tenant.principal.sessionId,ip:null,userAgent:null,authMethod:'password'},target:{type:'message',id:state.assistant.id},outcome,context:{requestId:tenant.requestId,traceId:null,source:'http'},conversationId:state.run.conversationId,messageId:state.assistant.id,modelId:state.model.id,providerId:state.model.provider_key,metadata:metadata as Record<string,never>});}
}

// Returns WarnedRunPipeline, not ChatPipelineServices: the confirmation endpoint needs
// authorizeWarnedRun, and widening the type here would hide it from the only caller that can use it.
export function createGovernedChatApplication(deps:GovernedChatDependencies):WarnedRunPipeline{return new GovernedChatApplication(deps);}
