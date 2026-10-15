import type { RouteDefinition } from './definition.js';

const T='tenant' as const, P='public' as const;
const j='json' as const, n='none' as const;
export const routeDefinitions:readonly RouteDefinition[] = [
  {method:'POST',path:'/auth/login',operation:'auth.login',access:P,body:j},
  {method:'POST',path:'/auth/logout',operation:'auth.logout',access:T,body:j,success:204},
  {method:'POST',path:'/auth/refresh',operation:'auth.refresh',access:P,body:j},
  {method:'GET',path:'/auth/me',operation:'auth.me',access:T,body:n},
  {method:'GET',path:'/deployment',operation:'deployment.get',access:P,body:n},
  {method:'GET',path:'/deployment/icon',operation:'deployment.icon',access:P,body:n},
  {method:'GET',path:'/deployment/support',operation:'deployment.support',access:T,body:n},
  {method:'GET',path:'/me/preferences',operation:'me.preferences',access:T,body:n},
  {method:'PATCH',path:'/me/preferences',operation:'me.preferences.update',access:T,permission:'profile:write',body:j,idempotency:true},
  // Public recovery has no authenticated tenant/actor with which to bind the durable idempotency
  // record. Forgot is deliberately uniform and reset is already made retry-safe by atomic token
  // consumption, so requiring a key here would advertise a guarantee the store cannot provide.
  {method:'POST',path:'/auth/password/forgot',operation:'auth.passwordForgot',access:P,body:j,success:202},
  {method:'POST',path:'/auth/password/reset',operation:'auth.passwordReset',access:P,body:j},
  {method:'POST',path:'/auth/password/change',operation:'auth.passwordChange',access:T,body:j,idempotency:true},
  {method:'PATCH',path:'/identity/me',operation:'identity.updateMe',access:T,permission:'profile:write',body:j,ifMatch:true,idempotency:true},
  {method:'GET',path:'/identity/sessions',operation:'identity.sessions',access:T,permission:'session:manage',body:n},
  {method:'DELETE',path:'/identity/sessions/:id',operation:'identity.revokeSession',access:T,permission:'session:manage',body:n,success:204,idempotency:true},
  {method:'POST',path:'/identity/sessions/revoke-others',operation:'identity.revokeOthers',access:T,body:j,idempotency:true},
  // Setup and verification return one-time secret material. Until those exact responses can be
  // durably replayed, requiring an Idempotency-Key would advertise a guarantee these routes do not
  // provide: retrying setup replaces the pending secret, and retrying verify cannot reproduce the
  // recovery codes after the enrollment row is consumed.
  {method:'POST',path:'/identity/mfa/totp/setup',operation:'identity.mfaSetup',access:T,body:j,success:201},
  {method:'POST',path:'/identity/mfa/totp/verify',operation:'identity.mfaVerify',access:T,body:j},
  {method:'DELETE',path:'/identity/mfa/totp',operation:'identity.mfaDelete',access:T,body:n,success:204},
  {method:'GET',path:'/models',operation:'models.available',access:T,permission:'model:read',body:n},
  {method:'GET',path:'/assistants',operation:'assistants.available',access:T,permission:'assistant:read',body:n},
  {method:'POST',path:'/assistants/draft-from-url',operation:'assistants.draftFromUrl',access:T,permission:'assistant:write',body:j,idempotency:true},
  ...resource('/conversations','conversations',T),
  {method:'POST',path:'/conversations/:id/restore',operation:'conversations.restore',access:T,body:j,idempotency:true},
  {method:'GET',path:'/conversations/:id/messages',operation:'conversations.messages',access:T,body:n},
  {method:'GET',path:'/chat/runs/:id',operation:'chat.getRun',access:T,body:n},
  {method:'DELETE',path:'/chat/runs/:id',operation:'chat.cancel',access:T,body:n,success:202},
  ...resource('/projects','projects',T,'project:read','project:write'),
  {method:'GET',path:'/projects/:id/conversations',operation:'projects.conversations',access:T,body:n},
  {method:'GET',path:'/projects/:id/files',operation:'projects.files',access:T,body:n},
  ...resource('/skills','skills',T,'skill:read','skill:write'),
  {method:'POST',path:'/skills/:id/render',operation:'skills.render',access:T,body:j,idempotency:true},
  {method:'POST',path:'/files',operation:'files.upload',access:T,permission:'file:write',body:'multipart',success:202,idempotency:true},
  {method:'GET',path:'/files/:id',operation:'files.get',access:T,permission:'file:read',body:n},
  {method:'GET',path:'/files/:id/content',operation:'files.content',access:T,permission:'file:read',body:n},
  {method:'GET',path:'/files/:id/extracted',operation:'files.extracted',access:T,permission:'file:read',body:n},
  {method:'DELETE',path:'/files/:id',operation:'files.delete',access:T,permission:'file:write',body:n,success:204,ifMatch:true,idempotency:true},
  ...resource('/gate/rules','gate.rules',T,'policy:read','policy:write'),
  {method:'GET',path:'/gate/policies',operation:'gate.policies.list',access:T,permission:'policy:read',body:n},
  {method:'POST',path:'/gate/rules/test',operation:'gate.test',access:T,permission:'policy:write',body:j,idempotency:true},
  {method:'GET',path:'/gate/decisions/:id',operation:'gate.decision',access:T,body:n},
  // `gate.confirm` is not a catalog route. Confirming a warning resumes the run, which streams,
  // and a catalog route JSON-encodes one RouteResult. It also lives in createChatRoutes because
  // mountDefinitions runs first and would otherwise shadow it forever. See routes/chat.ts.
  {method:'GET',path:'/gate/approvals',operation:'gate.approvals',access:T,permission:'approval:read',body:n},
  {method:'GET',path:'/gate/approvals/:id',operation:'gate.approval',access:T,permission:'approval:read',body:n},
  {method:'POST',path:'/gate/approvals/:id/decision',operation:'gate.approvalDecision',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'GET',path:'/audit/events',operation:'audit.events',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/audit/events/:id',operation:'audit.event',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/audit/integrity',operation:'audit.integrity',access:T,permission:'audit:read',body:n},
  {method:'POST',path:'/audit/exports',operation:'audit.createExport',access:T,permission:'audit:export',body:j,success:202,idempotency:true},
  {method:'GET',path:'/audit/exports/:id',operation:'audit.export',access:T,permission:'audit:export',body:n},
  {method:'GET',path:'/audit/exports/:id/download',operation:'audit.download',access:T,permission:'audit:export',body:n},
  // Before the collection, not after: `/budgets/:id` matches 'me' too, and whichever is declared
  // first is the only one ever invoked. Declared second, this answered 404 for every caller.
  {method:'GET',path:'/budgets/me',operation:'budgets.me',access:T,body:n},
  ...resource('/budgets','budgets',T,'budget:read','budget:write'),
  // Deliberately not gated by a `permission:`. This is the console's first call and it exists to ask
  // "what may I do here"; gating it would 403 exactly the users who need the answer, and it discloses
  // nothing beyond the caller's own grants.
  {method:'GET',path:'/admin/me/capabilities',operation:'admin.capabilities',access:T,body:n},
  {method:'GET',path:'/admin/dashboard',operation:'admin.dashboard',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/nudges',operation:'admin.nudges',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/analytics/timeseries',operation:'admin.analytics.timeseries',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/analytics/breakdown',operation:'admin.analytics.breakdown',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/analytics/detectors',operation:'admin.analytics.detectors',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/roles',operation:'admin.roles.list',access:T,permission:'admin:users',body:n},
  {method:'GET',path:'/admin/retention',operation:'admin.retention.list',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/legal-holds',operation:'admin.legalHolds.list',access:T,permission:'audit:read',body:n},
  {method:'GET',path:'/admin/legal-hold-users',operation:'admin.legalHolds.users',access:T,permission:'audit:read',body:n},
  {method:'POST',path:'/admin/legal-holds',operation:'admin.legalHolds.create',access:T,permission:'legal_hold:manage',body:j,success:201,idempotency:true},
  {method:'POST',path:'/admin/legal-holds/:id/release',operation:'admin.legalHolds.release',access:T,permission:'legal_hold:manage',body:j,idempotency:true},
  // Tenant-wide, unlike `/projects`, which serves the caller their own. `project:read` is the right
  // gate either way — the difference is scope, and the admin scope is what the console asks for.
  {method:'GET',path:'/admin/projects',operation:'admin.projects.list',access:T,permission:'project:read',body:n},
  {method:'GET',path:'/admin/custom-terms',operation:'admin.customTerms.list',access:T,permission:'policy:read',body:n},
  {method:'GET',path:'/admin/compliance',operation:'admin.compliance.summary',access:T,permission:'policy:read',body:n},
  {method:'POST',path:'/admin/custom-terms',operation:'admin.customTerms.upsert',access:T,permission:'policy:write',body:j,idempotency:true},
  {method:'DELETE',path:'/admin/custom-terms',operation:'admin.customTerms.delete',access:T,permission:'policy:write',body:j,idempotency:true},
  {method:'GET',path:'/admin/violations',operation:'admin.violations',access:T,permission:'approval:read',body:n},
  {method:'GET',path:'/admin/violations/assignees',operation:'admin.violationAssignees',access:T,permission:'approval:read',body:n},
  {method:'POST',path:'/admin/violations/bulk',operation:'admin.violationsBulk',access:T,permission:'approval:decide',body:j,idempotency:true},
  {method:'GET',path:'/admin/violations/:id',operation:'admin.violation',access:T,permission:'approval:read',body:n},
  {method:'POST',path:'/admin/violations/:id/assign',operation:'admin.violationAssign',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/violations/:id/acknowledge',operation:'admin.violationAcknowledge',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/violations/:id/status',operation:'admin.violationStatus',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/violations/:id/dismiss',operation:'admin.violationDismiss',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/violations/:id/due',operation:'admin.violationDue',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/violations/:id/notes',operation:'admin.violationNote',access:T,permission:'approval:decide',body:j,ifMatch:true,idempotency:true},
  ...adminDefinitions(),
  {method:'GET',path:'/jobs/:id',operation:'jobs.get',access:T,body:n},
  {method:'GET',path:'/health/live',operation:'health.live',access:P,body:n},
  {method:'GET',path:'/health/ready',operation:'health.ready',access:'internal',body:n},
];

function resource(path:string,op:string,access:typeof T,read?:RouteDefinition['permission'],write?:RouteDefinition['permission']):RouteDefinition[] {
  const rp=read?{permission:read}:{}; const wp=write?{permission:write}:{};
  return [
    {method:'GET',path,operation:`${op}.list`,access,...rp,body:n},
    {method:'POST',path,operation:`${op}.create`,access,...wp,body:j,success:201,idempotency:true},
    {method:'GET',path:`${path}/:id`,operation:`${op}.get`,access,...rp,body:n},
    {method:'PATCH',path:`${path}/:id`,operation:`${op}.update`,access,...wp,body:j,ifMatch:true,idempotency:true},
    {method:'DELETE',path:`${path}/:id`,operation:`${op}.delete`,access,...wp,body:n,success:204,ifMatch:true,idempotency:true},
  ];
}

function adminDefinitions():RouteDefinition[] { return [
  {method:'GET',path:'/admin/settings',operation:'admin.settings.get',access:T,permission:'admin:settings',body:n},
  {method:'PATCH',path:'/admin/settings',operation:'admin.settings.update',access:T,permission:'admin:settings',body:j,ifMatch:true,idempotency:true},
  {method:'POST',path:'/admin/settings/icon',operation:'admin.settings.icon',access:T,permission:'admin:settings',body:'multipart'},
  ...resource('/admin/users','admin.users',T,'admin:users','admin:users'),
  {method:'POST',path:'/admin/users/:id/credential-link',operation:'admin.users.credentialLink',access:T,permission:'admin:users',body:j,idempotency:true},
  {method:'POST',path:'/admin/users/:id/force-logout',operation:'admin.users.forceLogout',access:T,permission:'admin:users',body:j,idempotency:true},
  ...resource('/admin/groups','admin.groups',T,'admin:groups','admin:groups'),
  {method:'PUT',path:'/admin/groups/:id/members/:userId',operation:'admin.groups.addMember',access:T,permission:'admin:groups',body:j,success:204,ifMatch:true,idempotency:true},
  {method:'DELETE',path:'/admin/groups/:id/members/:userId',operation:'admin.groups.removeMember',access:T,permission:'admin:groups',body:n,success:204,ifMatch:true,idempotency:true},
  {method:'GET',path:'/admin/models',operation:'admin.models.list',access:T,permission:'model:read',body:n},
  {method:'POST',path:'/admin/models',operation:'admin.models.create',access:T,permission:'model:write',body:j,success:201,idempotency:true},
  {method:'PATCH',path:'/admin/models/:id',operation:'admin.models.update',access:T,permission:'model:write',body:j,ifMatch:true,idempotency:true},
  {method:'GET',path:'/admin/assistants',operation:'admin.assistants.list',access:T,permission:'assistant:read',body:n},
  {method:'GET',path:'/admin/assistants/:id',operation:'admin.assistants.get',access:T,permission:'assistant:read',body:n},
  {method:'POST',path:'/admin/assistants',operation:'admin.assistants.create',access:T,permission:'assistant:write',body:j,success:201,idempotency:true},
  {method:'PATCH',path:'/admin/assistants/:id',operation:'admin.assistants.update',access:T,permission:'assistant:write',body:j,ifMatch:true,idempotency:true},
  {method:'DELETE',path:'/admin/assistants/:id',operation:'admin.assistants.delete',access:T,permission:'assistant:write',body:n,success:204,idempotency:true},
  {method:'PUT',path:'/admin/groups/:groupId/models/:modelId',operation:'admin.models.enableForGroup',access:T,permission:'model:write',body:j,ifMatch:true,idempotency:true},
  {method:'DELETE',path:'/admin/groups/:groupId/models/:modelId',operation:'admin.models.disableForGroup',access:T,permission:'model:write',body:n,success:204,ifMatch:true,idempotency:true},
  {method:'GET',path:'/admin/providers',operation:'admin.providers.list',access:T,permission:'model:read',body:n},
  {method:'PUT',path:'/admin/groups/:groupId/providers/:providerId',operation:'admin.providers.setGroupAccess',access:T,permission:'model:write',body:j,ifMatch:true,idempotency:true},
  {method:'PUT',path:'/admin/providers/:providerId/credential',operation:'admin.providers.setCredential',access:T,permission:'admin:settings',body:j,idempotency:true},
  {method:'DELETE',path:'/admin/providers/:providerId/credential',operation:'admin.providers.clearCredential',access:T,permission:'admin:settings',body:n,success:204,idempotency:true},
  ...resource('/admin/detectors','admin.detectors',T,'policy:read','policy:write'),
]; }
