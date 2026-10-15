import type { ApprovalReleaseStatus as SharedApprovalReleaseStatus, GateAction, GateDirection, Permission, Role } from '@shared/api';

// Derived from the server union instead of transcribed, so renaming a permission on the server
// breaks this build rather than silently hiding every screen behind a string nobody grants.
export type AdminPermission = Permission;

export interface AdminCapabilities {
  tenantId:string;
  userId:string;
  tenantName?:string;
  tenantSlug?:string;
  roleIds:string[];
  assignableRoles:Array<Exclude<Role,'owner'>>;
  permissions:AdminPermission[];
  tenantTimezone:string;
  tenantCurrency:'USD';
  contentAccessReasonRequired:boolean;
  tenant?:{id:string;name:string;slug:string;status?:string};
}
export interface AdminPage<T> { items:T[]; nextCursor:string|null; total?:number }
export type AdminRecord = Readonly<Record<string, unknown>>;
export interface AssistantRecord {id:string;name:string;description:string|null;systemPrompt:string;modelCatalogId:string;model:string;version:number;createdAt:string;updatedAt:string}
export type ViolationTriageStatus='open'|'triaged'|'in_review'|'approved'|'resolved'|'dismissed';
export type ApprovalReleaseStatus=SharedApprovalReleaseStatus;
export interface ViolationAssignee { id:string;name:string;email:string }
export interface ViolationComment { id:string;author:string;authorId:string;body:string;createdAt:string }
export type ViolationDetail=AdminRecord & {
  id:string;status:string;version:number;assignee:string|null;assigneeId:string|null;dueAt:string|null;
  resolutionReason:string|null;resolvedBy:string|null;resolvedById:string|null;resolvedAt:string|null;updatedAt:string;
  allowedTransitions:ViolationTriageStatus[];comments:ViolationComment[];
};
export interface ApprovalProgress { id:string;status:string;releaseStatus:ApprovalReleaseStatus;releaseErrorCode:string|null;releaseMessageId:string|null;releaseAttempts:number;version:number }
export type DetectorKind = 'keyword'|'regex'|'pii'|'secret'|'source_code'|'classification'|'prompt_injection'|'semantic'|'institution'|'file';
export interface GateRuleRecord {
  id:string;
  policy_id:string;
  policy_name:string;
  detector_id:string;
  detector_key:string;
  detector_kind:DetectorKind|'injection';
  scope_type:'tenant'|'group'|'user'|'model';
  scope_id:string|null;
  direction:GateDirection;
  action:GateAction;
  severity:'low'|'medium'|'high'|'critical';
  config_json:string;
  enabled:0|1;
  priority:number;
  updated_at:number;
}
export interface DetectorRecord {
  id:string;
  name:string;
  detectorKind:DetectorKind|'injection';
  config:Record<string,unknown>;
  enabled:boolean;
  builtin:boolean;
}
export interface PolicyRecord { id:string;name:string;description:string|null;enabled:0|1;priority:number }
export interface PolicyTestResult {
  published:false;
  action:GateAction;
  disposition:'allow_provider_call'|'await_user_confirmation'|'blocked'|'pending_approval'|'release_to_user';
  matches:Array<{category:string;confidence:'low'|'medium'|'high';safeExcerpt:string;start:number|null;end:number|null}>;
  degraded:boolean;
  failureCodes:string[];
  timings:{resolveUs:number;normalizeUs:number;deterministicUs:number;semanticUs:number;vaultUs:number;totalUs:number};
}
