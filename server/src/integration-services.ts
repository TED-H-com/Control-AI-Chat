import { createDurableMutationIdempotency } from './app/idempotency/mutation.js';
import { createHash, randomUUID } from 'node:crypto';
import type { RouteRequest, RouteResult, ApiRouteServices } from './routes/index.js';
import type { AvailableAssistant, AvailableModel, Model, RequestPrincipal, Permission, Provider } from './shared/api.js';
import { TENANT_PERMISSIONS, fromStorageKey } from './shared/permissions.js';
import type { TenantId } from './shared/types.js';
import { db } from './lib/db.js';
import { config } from './config.js';
import { authorizeAccess } from './lib/identity/sessions.js';
import {assertStoredKeyCoverage} from './lib/crypto/key-coverage.js';
import { createAuditService, createTenantRetentionPolicy, type AuditService, type AuditTransaction } from './lib/audit/index.js';
import type { AuditAction } from './lib/audit/audit-actions.js';
import { deploymentBrand,deploymentSupport } from './app/deployment/branding.js';
import { createIdentityService, type IdentityAuditInput } from './app/identity/index.js';
import { createAdminAdapter, prepareAdminStatements } from './app/admin/index.js';
import { prepareConsoleStatements } from './app/admin/capabilities.js';
import { prepareAnalyticsStatements } from './app/admin/analytics.js';
import { prepareNudgeStatements } from './app/admin/nudges.js';
import { createDirectoryReader } from './app/admin/directory.js';
import { createAuditRouteAdapter } from './app/audit/index.js';
import { createViolationTriageAdapter } from './app/audit/violation-triage.js';
import { createGateDecisionReader } from './app/gate/decisions.js';
import { createMyBudgetReader } from './app/budgets/me.js';
import { createHealthProbes } from './app/health/probes.js';
import { createFilesAdapter } from './app/files/index.js';
import { createSmtpMailer } from './lib/email/mailer.js';
import { ConversationRepository, MessageRepository, ProjectRepository, SkillRepository, UserPreferenceRepository } from './app/repositories/index.js';
import { ApprovalReleaseWorker, createGovernedChatApplication } from './app/chat/index.js';
import type { ConfirmRunDependencies } from './app/chat/confirm-run.js';
import { DefaultGateEngine, deterministicDetectors, StatelessGateVault } from './lib/gate/index.js';
import { ProviderRegistry, PROVIDERS } from './lib/providers/registry.js';
import { clearTenantProviderCredential, deriveProviderCredentialKey, setTenantProviderCredential, TenantProviderRegistry } from './lib/providers/tenant-registry.js';
import { supportsReasoningEffort } from './lib/providers/reasoning-capability.js';
import type { Role } from './shared/api.js';
import { resolveEffectiveModels } from './lib/governance/modelAccess.js';
import { draftAssistantFromUrl } from './app/assistants/draft-from-url.js';
import { createAssistantDraftAdapter } from './app/assistants/draft-from-url-route.js';
import { safeFetchText } from './lib/net/safe-fetch.js';
import { validateProviderBaseUrl } from './lib/net/safe-fetch.js';
import { resolvePolicy } from './lib/gate/resolve-policy.js';
import { createDiskBlobStore } from './app/files/storage.js';

const permissions=TENANT_PERMISSIONS;
const key = (label:string):Buffer => createHash('sha256').update(`${label}:${config.auditKey}`).digest();
const providerCredentialKeys=new Map<number,Uint8Array>(Object.entries(config.providerCredentialPreviousKeys).map(([version,root])=>[Number(version),deriveProviderCredentialKey(root,Number(version))]));
providerCredentialKeys.set(config.providerCredentialKeyVersion,deriveProviderCredentialKey(config.providerCredentialKey,config.providerCredentialKeyVersion));
// Refuse at startup if an enabled provider credential names a key version this process cannot open.
assertStoredKeyCoverage(db,config);
export const retentionPolicy=createTenantRetentionPolicy(db);
export const audit = createAuditService({database:db,ipHmacKey:key('ip'),transcriptKey:tenantId=>key(`transcript:${tenantId}`),retentionPolicy});

