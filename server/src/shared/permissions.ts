import type { Permission, Role } from './api.js';

/**
 * The tenant-scoped permission vocabulary, and the role each permission belongs to.
 *
 * Authorization resolves per request from `role_permissions` in the database, never from the role
 * name on the JWT. That means a role with no rows in `role_permissions` can do nothing at all, and
 * a tenant whose owner could sign in and then received `FORBIDDEN` from every route in the product.
 *
 */
export const TENANT_PERMISSIONS: readonly Permission[] = [
  'chat:use','project:read','project:write','skill:read','skill:write',
  'file:read','file:write','profile:write','session:manage',
  'admin:users','admin:groups','admin:settings',
  'policy:read','policy:write','approval:read','approval:decide',
  'audit:read','audit:export','budget:read','budget:write',
  'model:read','model:write','assistant:read','assistant:write','legal_hold:manage',
];

// What everyone gets: use the product, manage their own things, see which models they may pick.
const MEMBER: readonly Permission[] = [
  'chat:use','project:read','project:write','skill:read','skill:write',
  'file:read','file:write','profile:write','session:manage','model:read','assistant:read',
];

// Review and decide, but configure nothing. A compliance reviewer who can also rewrite the policy
// they are reviewing against, or grant themselves a model, is not a control.
const COMPLIANCE: readonly Permission[] = [
  ...MEMBER,'policy:read','approval:read','approval:decide','audit:read','audit:export',
  'budget:read','legal_hold:manage',
];

// Configure everything, and investigate — but do not decide approvals and do not take custody of
// exported evidence. Separation between the administrator who writes the policy and the reviewer
// who enforces it is the control an auditor looks for; collapsing them is what gets written up.
const ADMIN: readonly Permission[] = TENANT_PERMISSIONS.filter(
  permission=>permission!=='approval:decide'&&permission!=='audit:export'&&permission!=='legal_hold:manage');

export const ROLE_PERMISSIONS: Readonly<Record<Role,readonly Permission[]>> = {
  owner:TENANT_PERMISSIONS, admin:ADMIN, compliance:COMPLIANCE, member:MEMBER,
};

// Every role a tenant is created with. Derived from the matrix rather than written out again, because
// tenant creation paths once disagreed about these rows, and `admin.users.update` resolves the
// target role by key against that table — so a
// signed-up tenant answered 404 for every promotion and could appoint neither an admin nor a reviewer.
export const ROLES = Object.keys(ROLE_PERMISSIONS) as readonly Role[];

// The `permissions` and `role_permissions` tables store `resource.action`; the API contract and the
// `Permission` union use `resource:action`. Both directions live here so the two spellings cannot
// drift apart in the four places that used to convert inline.
export const toStorageKey = (permission:Permission):string => permission.replace(':','.');
export const fromStorageKey = (key:string):Permission => key.replace('.',':') as Permission;
