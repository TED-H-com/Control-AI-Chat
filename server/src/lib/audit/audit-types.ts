import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";
import type { AuditAction } from "./audit-actions.js";
import type { AuditCategoryName } from "../../shared/audit-actions.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type AuditCategory = AuditCategoryName;
export type AuditOutcome =
  | "success"
  | "failure"
  | "denied"
  | "pending"
  | "cancelled";
export type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ActorType = "user" | "service" | "anonymous" | "provider";
export type TargetType =
  | "tenant"
  | "user"
  | "group"
  | "conversation"
  | "message"
  | "project"
  | "skill"
  | "file"
  | "policy_rule"
  | "model"
  | "provider"
  | "budget"
  | "approval"
  | "violation"
  | "export"
  | "session"
  | "domain"
  | "none";
export type GateAction =
  | "allow"
  | "flag"
  | "redact"
  | "mask"
  | "warn"
  | "block"
  | "require_approval";
export type AuditSource = "http" | "worker" | "cli";

export interface AuditActor {
  type: ActorType;
  id: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  authMethod:
    | "password"
    | "api_key"
    | "mfa"
    | "system"
    | null;
}
export interface AuditTarget {
  type: TargetType;
  id: string | null;
}
export interface AuditContext {
  requestId: string;
  traceId: string | null;
  source: AuditSource;
  occurredAtMs?: number;
}
export interface TranscriptCaptureInput {
  direction: "input" | "output" | "file" | "system";
  sanitizedContent: string;
  sanitizedPreview: string | null;
  tokenCount: number | null;
  redactionCount: number;
  retentionClass: "chat" | "violation" | "approval" | "identity";
}
export interface AuditAppendInput<A extends AuditAction = AuditAction> {
  tenantId: TenantId;
  action: A;
  actor: AuditActor;
  target: AuditTarget;
  outcome: AuditOutcome;
  context: AuditContext;
  subjectUserId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  gateAction?: GateAction | null;
  detector?: string | null;
  metadata: JsonObject;
  transcript?: TranscriptCaptureInput;
}
export interface AuditReceipt {
  id: string;
  tenantId: TenantId;
  chainEpoch: number;
  sequence: number;
  eventHash: string;
  recordedAtMs: number;
}
export interface StoredAuditEvent extends AuditReceipt {
  occurredAtMs: number;
  action: AuditAction;
  category: AuditCategory;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  actorType: ActorType;
  actorId: string | null;
  actorSessionId: string | null;
  actorIpHmac: string | null;
  actorUserAgent: string | null;
  subjectUserId: string | null;
  groupId: string | null;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  targetType: TargetType;
  targetId: string | null;
  modelId: string | null;
  providerId: string | null;
  gateAction: GateAction | null;
  detector: string | null;
  requestId: string;
  traceId: string | null;
  source: AuditSource;
  metadata: JsonObject;
  transcriptId: string | null;
  transcriptDigest: string | null;
  prevHash: string;
  hashVersion: 1;
}
export interface AuditHashV1 {
  v: 1;
  tenant_id: string;
  chain_epoch: number;
  sequence: number;
  id: string;
  occurred_at_ms: number;
  recorded_at_ms: number;
  action: string;
  category: AuditCategory;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  actor_type: ActorType;
  actor_id: string | null;
  actor_session_id: string | null;
  actor_ip_hmac: string | null;
  actor_user_agent: string | null;
  subject_user_id: string | null;
  group_id: string | null;
  project_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  target_type: TargetType;
  target_id: string | null;
  model_id: string | null;
  provider_id: string | null;
  gate_action: GateAction | null;
  detector: string | null;
  request_id: string;
  trace_id: string | null;
  source: AuditSource;
  metadata: JsonValue;
  transcript_id: string | null;
  transcript_digest: string | null;
  prev_hash: string;
}
export interface TenantRetentionPolicy {
  tenantId: TenantId;
  chatTranscriptDays: number;
  violationTranscriptDays: number;
  approvalPayloadDays: number;
  auditMetadataDays: null;
  captureTranscripts: boolean;
  effectiveAtMs: number;
}
export interface AuditDependencies {
  database: Database.Database;
  ipHmacKey: Uint8Array;
  transcriptKey: (tenantId: TenantId) => Uint8Array;
  retentionPolicy: (tenantId: TenantId) => TenantRetentionPolicy;
  now?: () => number;
  id?: () => string;
}
