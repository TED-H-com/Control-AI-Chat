import type { TenantRole } from './types.js';

export const GOVERNANCE_PERMISSIONS = ['tenant.read','tenant.update','tenant.transfer_ownership','tenant.suspend','member.read','member.invite','member.update_profile','member.suspend','member.deprovision','member.assign_member_role','member.assign_admin_role','member.assign_compliance_role','group.read','group.create','group.update','group.delete','group.membership.update','model.read','model.tenant_access.update','model.group_access.update','model.pricing.update','model.default.update','assistant.read','assistant.create','assistant.update','assistant.delete','provider.group_allowlist.update','budget.read','budget.update','budget.adjust_usage','rate_limit.read','rate_limit.update','retention.read','retention.update','retention.legal_hold.update','audit.read_metadata','audit.read_transcript','audit.export','audit.verify_chain','violation.read','violation.resolve','report.read','report.export','policy.read','policy.update','approval.read','approval.decide','integration.read','integration.update'] as const;
export type GovernancePermission = typeof GOVERNANCE_PERMISSIONS[number];
const adminDenied = new Set<GovernancePermission>(['tenant.transfer_ownership','tenant.suspend','budget.adjust_usage','member.assign_compliance_role','retention.legal_hold.update','audit.read_transcript','audit.export','approval.decide']);
const compliance = new Set<GovernancePermission>(['tenant.read','member.read','group.read','model.read','assistant.read','budget.read','rate_limit.read','retention.read','retention.legal_hold.update','audit.read_metadata','audit.read_transcript','audit.export','audit.verify_chain','violation.read','violation.resolve','report.read','report.export','policy.read','approval.read','approval.decide','integration.read']);
export const ROLE_PERMISSIONS:Record<TenantRole,ReadonlySet<GovernancePermission>> = {
  owner:new Set(GOVERNANCE_PERMISSIONS), admin:new Set(GOVERNANCE_PERMISSIONS.filter(p=>!adminDenied.has(p))), compliance, member:new Set(),
};
export function hasGovernancePermission(role:TenantRole|readonly TenantRole[], permission:GovernancePermission):boolean {
  return (Array.isArray(role)?role:[role]).some(value=>ROLE_PERMISSIONS[value as TenantRole].has(permission));
}
export function assertGovernancePermission(role:TenantRole|readonly TenantRole[], permission:GovernancePermission):void {
  if (!hasGovernancePermission(role,permission)) throw new Error(`Roles ${(Array.isArray(role)?role:[role]).join(',')} lack ${permission}`);
}
