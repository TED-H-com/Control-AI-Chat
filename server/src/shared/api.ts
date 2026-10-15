import type {AuditActionName,AuditCategoryName} from './audit-actions.js';

export type ISODateTime = string;
export type UUID = string;
declare const tenantBrand: unique symbol;
export type TenantId = string & { readonly [tenantBrand]: 'TenantId' };
export const ROLES = ['owner','admin','compliance','member'] as const;
export type Role = (typeof ROLES)[number];
export type Permission =
  | 'chat:use' | 'project:read' | 'project:write' | 'skill:read' | 'skill:write'
  | 'file:read' | 'file:write' | 'profile:write' | 'session:manage'
  | 'admin:users' | 'admin:groups' | 'admin:settings'
  | 'policy:read' | 'policy:write' | 'approval:read' | 'approval:decide'
  | 'audit:read' | 'audit:export' | 'budget:read' | 'budget:write'
  | 'model:read' | 'model:write' | 'assistant:read' | 'assistant:write'
  | 'legal_hold:manage';
export interface Page<T> { data: T[]; page: PageMeta; }
export interface PageMeta { nextCursor: string | null; hasMore: boolean; limit: number; }
export interface FieldViolation { path: string; rule: 'required'|'type'|'format'|'min'|'max'|'enum'|'conflict'; message: string; received?: string|number|boolean|null; }
export type ErrorCode =
  | 'INVALID_REQUEST'|'VALIDATION_FAILED'|'INVALID_CREDENTIALS'|'PASSWORD_POLICY_FAILED'|'CREDENTIAL_LINK_INVALID'
  | 'UNAUTHENTICATED'|'SESSION_EXPIRED'|'CSRF_FAILED'|'CSRF_REJECTED'
  | 'FORBIDDEN'|'RESOURCE_NOT_FOUND'|'CONFLICT'|'IDEMPOTENCY_CONFLICT'
  | 'PRECONDITION_REQUIRED'|'PRECONDITION_FAILED'|'RATE_LIMITED'|'STREAM_LIMIT_REACHED'|'CONCURRENT_STREAM_LIMIT'
  | 'BUDGET_SOFT_LIMIT'|'BUDGET_HARD_LIMIT'|'MODEL_NOT_ALLOWED'|'PROVIDER_UNAVAILABLE'
  | 'GATE_BLOCKED'|'GATE_CONFIRMATION_REQUIRED'|'APPROVAL_REQUIRED'|'APPROVAL_EXPIRED'
  | 'FILE_TOO_LARGE'|'PAYLOAD_TOO_LARGE'|'FILE_TYPE_NOT_ALLOWED'|'FILE_SCAN_FAILED'|'FILE_NOT_READY'
  | 'MFA_REQUIRED'|'MFA_INVALID'|'EMAIL_NOT_VERIFIED'|'EXPORT_TOO_LARGE'
  | 'DRAFT_FAILED'|'NOT_IMPLEMENTED'|'INTERNAL_ERROR'|'SERVICE_UNAVAILABLE';
/** Machine-readable causes which add precision when an ErrorCode is intentionally broad. */
export const ERROR_REASONS = [
  'email_taken','account_above_caller','self_status_change','self_role_change','self_removal','self_password_link',
  'password_link_unavailable','password_link_refused','missing_permission','ownership_transfer_required',
  'system_group_immutable','builtin_detector_immutable','legal_hold_already_released','assistant_name_taken',
  'icon_required','icon_too_large','icon_svg_refused','icon_type_refused','icon_dimensions_invalid',
  'custom_terms_action_invalid','custom_terms_required','custom_terms_blank','custom_term_length','custom_terms_too_many',
  'soft_limit_above_hard','date_order_invalid','support_url_invalid','support_url_https_required','support_email_invalid',
  'model_unavailable','hold_target_invalid','hold_dates_required','hold_reason_invalid','resource_changed',
  'membership_externally_managed','group_model_state_unchanged',
  'chat_attachments_invalid','chat_too_many_attachments','chat_attachment_text_too_large','chat_attachment_project_mismatch',
  'chat_project_unavailable','chat_message_empty','chat_option_invalid','chat_single_target_required',
  'chat_multi_model_target_refused','chat_idempotency_reused','chat_attachment_unavailable','chat_context_too_large',
  'chat_model_not_allowed','chat_provider_not_allowed','chat_no_models_available','chat_multi_model_unavailable','chat_policy_changed',
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];
export interface ApiError { error: { code: ErrorCode; message: string; requestId: UUID; details?: Readonly<Record<string,unknown>> & {reason?:ErrorReason}; validation?: readonly FieldViolation[]; retryable: boolean } }