function body(request:RouteRequest):Record<string,unknown> { return typeof request.body==='object'&&request.body!==null ? request.body as Record<string,unknown> : {}; }
function principal(userId:string,tenantId:string,sessionId:string):RequestPrincipal|null {
  const account=db.prepare<[string,string],{user_status:string;tenant_status:string}>('SELECT u.status user_status,t.status tenant_status FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=? AND u.id=? AND u.deleted_at IS NULL').get(tenantId,userId);
  if(!account||account.user_status!=='active'||account.tenant_status!=='active')return null;
  const rows=db.prepare<[string,string],{role:string;permission_key:string|null}>(`SELECT r.key role,rp.permission_key FROM user_roles ur JOIN roles r ON r.id=ur.role_id LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE ur.tenant_id=? AND ur.user_id=?`).all(tenantId,userId);
  const roles=[...new Set(rows.map(row=>row.role).filter((role):role is Role=>['owner','admin','compliance','member'].includes(role)))];
  if(!roles.length)return null;
  const currentPermissions=new Set(rows.map(row=>row.permission_key?fromStorageKey(row.permission_key):null).filter((value):value is Permission=>value!==null&&permissions.includes(value)));
  return {userId,tenantId:tenantId as TenantId,membershipId:userId,sessionId,roles,permissions:currentPermissions};
}
export function resolvePrincipal(cookie:string|undefined):RequestPrincipal|null {
  if (!cookie) return null;
  const match=/(?:^|;\s*)__Host-session=([^;]+)/.exec(cookie);
  if (!match?.[1]) return null;
  try { const claims=authorizeAccess(db,decodeURIComponent(match[1]),config.jwtSecret); return claims.mfa?principal(claims.sub,claims.tid,claims.sid):null; } catch { return null; }
}

// Every identity event used to be written as `identity.session_created` / `outcome:'success'`, with
// the real action buried in `metadata.identityAction`. An auditor filtering the log for logouts,
// revocations found nothing, and a failure was indistinguishable from a success.
// The service's own vocabulary is `auth.*`; the audit registry's is `identity.*`. Map them
// explicitly — an unmapped action is logged loudly rather than silently mislabelled, because the
// registry rejects unknown names and throwing here would take the login path down with it.
const IDENTITY_ACTIONS=new Map<string,{action:AuditAction;target:'session'|'user';outcome?:'failure'}>([
  ['auth.login_succeeded',{action:'identity.login_succeeded',target:'session'}],
  ['auth.login_failed',{action:'identity.login_failed',target:'user',outcome:'failure'}],
  ['auth.logout',{action:'identity.logout_completed',target:'session'}],
  ['auth.mfa_challenge_issued',{action:'identity.mfa_challenged',target:'user'}],
  ['auth.mfa_enabled',{action:'identity.mfa_enrolled',target:'user'}],
  ['auth.mfa_disabled',{action:'identity.mfa_disabled',target:'user'}],
  ['auth.session_revoked',{action:'identity.session_revoked',target:'session'}],
  ['auth.sessions_revoked',{action:'identity.sessions_revoked_all',target:'session'}],
  ['auth.password_changed',{action:'identity.password_changed',target:'user'}],
  ['auth.password_setup_completed',{action:'identity.password_setup_completed',target:'user'}],
  ['auth.password_reset_requested',{action:'identity.password_reset_requested',target:'user'}],
  ['auth.password_reset_completed',{action:'identity.password_reset_completed',target:'user'}],
]);
export function createIdentityAuditAdapter(productAudit:Pick<AuditService,'append'>){return{append(input:IdentityAuditInput){
  const mapped=IDENTITY_ACTIONS.get(input.action),requestId=input.requestId??randomUUID();
  if(!mapped){
    console.error(`AUDIT MAPPING GAP: identity action ${input.action} has no entry in IDENTITY_ACTIONS and was recorded as identity.session_created`);
    const suppliedAction=input.action.toLowerCase().replace(/[^a-z0-9_.-]/g,'_').slice(0,96)||'unknown';
    productAudit.append({tenantId:input.tenantId,action:'system.unknown_action_rejected',actor:{type:input.actorUserId?'user':'anonymous',id:input.actorUserId,sessionId:input.actorSessionId,ip:input.clientIp,userAgent:input.userAgent,authMethod:null},target:{type:'none',id:null},outcome:'failure',context:{requestId,traceId:null,source:'http'},metadata:{suppliedAction,source:'integration-services.IDENTITY_ACTIONS'}});
  }
  productAudit.append({tenantId:input.tenantId,action:mapped?.action??'identity.session_created',actor:{type:input.actorUserId?'user':'anonymous',id:input.actorUserId,sessionId:input.actorSessionId,ip:input.clientIp,userAgent:input.userAgent,authMethod:null},target:{type:mapped?.target??'session',id:input.targetId??(mapped?.target==='user'?input.actorUserId:null)},outcome:mapped?.outcome??'success',context:{requestId,traceId:null,source:'http'},metadata:{identityAction:input.action,...input.metadata}});
}}}
const identity=createIdentityService({database:db,jwtSecret:config.jwtSecret,
  encryptionKey:{id:'identity-v1',key:key('identity')},recoveryPepper:key('recovery').toString('hex'),
  audit:createIdentityAuditAdapter(audit),appOrigin:config.appOrigin,logger:console,...(config.smtp?{mailer:createSmtpMailer(config.smtp)}:{})});
