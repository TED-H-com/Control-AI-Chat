import type { AdminUserActions, Role } from '../../shared/api.js';
import { ROLE_PERMISSIONS, hasGovernancePermission } from '../../lib/governance/permissions.js';
import type { TenantRole } from '../../lib/governance/types.js';

export const ASSIGNABLE_ROLES = ['admin','compliance','member'] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export const tenantRoles = (values:readonly string[]):TenantRole[] => values.filter(value=>Object.hasOwn(ROLE_PERMISSIONS,value)) as TenantRole[];

const permissionsFor = (roles:readonly TenantRole[]):Set<string> => {
  const permissions=new Set<string>();
  for(const role of roles)for(const permission of ROLE_PERMISSIONS[role])permissions.add(permission);
  return permissions;
};

/** A caller may cross an account boundary only when it is not more privileged than the caller. */
export function canActOnAccount(callerRoles:readonly TenantRole[],targetRoles:readonly TenantRole[]):boolean {
  const caller=permissionsFor(callerRoles);
  return [...permissionsFor(targetRoles)].every(permission=>caller.has(permission));
}

export function assignableRoles(callerRoles:readonly TenantRole[]):AssignableRole[] {
  return ASSIGNABLE_ROLES.filter(role=>hasGovernancePermission(callerRoles,
    role==='admin'?'member.assign_admin_role':role==='compliance'?'member.assign_compliance_role':'member.assign_member_role'));
}

export function canAssignRole(callerRoles:readonly TenantRole[],role:TenantRole):role is AssignableRole {
  return role!=='owner'&&assignableRoles(callerRoles).includes(role);
}

function primaryRole(roles:readonly TenantRole[]):TenantRole {
  return (['owner','admin','compliance','member'] as const).find(role=>roles.includes(role))??'member';
}

export interface AccountPolicySubject {readonly userId:string;readonly roles:readonly TenantRole[]}
export interface AccountPolicyTarget extends AccountPolicySubject {readonly status:string}

export function credentialLinkForAccount(caller:AccountPolicySubject,target:AccountPolicyTarget):'setup'|'reset'|null {
  if(caller.userId===target.userId||!canActOnAccount(caller.roles,target.roles))return null;
  if(target.status==='invited')return hasGovernancePermission(caller.roles,'member.invite')?'setup':null;
  if(target.status!=='active')return null;
  if(caller.roles.includes('owner'))return'reset';
  return caller.roles.includes('admin')&&primaryRole(target.roles)==='member'?'reset':null;
}

export function accountActions(caller:AccountPolicySubject,target:AccountPolicyTarget):AdminUserActions {
  const self=caller.userId===target.userId,mayAct=!self&&canActOnAccount(caller.roles,target.roles);
  return {
    changeStatus:mayAct&&['active','suspended'].includes(target.status)&&hasGovernancePermission(caller.roles,'member.suspend'),
    changeRole:mayAct&&assignableRoles(caller.roles).length>0,
    deprovision:mayAct&&hasGovernancePermission(caller.roles,'member.deprovision'),
    signOut:self||(mayAct&&hasGovernancePermission(caller.roles,'member.suspend')),
    credentialLink:credentialLinkForAccount(caller,target),
  };
}