export type Provider = 'openai'|'anthropic'|'google'|'xai'|'openrouter'|'venice'|'nvidia';
export type Density = 'comfortable'|'compact';
export type ColorMode = 'light'|'dark'|'system';
/** Source of truth for the supported locale type and API validators. */
export const LOCALES = ['en','zh-TW','ja'] as const;
export type Locale = (typeof LOCALES)[number];
export const DATA_CLASSES = ['public','internal','confidential','restricted'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const GATE_ACTIONS = ['allow','flag','redact','mask','warn','block','require_approval'] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];
export const GATE_DIRECTIONS = ['outbound','inbound','file'] as const;
export type GateDirection = (typeof GATE_DIRECTIONS)[number];
export const DETECTORS = ['keyword','phrase','regex','pii','secret','source_code','classification','prompt_injection','semantic','institution','file_policy'] as const;
export type Detector = (typeof DETECTORS)[number];
export type FileStatus = 'uploaded'|'extracting'|'scanning'|'ready'|'rejected'|'failed';
export type ChatReasoningEffort = 'low'|'medium'|'high';
export type ToneKey = 'default'|'concise'|'detailed'|'formal'|'friendly';
export type RoleKey = 'default'|'coach'|'creative'|'critic'|'debate'|'support';
export type ChatMode = 'auto'|'single'|'multi_model';
export const PINNABLE_PROVIDERS = ['openai','anthropic','google','xai'] as const;
export type PinnableProvider = (typeof PINNABLE_PROVIDERS)[number];
export type MessageRole = 'user'|'assistant'|'system'|'tool';
export type ConversationStatus = 'active'|'archived'|'deleted';
/** Raw durable approval state exposed by the governance API. A reviewer denial is `rejected`;
 * `denied` is reserved for the linked gate-decision state and is never an approval status. */