const admin=createAdminAdapter({database:db,statements:prepareAdminStatements(db),console:prepareConsoleStatements(db),analytics:prepareAnalyticsStatements(db),nudges:prepareNudgeStatements(db),directory:createDirectoryReader(db),audit,uploadDir:config.uploadDir,appOrigin:config.appOrigin,logger:console,idempotencyHmacKey:key('admin-user-invitation-idempotency'),invitationResponseEncryptionKey:key('admin-user-invitation-response'),...(config.smtp?{mailer:createSmtpMailer(config.smtp)}:{})});
const gateDecisions=createGateDecisionReader({database:db,audit});
const myBudgets=createMyBudgetReader({database:db});
const health=createHealthProbes({database:db,startedAt:Date.now()});
const files=createFilesAdapter({database:db,audit,storageRoot:config.uploadDir});
export const deploymentBlobs=createDiskBlobStore(config.uploadDir);
const conversations=new ConversationRepository(db,audit),messages=new MessageRepository(db),projects=new ProjectRepository(db,audit),skills=new SkillRepository(db,audit),preferences=new UserPreferenceRepository(db);

async function repositories(operation:string,request:RouteRequest):Promise<RouteResult|null>{
  if(!request.tenant)return null;const c=request.tenant,input=body(request),id=request.params.id??'';const version=Number(request.headers.get('If-Match')?.replaceAll('"',''))||undefined;
  const withVersion=version===undefined?input:{...input,version};
  if(operation==='conversations.list')return{body:conversations.list(c,request.query)};if(operation==='conversations.get')return{body:{conversation:conversations.get(c,id),messages:messages.all(c,id)}};if(operation==='conversations.create')return{status:201,body:conversations.create(c,input)};if(operation==='conversations.update')return{body:conversations.update(c,id,withVersion)};if(operation==='conversations.delete'){conversations.delete(c,id,version);return{status:204}}if(operation==='conversations.restore')return{body:conversations.restore(c,id)};if(operation==='conversations.messages')return{body:messages.list(c,id,request.query)};
  if(operation==='projects.list')return{body:projects.list(c,request.query)};if(operation==='projects.get')return{body:projects.get(c,id)};if(operation==='projects.create')return{status:201,body:projects.create(c,input as {name:string;instructions?:string})};if(operation==='projects.update')return{body:projects.update(c,id,withVersion)};if(operation==='projects.delete'){projects.delete(c,id,version);return{status:204}}if(operation==='projects.files')return{body:projects.files(c,id,request.query)};if(operation==='projects.conversations')return{body:projects.conversations(c,id,request.query)};
  if(operation==='skills.list')return{body:skills.list(c,request.query)};if(operation==='skills.get')return{body:skills.get(c,id)};if(operation==='skills.create')return{status:201,body:skills.create(c,input as never)};if(operation==='skills.update')return{body:skills.update(c,id,{...input,version} as never)};if(operation==='skills.delete'){skills.delete(c,id,version);return{status:204}}if(operation==='skills.render')return{body:skills.render(c,id,(input.arguments??{}) as Record<string,string>,input as {conversationId?:string;messageId?:string})};
  if(operation==='identity.preferences'||operation==='me.preferences')return{body:preferences.get(c)};if(operation==='me.preferences.update')return{body:preferences.update(c,input)};
  if(operation==='models.available')return{body:availableModels(c.principal.tenantId,c.principal.userId)};
  if(operation==='assistants.available')return{body:availableAssistants(c.principal.tenantId,c.principal.userId)};
  return null;
}