export const APPROVAL_STATUSES = ['pending','claimed','approved','releasing','released','rejected','expired','cancelled','release_failed','release_indeterminate'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_RELEASE_STATUSES = ['pending_review','queued','releasing','finalizing','released','failed','indeterminate','terminal'] as const;
export type ApprovalReleaseStatus = (typeof APPROVAL_RELEASE_STATUSES)[number];
export const BUDGET_PERIODS = ['daily','weekly','monthly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export const BUDGET_SCOPES = ['tenant','group','user'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];
export const BUDGET_METRICS = ['usd','tokens'] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];
export const LEGAL_HOLD_SCOPES = ['tenant','user','conversation','project','date_range'] as const;
export type LegalHoldScope = (typeof LEGAL_HOLD_SCOPES)[number];
export const LEGAL_HOLD_STATUSES = ['active','released','all'] as const;
export const USER_STATUSES = ['invited','active','suspended','deprovisioned'] as const;
export const AUDIT_OUTCOMES = ['success','failure','denied','pending','cancelled'] as const;
export const VIOLATION_TRIAGE_STATUSES = ['open','triaged','in_review','approved','resolved','dismissed'] as const;
export const NUDGE_CATEGORIES = ['cost','policy','governance'] as const;
export type NudgeCategory = (typeof NUDGE_CATEGORIES)[number];
export const NUDGE_PRIORITIES = ['high','medium'] as const;
export type NudgePriority = (typeof NUDGE_PRIORITIES)[number];
export const NUDGE_RULES = ['budgetUtilization','approvalsPending','warnProceed','blockedVolume'] as const;
export type NudgeRule = (typeof NUDGE_RULES)[number];

export interface UserSummary { id: UUID; email: string; displayName: string; avatarUrl: string|null; }
export interface GroupSummary { id: UUID; name: string; }
export type CredentialLinkPurpose = 'setup'|'reset';
export type CredentialLinkEmailFailure = 'smtp_unconfigured'|'delivery_failed'|null;
export interface DeliveredCredentialLink { purpose:CredentialLinkPurpose;url:string;expiresAt:ISODateTime;emailSent:boolean;emailFailure:CredentialLinkEmailFailure }
export interface ReissueRequiredCredentialLink { purpose:CredentialLinkPurpose;reissueRequired:true }
export type CredentialLinkResponse = DeliveredCredentialLink|ReissueRequiredCredentialLink;
export interface AdminUserActions {changeStatus:boolean;changeRole:boolean;deprovision:boolean;signOut:boolean;credentialLink:CredentialLinkPurpose|null}
export interface Me {
  user: UserSummary; tenant: { id: UUID; name: string; slug: string };
  membership: { id: UUID; roles: Role[]; groups: GroupSummary[]; permissions: Permission[] };
  preferences: UserPreferences; mfa: { enabled: boolean }; sessionId: UUID;
}
export interface UserPreferences { density: Density; colorMode: ColorMode; locale: Locale; }
export interface SessionInfo { id: UUID; createdAt: ISODateTime; lastSeenAt: ISODateTime;
  ipApprox: string; userAgent: string; current: boolean; expiresAt: ISODateTime; }
export interface AuthTokensNotice { user: Me; csrfToken: string; }

export interface Model {
  id: UUID; provider: Provider; providerModelId: string; displayName: string;
  transport:'api'; systemPromptEligible:true;
  capabilities: ('text'|'vision'|'reasoning'|'tools')[]; enabled: boolean;
  inputUsdPerMillion: number; outputUsdPerMillion: number; contextTokens: number;
  maxOutputTokens: number; version: number;
}
export interface AvailableModel extends Model { isDefault: boolean; recommendedForProvider:boolean; groupRestriction: string|null; }
export interface AvailableAssistant { id:UUID; name:string; description:string|null; modelId:UUID; model:string; }
export interface DraftAssistantFromUrlInput { url:string; modelCatalogId:UUID }
export interface AssistantDraft { name:string; description:string; systemPrompt:string }

export interface Conversation {
  id: UUID; projectId: UUID|null; title: string; status: ConversationStatus;
  tone?: ToneKey; role?: RoleKey; assistantId?:UUID|null;
  pinned: boolean; createdAt: ISODateTime; updatedAt: ISODateTime;
  deletedAt: ISODateTime|null; messageCount: number; version: number;
}
export interface Message {
  id: UUID; conversationId: UUID; parentMessageId: UUID|null; role: MessageRole;
  content: string; modelId: UUID|null; provider: Provider|null; createdAt: ISODateTime;
  inputTokens: number|null; outputTokens: number|null; costUsd: number|null;
  gate: GateSummary|null; attachments: FileRef[]; version: number;
}
export interface ConversationDetail { conversation: Conversation; messages: Message[]; }
export interface GateSummary { decisionId: UUID; action: GateAction; direction: GateDirection;
  detectorCount: number; protectedItemCount: number|null; approvalId: UUID|null; userNotice: string|null; }
export interface ChatInput {
  conversationId?: UUID; projectId?: UUID; parentMessageId?: UUID;
  content: string; modelId?: UUID; mode?: ChatMode; provider?: PinnableProvider; fileIds?: UUID[];
  skill?: { skillId: UUID; version: number; arguments: Record<string,string> };
  gateConfirmationToken?: string; reasoningEffort?:ChatReasoningEffort; tone?:ToneKey; role?:RoleKey; assistantId?:UUID|null; clientRequestId: UUID;
}
export interface RegenerateInput { messageId: UUID; modelId?: UUID; mode?:ChatMode; provider?:PinnableProvider; reasoningEffort?:ChatReasoningEffort; tone?:ToneKey; role?:RoleKey; assistantId?:UUID|null; clientRequestId: UUID; }
export interface EditResendInput { messageId: UUID; content: string; modelId?: UUID; mode?:ChatMode; provider?:PinnableProvider;
  fileIds?: UUID[]; reasoningEffort?:ChatReasoningEffort; tone?:ToneKey; role?:RoleKey; assistantId?:UUID|null; clientRequestId: UUID; }
export interface ChatRun { id: UUID; conversationId: UUID; userMessageId: UUID;
  assistantMessageId: UUID|null; status: 'queued'|'gating'|'awaiting_confirmation'
  |'awaiting_approval'|'streaming'|'completed'|'failed'|'cancelled'; streamUrl: string;
  createdAt: ISODateTime; }

export interface Project { id: UUID; name: string; instructions: string; fileCount: number;
  conversationCount: number; createdAt: ISODateTime; updatedAt: ISODateTime; version: number; }
export interface SkillParameter { name: string; description: string; required: boolean;
  defaultValue?: string; maxLength?: number; }
export interface Skill { id: UUID; ownerUserId: UUID|null; scope: 'personal'|'organization';
  name: string; description: string; template: string; parameters: SkillParameter[];
  published: boolean; version: number; createdAt: ISODateTime; updatedAt: ISODateTime; }
export interface FileRef { id: UUID; name: string; mimeType: string; sizeBytes: number;
  status: FileStatus; sha256: string; createdAt: ISODateTime; }
export interface FileDetail extends FileRef { projectId: UUID|null; extractedChars: number|null;
  gate: GateSummary|null; failureCode: ErrorCode|null; version: number; }

export interface GateRule {
  id: UUID; name: string; enabled: boolean; priority: number; scope: 'organization'|'group'|'user'|'model';
  scopeId: UUID|null; directions: GateDirection[]; detector: Detector; action: GateAction;
  config: Record<string,unknown>; dataClass: DataClass|null; version: number;
  createdAt: ISODateTime; updatedAt: ISODateTime;
}
// `GateDecisionDetail` is defined in app/gate/decisions.ts, beside the query that fills it. The
// version that lived here promised per-rule excerpts and match counts that gate_decisions never stored.
export interface Approval { id: UUID; status: ApprovalStatus; releaseStatus:ApprovalReleaseStatus; runId: UUID;
  requestedBy: UserSummary; reason: string; redactedPreview: string;
  decidedBy: UserSummary|null; decisionNote: string|null; expiresAt: ISODateTime;
  createdAt: ISODateTime; version: number; }

export interface Budget {
  id: UUID; scope: BudgetScope; scopeId: UUID; period: BudgetPeriod; metric: BudgetMetric;
  softLimit: number|null; hardLimit: number; enabled: boolean; version: number;
}
export interface BudgetUsage { budget: Budget; periodStart: ISODateTime; periodEnd: ISODateTime;
  used: number; reserved: number; remaining: number; softExceeded: boolean; hardExceeded: boolean; }
export interface UsageSummary { inputTokens: number; outputTokens: number; totalTokens: number;
  costUsd: number; modelId: UUID; provider: Provider; budgetWarnings: BudgetUsage[]; }

export interface AuditEvent {
  id: UUID; sequence: number; occurredAt: ISODateTime; actor: UserSummary|null;
  action: AuditActionName; category: AuditCategoryName;
  targetType: string|null; targetId: UUID|null; outcome: 'success'|'failure'|'denied';
  metadata: Record<string,unknown>; prevHash: string; hash: string;
}
export interface AuditExport { id: UUID; status: 'queued'|'running'|'ready'|'failed'|'expired';
  format: 'csv'|'json'; downloadUrl: string|null; expiresAt: ISODateTime|null; }
export interface Dashboard { range: {from: ISODateTime;to: ISODateTime};
  totals: {requests:number;tokens:number;costUsd:number;violations:number};
  series: {bucket:ISODateTime;requests:number;tokens:number;costUsd:number;violations:number}[];
  byModel: {modelId:UUID;requests:number;costUsd:number}[];
  byGroup: {groupId:UUID;requests:number;costUsd:number}[]; }

export interface AdminUser extends UserSummary { active: boolean; roles: Role[]; groups: GroupSummary[];actions:AdminUserActions;
  createdAt: ISODateTime; lastLoginAt: ISODateTime|null; version: number; }
export interface AdminModel { id:UUID; displayName:string; provider:Provider; providerModelId:string;
  transport:'api'; systemPromptEligible:true; enabled:boolean; isTenantDefault:boolean;
  capabilities:Model['capabilities']; contextWindowTokens:number; maxOutputTokens:number;
  inputPriceMicroUsdPerMillion:number; outputPriceMicroUsdPerMillion:number;
  cachedInputPriceMicroUsdPerMillion:number|null; speedClass:string; qualityTier:number;
  multiModelEligible:boolean; vendorJurisdiction:string; processingRegion:string;
  preferenceWeight:number; enabledGroupCount:number; createdAt:ISODateTime; updatedAt:ISODateTime; }
export interface Group { id: UUID; name: string; description: string; memberCount: number;
  providerAllowlist: Provider[]; version: number; }
export interface Job { id:UUID;type:string;status:'queued'|'running'|'succeeded'|'failed';
  progress:number;error:ApiError['error']|null;createdAt:ISODateTime;updatedAt:ISODateTime; }

export type DetectorKind = Detector;
export type ToolKind = 'retrieval';
export type StreamEvent =
  | { event:'run.created'; data:{run:ChatRun} }
  | { event:'run.status'; data:{runId:UUID;status:ChatRun['status']} }
  | { event:'gate.notice'; data:{runId:UUID;direction:GateDirection;action:GateAction;decisionId:UUID;protectedItemCount:number|null;message:string;confirmationToken?:string;approvalId?:UUID} }
  | { event:'message.created'; data:{runId:UUID;message:Message} }
  | { event:'assistant.delta'; data:{runId:UUID;messageId:UUID;index:number;text:string} }
  | { event:'reasoning.delta'; data:{runId:UUID;messageId:UUID;index:number;text:string;visibility:'summary'|'user'} }
  | { event:'tool.started'; data:{runId:UUID;toolCallId:UUID;tool:ToolKind;displayName:string;inputSummary:string} }
  | { event:'tool.progress'; data:{runId:UUID;toolCallId:UUID;message:string;completed:number;total:number|null} }
  | { event:'tool.completed'; data:{runId:UUID;toolCallId:UUID;outputSummary:string;citationFileIds:UUID[];durationMs:number} }
  | { event:'tool.failed'; data:{runId:UUID;toolCallId:UUID;code:ErrorCode;message:string} }
  | { event:'usage.summary'; data:{runId:UUID;usage:UsageSummary} }
  | { event:'run.completed'; data:{runId:UUID;conversationId:UUID;message:Message;usage:UsageSummary} }
  | { event:'run.failed'; data:{runId:UUID;error:ApiError['error'];partialMessageId:UUID|null} }
  | { event:'run.cancelled'; data:{runId:UUID;partialMessageId:UUID|null;usage:UsageSummary|null} };
export interface LoginInput { email:string; password:string; totpCode?:string }
export interface CreateConversationInput { title?:string; projectId?:UUID }
export interface UpdateConversationInput { title?:string; pinned?:boolean; status?:ConversationStatus; projectId?:UUID|null; tone?:ToneKey; role?:RoleKey; assistantId?:UUID|null }
export interface CreateProjectInput { name:string; instructions?:string }
export interface UpdateProjectInput { name?:string; instructions?:string }
export interface CreateSkillInput { name:string; description:string; template:string; parameters:SkillParameter[]; scope:'personal'|'organization' }
export interface GateRuleInput { name:string; enabled?:boolean; priority:number; scope:GateRule['scope']; scopeId?:UUID|null; directions:GateDirection[]; detector:Detector; action:GateAction; config:Record<string,unknown>; dataClass?:DataClass|null }
export interface ApprovalDecisionInput { decision:'approve'|'deny'; reason:string; version?:number }
export interface BudgetInput { scope:BudgetScope; scopeId:UUID; period:BudgetPeriod; metric:BudgetMetric; softLimit?:number|null; hardLimit:number; enabled?:boolean }
export interface PaginationQuery { cursor?:string; limit?:number }
export interface RequestPrincipal { tenantId:TenantId; userId:UUID; membershipId:UUID; roles:readonly Role[]; permissions:ReadonlySet<Permission>; sessionId:UUID }