export function availableAssistants(tenantId:TenantId,userId:string):AvailableAssistant[] {
  const allowed=new Set(resolveEffectiveModels(db,{tenantId,userId}).models.map(model=>model.id));
  return db.prepare<[TenantId],{id:string;name:string;description:string|null;model_catalog_id:string;display_name:string}>(`SELECT a.id,a.name,a.description,a.model_catalog_id,m.display_name
    FROM assistants a JOIN model_catalog m ON m.id=a.model_catalog_id AND m.tenant_id=a.tenant_id
    WHERE a.tenant_id=? ORDER BY a.name,a.id`).all(tenantId).filter(row=>allowed.has(row.model_catalog_id)).map(row=>({id:row.id,name:row.name,description:row.description,modelId:row.model_catalog_id,model:row.display_name}));
}

/**
 * The model picker. Nothing implemented this, so `GET /models` returned 501 and the chat surface
 * had no models to offer — the product's front door.
 *
 * It resolves through `resolveEffectiveModels`, the same function the chat run path enforces with,
 * rather than reading `model_catalog` directly. A picker built on a second query drifts from the
 * enforcement rule and starts offering models that the next request refuses, which reads to a
 * prospect as a broken product and to an administrator as a governance failure.
 */
function availableModels(tenantId:TenantId,userId:string):AvailableModel[] {
  const resolved=resolveEffectiveModels(db,{tenantId,userId});
  if(!resolved.models.length)return [];
  const ids=resolved.models.map(model=>model.id);
  const placeholders=ids.map(()=>'?').join(',');
  // The model catalogue is the same source routing and budget metering use.
  interface PickerMetadata {id:string;provider:Model['provider'];model_key:string;display_name:string;context_window:number;max_output_tokens:number;input_price:number;output_price:number;capabilities_json:string}
  const metadata=new Map(db.prepare(`SELECT m.id,m.provider_key provider,m.model_key,m.display_name,m.context_window,m.max_output_tokens,
      m.input_microusd_per_million input_price,m.output_microusd_per_million output_price,m.capabilities_json
    FROM model_catalog m WHERE m.id IN (${placeholders})`)
    .all(...ids).map(row=>{const item=row as PickerMetadata;return[item.id,item];}));
  const models=resolved.models.filter(model=>metadata.has(model.id));
  if(!models.length)return [];
  const capabilities=new Map([...metadata].map(([id,item])=>{const parsed=JSON.parse(item.capabilities_json) as unknown;return[id,(Array.isArray(parsed)?parsed:[]) as Model['capabilities']];}));
  // Why a given model is on offer. In a governance product "you can use this because you are in
  // Engineering" is the answer to the question the picker provokes; null means every group the
  // user belongs to grants it, so naming them would be noise.
  const names=new Map(db.prepare<[TenantId],{id:string;name:string}>('SELECT id,name FROM groups WHERE tenant_id=? AND deleted_at IS NULL')
    .all(tenantId).map(row=>[row.id,row.name]));
  const effortCapable=(model:(typeof resolved.models)[number]):boolean=>supportsReasoningEffort(
    metadata.get(model.id)!.provider,metadata.get(model.id)!.model_key,capabilities.get(model.id)??[],
  );
  const recommended=new Set<string>();
  for(const provider of PROVIDERS){
    const providerModels=models.filter(model=>metadata.get(model.id)!.provider===provider);
    const capable=providerModels.filter(effortCapable);
    const selected=capable.find(model=>model.id===resolved.defaultModelId)??[...capable].sort((left,right)=>
      metadata.get(left.id)!.input_price+metadata.get(left.id)!.output_price-(metadata.get(right.id)!.input_price+metadata.get(right.id)!.output_price)
      ||metadata.get(left.id)!.display_name.localeCompare(metadata.get(right.id)!.display_name)
      ||left.id.localeCompare(right.id))[0];
    if(selected)recommended.add(selected.id);
  }
  const defaultId=models.some(model=>model.id===resolved.defaultModelId)?resolved.defaultModelId:models[0]!.id;
  return models.map(model=>{
    const immutable=metadata.get(model.id)!;
    const declared=capabilities.get(model.id)??[];
    const effectiveCapabilities=effortCapable(model)&&!declared.includes('reasoning')
      ? [...declared,'reasoning'] as Model['capabilities']
      : declared;
    return {
    id:model.id,provider:immutable.provider,providerModelId:immutable.model_key,
    transport:'api',systemPromptEligible:true,
    displayName:immutable.display_name,capabilities:effectiveCapabilities,enabled:true,
    inputUsdPerMillion:immutable.input_price,outputUsdPerMillion:immutable.output_price,
    contextTokens:immutable.context_window,maxOutputTokens:immutable.max_output_tokens,version:model.version,
    isDefault:model.id===defaultId,
    recommendedForProvider:recommended.has(model.id),
    groupRestriction:model.enabledByGroupIds.length===resolved.groupIds.length?null
      :model.enabledByGroupIds.map(id=>names.get(id)??id).sort().join(', '),
    };
  });
}

const providerCredentialPutIdempotency=createDurableMutationIdempotency({database:db,audit,hmacKey:key('provider-credential-mutation-idempotency'),namespace:'admin-provider-credential-put',method:'PUT'});
const providerCredentialDeleteIdempotency=createDurableMutationIdempotency({database:db,audit,hmacKey:key('provider-credential-mutation-idempotency'),namespace:'admin-provider-credential-delete',method:'DELETE'});

async function execute(operation:string,request:RouteRequest):Promise<RouteResult> {
  const now=Date.now();
  if(operation==='deployment.get'){
    const rows=db.prepare<[],{brand_name:string|null;brand_icon_file_id:string|null;support_vendor_name:string|null;support_contact_email:string|null;support_contact_phone:string|null;support_contact_url:string|null;support_notes:string|null}>('SELECT brand_name,brand_icon_file_id,support_vendor_name,support_contact_email,support_contact_phone,support_contact_url,support_notes FROM tenant_settings ORDER BY tenant_id LIMIT 2').all();
    return{body:{...deploymentBrand(rows.length===1?rows[0]:undefined),canEmail:config.smtp!==null}};
  }
  if(operation==='deployment.support'){
    if(!request.tenant)return{status:401};
    const row=db.prepare<[string],{brand_name:string|null;brand_icon_file_id:string|null;support_vendor_name:string|null;support_contact_email:string|null;support_contact_phone:string|null;support_contact_url:string|null;support_notes:string|null}>('SELECT brand_name,brand_icon_file_id,support_vendor_name,support_contact_email,support_contact_phone,support_contact_url,support_notes FROM tenant_settings WHERE tenant_id=?').get(request.tenant.principal.tenantId);
    return{body:{support:deploymentSupport(row)},headers:{'Cache-Control':'private, max-age=60'}};
  }
  if(operation==='deployment.icon'){
    // Reachable without a session for the same reason as the branding above: it is the logo the
    // enterprise chose to put on its own sign-in page. Only the workspace's own uploaded bytes are
    // served, and the upload path has already restricted them to PNG, JPEG or WebP.
    const scope=request.tenant
      ?db.prepare<[string],{tenant_id:string;brand_icon_mime:string|null;brand_icon_sha256:string|null}>('SELECT tenant_id,brand_icon_mime,brand_icon_sha256 FROM tenant_settings WHERE tenant_id=?').all(request.tenant.principal.tenantId)
      :db.prepare<[],{tenant_id:string;brand_icon_mime:string|null;brand_icon_sha256:string|null}>('SELECT tenant_id,brand_icon_mime,brand_icon_sha256 FROM tenant_settings ORDER BY tenant_id LIMIT 2').all();
    const row=scope.length===1?scope[0]:undefined,tenantId=row?.tenant_id??'';
    if(!row?.brand_icon_mime||!row.brand_icon_sha256)return{status:404};const bytes=await deploymentBlobs.read(`${tenantId}/branding/${row.brand_icon_sha256}`);if(!bytes)return{status:404};return{body:bytes,headers:{'Content-Type':row.brand_icon_mime,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'}};
  }
  const input=body(request);
  if(operation==='admin.providers.setCredential'||operation==='admin.providers.clearCredential'){
    if(!request.tenant)return {status:401,body:{error:{code:'UNAUTHENTICATED',message:'Authentication required',requestId:request.requestId,retryable:false}}};
    const provider=request.params.providerId;
    if(!provider||!(PROVIDERS as readonly string[]).includes(provider))return {status:422,body:{error:{code:'VALIDATION_FAILED',message:'Unknown provider',requestId:request.requestId,retryable:false}}};
    const tenantId=request.tenant.principal.tenantId;
    if(operation==='admin.providers.setCredential'){
      return providerCredentialPutIdempotency.execute(operation,request,(tx,at)=>{
        if(typeof input.apiKey!=='string')return {status:422,body:{error:{code:'VALIDATION_FAILED',message:'apiKey is required',requestId:request.requestId,retryable:false}}};
        let baseUrl:string|null=null;try{baseUrl=input.baseUrl===undefined||input.baseUrl===null||input.baseUrl===''?null:validateProviderBaseUrl(String(input.baseUrl));}catch{return {status:422,body:{error:{code:'VALIDATION_FAILED',message:'baseUrl must be a public HTTPS URL',requestId:request.requestId,retryable:false}}};}
        const result=setTenantProviderCredential(db,{tenantId,provider:provider as Provider,secret:input.apiKey as string,key:providerCredentialKeys.get(config.providerCredentialKeyVersion)!,keyVersion:config.providerCredentialKeyVersion,baseUrl,now:at});
        const event=tx.append({tenantId,action:'admin.tenant_setting_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'provider',id:provider},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http'},metadata:{kind:'provider_credential_source',source:'byok'}});
        return{status:200,body:{provider,...result,auditEventId:event.id}};
      });
    }
    return providerCredentialDeleteIdempotency.execute(operation,request,(tx,at)=>{
      clearTenantProviderCredential(db,{tenantId,provider:provider as Provider,now:at});
      tx.append({tenantId,action:'admin.tenant_setting_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'provider',id:provider},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http'},metadata:{kind:'provider_credential_source',source:'disabled'}});
      return{status:204};
    });
  }
  if(operation==='chat.getRun'||operation==='chat.cancel'){
    const tenant=request.tenant;
    if(!tenant)return {status:401,body:{error:{code:'UNAUTHENTICATED',message:'Authentication required',requestId:request.requestId,retryable:false}}};
    const id=request.params.id??'';
    if(operation==='chat.getRun'){
      const run=await chat.getRun(tenant,id);
      return run?{body:{run}}:{status:404,body:{error:{code:'RESOURCE_NOT_FOUND',message:'Run not found',requestId:request.requestId,retryable:false}}};
    }
    const outcome=await chat.cancel(tenant,id);
    // A run that already finished is not an error to the caller -- the user pressed stop just as it
    // landed. Say what happened and let the client reconcile against the run it already has.
    if(outcome==='missing')return {status:404,body:{error:{code:'RESOURCE_NOT_FOUND',message:'Run not found',requestId:request.requestId,retryable:false}}};
    return {status:202,body:{runId:id,status:outcome==='accepted'?'cancelling':'terminal'}};
  }
  if(operation==='assistants.draftFromUrl')return assistantDraft.execute(operation,request);
  const identityResult=await identity.execute(operation,request);if(identityResult)return identityResult;
  const repositoryResult=await repositories(operation,request);if(repositoryResult)return repositoryResult;
  if(violationTriage.supports(operation))return violationTriage.execute(operation,request);
  if(auditRoutes.supports(operation))return auditRoutes.execute(operation,request);
  if(gateDecisions.supports(operation))return gateDecisions.execute(operation,request);
  if(myBudgets.supports(operation))return myBudgets.execute(operation,request);
  if(health.supports(operation))return health.execute(operation,request);
  if(files.supports(operation))return files.execute(operation,request);
  if(operation.startsWith('admin.')||operation.startsWith('budgets.')||operation.startsWith('gate.rules.')||operation==='gate.policies.list'||operation==='gate.test')return admin.execute(operation,request);
  return {status:501,body:{error:{code:'SERVICE_UNAVAILABLE',message:`Operation ${operation} is not implemented`,requestId:request.requestId,retryable:false}}};
}

// One constant, shared: the engine mints the warning token with this key and the confirmation
// endpoint verifies it with the same one. Two `key('gate-warning')` calls would work today and
// break silently the moment either label is edited.
const warningSecret=key('gate-warning');
const gate=new DefaultGateEngine({detectors:deterministicDetectors(),vault:new StatelessGateVault(),audit,warningSecret});
const providers=new ProviderRegistry({});
const tenantProviders=new TenantProviderRegistry({database:db,credentialKeys:{currentVersion:config.providerCredentialKeyVersion,keys:providerCredentialKeys}});
const assistantDraft=createAssistantDraftAdapter({database:db,audit,hmacKey:key('assistant-draft-from-url-idempotency'),draftFromUrl:input=>draftAssistantFromUrl({fetchText:safeFetchText,gate,resolvePolicy,providers,tenantProviders,db,now:()=>Date.now()},input)});
const approvalPayloadKey=key('approval-payload');
const chat=createGovernedChatApplication({database:db,gate,providers,tenantProviders,audit,approvalPayloadKey,multiModelResultKey:key('multi-model-result')});
export const approvalReleaseWorker=new ApprovalReleaseWorker({database:db,gate,providers,tenantProviders,audit,approvalPayloadKey});
const auditRoutes=createAuditRouteAdapter({database:db,cursorKey:key('audit-cursor'),ipHmacKey:key('ip'),idempotencyHmacKey:key('approval-decision-idempotency'),exportDirectory:`${config.uploadDir}/audit-exports`,audit,approvalReleaseAvailable:approvalReleaseWorker.available,approvalReleaseQueue:approvalReleaseWorker});
const violationTriage=createViolationTriageAdapter({database:db,audit,idempotencyHmacKey:key('violation-triage-idempotency'),approvalReleaseAvailable:approvalReleaseWorker.available});
approvalReleaseWorker.start();
if(config.nodeEnv==='production'&&chat.constructor.name!=='GovernedChatApplication')throw new Error('Refusing to boot production with prototype chat services');
// Resolve through the same chat policy path that minted the token. This makes any security-relevant
// effective-rule change invalidate a pending warning before the run can resume.
const confirmations:ConfirmRunDependencies={database:db,chat,audit,warningSecret,policyFingerprint:tenant=>chat.policyFingerprint(tenant)};
export const services:ApiRouteServices={execute,chat,confirmations};
