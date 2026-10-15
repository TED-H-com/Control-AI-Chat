import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { TenantId } from '../../shared/types.js';
import { forTenant } from '../../lib/db.js';
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, otpauthUri, recoveryCodeDigest, verifyTotp, type EncryptionKey } from '../../lib/identity/mfa.js';
import { dummyPasswordVerification, hashPassword, normalizeEmail, verifyPassword } from '../../lib/identity/password.js';
import { createSession, findRefreshSession, revokeSession, rotateRefresh } from '../../lib/identity/sessions.js';
import { IdentityError, type TenantRole } from '../../lib/identity/types.js';
import { fromStorageKey } from '../../shared/permissions.js';
import type { Locale } from '../../shared/api.js';
import { PRODUCT_NAME } from '../../shared/brand.js';
import type {Mailer,MailLogger} from '../../lib/email/mailer.js';
import {credentialMail} from '../../lib/email/credential-mail.js';
import {SELF_SERVICE_RESET_LINK_TTL_MS,consumeCredentialLinkInTransaction,credentialTokenShape,findUsableCredentialLink,issueCredentialLinkInTransaction} from '../../lib/identity/credential-links.js';

type Json = Record<string, unknown>;
export interface IdentityAuditInput {tenantId:TenantId;action:string;actorUserId:string|null;actorSessionId:string|null;requestId:string|null;targetId:string|null;clientIp:string|null;userAgent:string|null;metadata:Readonly<Record<string,unknown>>}
export interface IdentityAudit { append(input:IdentityAuditInput):void }
export interface IdentityServiceOptions {
 database:Database.Database;jwtSecret:string;encryptionKey:EncryptionKey;
 recoveryPepper:string;audit:IdentityAudit;now?:()=>number;
 appOrigin:string;mailer?:Mailer;logger?:MailLogger;
 scheduler?:(work:()=>void|Promise<void>)=>void;
}

const json=(request:RouteRequest):Json=>typeof request.body==='object'&&request.body!==null?request.body as Json:{};
const text=(value:unknown,name:string):string=>{if(typeof value!=='string'||!value.trim())throw new IdentityError('INVALID_REQUEST',`${name} is required`);return value.trim();};
const cookie=(name:string,value:string,maxAge?:number):string=>`__Host-${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax${maxAge===undefined?'':`; Max-Age=${maxAge}`}`;
const cookieValue=(request:RouteRequest,name:string):string|null=>{const header=request.headers.get('cookie');if(!header)return null;for(const part of header.split(';')){const [key,...rest]=part.trim().split('=');if(key===`__Host-${name}`)return decodeURIComponent(rest.join('='));}return null;};
const noStore={'Cache-Control':'no-store','Pragma':'no-cache'} as const;
const forgotAccepted={accepted:true} as const;
const expiredLink=()=>new IdentityError('CREDENTIAL_LINK_INVALID','This link is expired or has already been used');
const MFA_ENROLLMENT_TTL_MS=10*60_000,RECENT_MFA_MS=15*60_000,LOGIN_LOCK_MS=15*60_000,MAX_LOGIN_FAILURES=5;
interface MfaTicket {id:string;userId:string;tenantId:string;expiresAt:number}
const mfaTicket=(value:MfaTicket,secret:string):string=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return`${body}.${createHmac('sha256',secret).update(`mfa-challenge:${body}`).digest('base64url')}`;};
const verifyMfaTicket=(ticket:string,secret:string,at=Date.now()):MfaTicket=>{const [body,signature,...extra]=ticket.split('.');if(!body||!signature||extra.length)throw new IdentityError('MFA_INVALID','Invalid MFA challenge');const expected=createHmac('sha256',secret).update(`mfa-challenge:${body}`).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new IdentityError('MFA_INVALID','Invalid MFA challenge');let value:unknown;try{value=JSON.parse(Buffer.from(body,'base64url').toString())}catch{throw new IdentityError('MFA_INVALID','Invalid MFA challenge')}if(!value||typeof value!=='object')throw new IdentityError('MFA_INVALID','Invalid MFA challenge');const v=value as Record<string,unknown>;if(typeof v.id!=='string'||v.id.length!==36||typeof v.userId!=='string'||typeof v.tenantId!=='string'||typeof v.expiresAt!=='number'||v.expiresAt<=at)throw new IdentityError('MFA_INVALID','MFA challenge expired');return{id:v.id,userId:v.userId,tenantId:v.tenantId,expiresAt:v.expiresAt};};

interface UserRow {id:string;tenant_id:string;email:string;display_name:string;password_hash:string|null;status:string;email_verified_at:number|null;totp_secret_ciphertext:string|null;totp_enabled_at:number|null;failed_login_count:number;locked_until:number|null;locale:Locale;created_at:number;updated_at:number}
interface LoginRow extends UserRow {tenant_status:string}
interface MfaEnrollmentRow {secret_ciphertext:string;issuer:string;expires_at:number}
interface MeRow extends UserRow {tenant_name:string;tenant_slug:string;locale:Locale;density:'comfortable'|'compact';color_mode:'light'|'dark'|'system'}
interface SessionListRow {id:string;auth_method:string;created_at:number;last_seen_at:number;expires_at:number;revoked_at:number|null;user_agent:string|null}
export function createIdentityService(options:IdentityServiceOptions):{execute(operation:string,request:RouteRequest):Promise<RouteResult|null>} {
 const db=options.database,clock=options.now??Date.now,schedule=options.scheduler??((work:()=>void|Promise<void>)=>setImmediate(()=>void work()));
 const userById=db.prepare<[TenantId,string],UserRow>('SELECT * FROM users WHERE tenant_id=? AND id=?');
 const meById=db.prepare<[TenantId,string],MeRow>(`SELECT u.id,u.tenant_id,u.email,u.display_name,u.password_hash,u.status,u.email_verified_at,u.totp_secret_ciphertext,u.totp_enabled_at,u.created_at,u.updated_at,u.locale,u.density,u.color_mode,
   t.name tenant_name,t.slug tenant_slug
   FROM users u JOIN tenants t ON t.id=u.tenant_id
   WHERE u.tenant_id=? AND u.id=? AND u.deleted_at IS NULL`);
 const groupsForUser=db.prepare<[TenantId,string],{id:string;name:string}>('SELECT g.id,g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id AND g.tenant_id=gm.tenant_id WHERE gm.tenant_id=? AND gm.user_id=? AND g.deleted_at IS NULL ORDER BY g.name,g.id');
 const rolesForUser=db.prepare<[TenantId,string],{key:TenantRole}>('SELECT DISTINCT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY r.key');
 const permissionsForUser=db.prepare<[TenantId,string],{permission_key:string}>('SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY rp.permission_key');
 const roleForUser=db.prepare<[TenantId,string],{key:TenantRole}>("SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? AND r.key IN ('owner','admin','compliance','member') ORDER BY CASE r.key WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'compliance' THEN 2 ELSE 3 END LIMIT 1");
 const recentMfaSession=db.prepare(`WITH tenant_scope(id,now_ms,cutoff_ms) AS (VALUES (?,?,?)) SELECT id FROM sessions WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND user_id=? AND auth_method='mfa' AND mfa_verified_at_ms IS NOT NULL AND mfa_verified_at_ms>=(SELECT cutoff_ms FROM tenant_scope) AND revoked_at IS NULL AND expires_at>(SELECT now_ms FROM tenant_scope)`) as Database.Statement<[TenantId,...unknown[]],{id:string}>;
 const requestClientIp=(request:RouteRequest):string|null=>{const value=request.headers.get('X-Gateway-Client-IP');return value==='unknown'?null:value;};
 const httpAudit=(request:RouteRequest,tenantId:TenantId,action:string,actorUserId:string|null,targetId:string|null,metadata:Readonly<Record<string,unknown>>={},actorSessionId:string|null=null)=>options.audit.append({
  tenantId,action,actorUserId,actorSessionId,requestId:request.requestId,targetId,
  clientIp:requestClientIp(request),userAgent:request.headers.get('User-Agent'),metadata,
 });
 const hasRecentMfa=(tenantId:TenantId,userId:string,sessionId:string,at:number):boolean=>Boolean(forTenant({tenantId}).get(recentMfaSession,at,at-RECENT_MFA_MS,sessionId,userId));
 const tenant=(request:RouteRequest)=>{if(!request.tenant)throw new IdentityError('UNAUTHENTICATED','Authentication required');return request.tenant;};
 async function execute(operation:string,request:RouteRequest):Promise<RouteResult|null>{
  const input=json(request),at=clock();
  if(operation==='auth.passwordForgot'){
   if(typeof input.email!=='string'||!input.email.trim())return{status:202,headers:noStore,body:forgotAccepted};
   const submittedEmail=input.email,submittedSlug=typeof input.tenantSlug==='string'&&input.tenantSlug.trim()?input.tenantSlug.trim():null;
   schedule(async()=>{
    try{
     const email=normalizeEmail(submittedEmail);
     const projection=`SELECT u.id,u.tenant_id,u.email,u.locale,u.status user_status,t.status tenant_status,t.name tenant_name,COALESCE(s.timezone,'UTC') timezone FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN tenant_settings s ON s.tenant_id=t.id`;
     type ForgotRow={id:string;tenant_id:TenantId;email:string;locale:Locale;user_status:string;tenant_status:string;tenant_name:string;timezone:string};
     let found:ForgotRow|undefined;
     if(submittedSlug)found=db.prepare<[string,string],ForgotRow>(`${projection} WHERE t.slug=? AND u.email=? AND u.deleted_at IS NULL`).get(submittedSlug,email);
     else {const matches=db.prepare<[string],ForgotRow>(`${projection} WHERE u.email=? AND u.deleted_at IS NULL ORDER BY u.tenant_id LIMIT 2`).all(email);if(matches.length===1)found=matches[0]}
     if(!found)return;
     const eligible=found.user_status==='active'&&found.tenant_status==='active';
     httpAudit(request,found.tenant_id,'auth.password_reset_requested',found.id,found.id,{eligible});
     if(!options.mailer||!eligible)return;
     const link=db.transaction(()=>{
      const recent=db.prepare<[TenantId,string,number],{id:string}>(`SELECT id FROM credential_links WHERE tenant_id=? AND user_id=? AND purpose='reset' AND issued_by_user_id IS NULL AND issued_by_service IS NULL AND created_at>? ORDER BY created_at DESC LIMIT 1`).get(found!.tenant_id,found!.id,at-5*60_000);
      return recent?null:issueCredentialLinkInTransaction(db,{tenantId:found!.tenant_id,userId:found!.id,purpose:'reset',issuedByUserId:null,lifetimeMs:SELF_SERVICE_RESET_LINK_TTL_MS,appOrigin:options.appOrigin,now:at});
     }).immediate();
     if(link)try{await options.mailer.send(credentialMail({to:found.email,locale:found.locale,workspaceName:found.tenant_name,purpose:'reset',url:link.url,expiresAt:link.expiresAt,timeZone:found.timezone}))}catch{options.logger?.warn('Password reset email delivery failed',{tenantId:found.tenant_id,userId:found.id,purpose:'reset'})}
    }catch{options.logger?.warn('Password reset request processing failed',{requestId:request.requestId})}
   });
   return{status:202,headers:noStore,body:forgotAccepted};
  }
  if(operation==='auth.passwordReset'){
   const token=input.token;if(!credentialTokenShape(token))throw expiredLink();
   const link=findUsableCredentialLink(db,token,at);if(!link)throw expiredLink();
   const passwordHash=await hashPassword(text(input.password,'password'));
   const completed=db.transaction(()=>{
    const result=consumeCredentialLinkInTransaction(db,link,passwordHash,at);if(!result)return null;
    httpAudit(request,link.tenant_id,link.purpose==='setup'?'auth.password_setup_completed':'auth.password_reset_completed',link.user_id,link.user_id,{purpose:link.purpose,sessionsRevoked:result.sessionsRevoked});
    return result;
   }).immediate();
   if(!completed)throw expiredLink();
   return{headers:noStore,body:{changed:true,purpose:link.purpose}};
  }
  if(operation==='auth.login'){
   if(typeof input.mfaTicket==='string'){
    const challenge=verifyMfaTicket(input.mfaTicket,options.jwtSecret,at),found=userById.get(challenge.tenantId as TenantId,challenge.userId),code=text(input.code,'code');
    if(!found||found.status!=='active'||found.email_verified_at===null||found.totp_enabled_at===null||!found.totp_secret_ciphertext||(found.locked_until!==null&&found.locked_until>at))throw new IdentityError('MFA_INVALID','Invalid MFA challenge');
    const scope=forTenant({tenantId:found.tenant_id as TenantId});
    if(!scope.get(db.prepare<[TenantId,string,string,number],{id:string}>('SELECT id FROM mfa_login_challenges WHERE tenant_id=? AND user_id=? AND id=? AND expires_at>?'),found.id,challenge.id,at))throw new IdentityError('MFA_INVALID','Invalid MFA challenge');
    const [keyId,ciphertext]=found.totp_secret_ciphertext.split(':');if(keyId!==options.encryptionKey.id||!ciphertext)throw new IdentityError('ENCRYPTION_KEY_MISSING','MFA encryption key unavailable');
    const totpValid=verifyTotp(decryptSecret({keyId,ciphertext},[options.encryptionKey]),code,at),recoveryDigest=totpValid?null:recoveryCodeDigest(code,options.recoveryPepper);
    const recoveryValid=recoveryDigest!==null&&Boolean(scope.get(db.prepare<[TenantId,string,string],{code_digest:string}>('SELECT code_digest FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=? AND code_digest=?'),found.id,recoveryDigest));
    if(!totpValid&&!recoveryValid){
     db.transaction(()=>{
      const failure=scope.get(db.prepare(`WITH tenant_scope(id,lock_at,now_ms) AS (VALUES (?,?,?))
       UPDATE users SET failed_login_count=failed_login_count+1,
        locked_until=CASE WHEN failed_login_count+1>=${MAX_LOGIN_FAILURES} THEN (SELECT lock_at FROM tenant_scope) ELSE locked_until END,
        updated_at=(SELECT now_ms FROM tenant_scope)
       WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='active' AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM mfa_login_challenges WHERE tenant_id=(SELECT id FROM tenant_scope) AND user_id=? AND id=? AND expires_at>(SELECT now_ms FROM tenant_scope))
       RETURNING failed_login_count`) as Database.Statement<[TenantId,...unknown[]],{failed_login_count:number}>,at+LOGIN_LOCK_MS,at,found.id,found.id,challenge.id);
      if(!failure)throw new IdentityError('MFA_INVALID','Invalid MFA challenge');
      if(failure.failed_login_count>=MAX_LOGIN_FAILURES)scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?'),found.id);
      httpAudit(request,found.tenant_id as TenantId,'auth.login_failed',found.id,found.id,{email:found.email,reason:'bad_mfa'});
     }).immediate();
     throw new IdentityError('MFA_INVALID','Invalid MFA code');
    }
    const assignedRole=roleForUser.get(found.tenant_id as TenantId,found.id)?.key;
    if(!assignedRole)throw new IdentityError('MFA_INVALID','Invalid MFA challenge');
    const created=db.transaction(()=>{
     if(scope.run(db.prepare<[TenantId,string,string,number]>('DELETE FROM mfa_login_challenges WHERE tenant_id=? AND user_id=? AND id=? AND expires_at>?'),found.id,challenge.id,at).changes!==1)throw new IdentityError('MFA_INVALID','Invalid MFA challenge');
     if(recoveryDigest&&scope.run(db.prepare<[TenantId,string,string]>('DELETE FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=? AND code_digest=?'),found.id,recoveryDigest).changes!==1)throw new IdentityError('MFA_INVALID','Invalid MFA code');
     const session=createSession(db,{userId:found.id,sessionId:randomUUID(),tenantId:found.tenant_id,role:assignedRole,authMethods:recoveryDigest?['password','recovery_code']:['password'],mfa:true,sessionVersion:1,authMethod:'mfa',jwtSecret:options.jwtSecret,now:at});
     db.prepare('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=?,updated_at=? WHERE tenant_id=? AND id=?').run(at,at,found.tenant_id,found.id);
     httpAudit(request,found.tenant_id as TenantId,'auth.login_succeeded',found.id,session.id,{mfaRequired:false});
     return session;
    }).immediate();
    return {body:{user:{id:found.id,email:found.email,displayName:found.display_name},mfaRequired:false,expiresAt:created.accessExpiresAt},headers:{...noStore,'Set-Cookie':[cookie('session',created.accessToken,600),cookie('refresh',created.refreshToken,2_592_000)].join(', ')}};
   }
   const email=normalizeEmail(text(input.email,'email')),password=text(input.password,'password');
   const slug=typeof input.tenantSlug==='string'&&input.tenantSlug.trim()?input.tenantSlug.trim():null;
   const projection=`SELECT u.id,u.tenant_id,u.email,u.display_name,u.password_hash,u.status,u.email_verified_at,u.totp_secret_ciphertext,u.totp_enabled_at,u.locale,u.created_at,u.updated_at,u.failed_login_count,u.locked_until,t.status tenant_status FROM users u JOIN tenants t ON t.id=u.tenant_id`;
   let found:LoginRow|undefined;
   if(slug)found=db.prepare<[string,string],LoginRow>(`${projection} WHERE t.slug=? AND u.email=? AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL`).get(slug,email);
   else {
    const matches=db.prepare<[string],LoginRow>(`${projection} WHERE u.email=? AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL ORDER BY u.tenant_id LIMIT 2`).all(email);
    if(matches.length===1)found=matches[0];
   }
   const passwordValid=found?.password_hash?await verifyPassword(password,found.password_hash):(await dummyPasswordVerification(password),false),locked=found?.locked_until!==null&&found?.locked_until!==undefined&&found.locked_until>at;
   if(!found||found.tenant_status!=='active'||found.status!=='active'||locked||!passwordValid){
    // Nothing was writing a failed login. `identity.login_failed` is registered and is even the one
    // action the audit pipeline marks async-safe so it cannot block the request path — it simply had
    // no emitter, so "show me failed sign-in attempts", the first question of any security review,
    // returned an empty result. Resolve the tenant from the slug so an attempt against an address
    // that does not exist still lands in the targeted tenant's chain instead of vanishing.
    const tenantId=found?.tenant_id??(slug?db.prepare<[string],{id:string}>('SELECT id FROM tenants WHERE slug=?').get(slug)?.id:undefined);
    if(found&&found.tenant_status==='active'&&found.status==='active'&&!locked)db.prepare(`UPDATE users SET failed_login_count=failed_login_count+1,
      locked_until=CASE WHEN failed_login_count+1>=${MAX_LOGIN_FAILURES} THEN ? ELSE locked_until END,updated_at=? WHERE tenant_id=? AND id=?`).run(at+LOGIN_LOCK_MS,at,found.tenant_id,found.id);
    if(tenantId)await httpAudit(request,tenantId as TenantId,'auth.login_failed',found?.id??null,found?.id??null,{email,reason:!found?'unknown_user':found.tenant_status!=='active'?'inactive_tenant':found.status!=='active'?'inactive_user':locked?'locked':'bad_password'});
    throw new IdentityError('INVALID_CREDENTIALS','Invalid email or password');
   }
   if(found.email_verified_at===null)throw new IdentityError('EMAIL_NOT_VERIFIED','Email verification is required');
   const assignedRole=roleForUser.get(found.tenant_id as TenantId,found.id)?.key;
   if(!assignedRole)throw new IdentityError('INVALID_CREDENTIALS','Invalid email or password');
   if(found.totp_enabled_at!==null){
    const challenge={id:randomUUID(),userId:found.id,tenantId:found.tenant_id,expiresAt:at+300_000},scope=forTenant({tenantId:found.tenant_id as TenantId});
    db.transaction(()=>{
     // Keep one live credential per account. Besides bounding durable state, replacing the prior row
     // means a ticket copied from an earlier password submission stops working as soon as the user
     // starts a new challenge.
     scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?'),found.id);
     scope.run(db.prepare<[TenantId,string,string,number,number]>('INSERT INTO mfa_login_challenges(tenant_id,user_id,id,created_at,expires_at) VALUES(?,?,?,?,?)'),found.id,challenge.id,at,challenge.expiresAt);
     httpAudit(request,found.tenant_id as TenantId,'auth.mfa_challenge_issued',found.id,null,{});
    }).immediate();
    return{body:{user:{id:found.id,email:found.email,displayName:found.display_name},mfaRequired:true,mfaTicket:mfaTicket(challenge,options.jwtSecret)},headers:noStore};
   }
   const created=createSession(db,{userId:found.id,sessionId:randomUUID(),tenantId:found.tenant_id,role:assignedRole,authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:options.jwtSecret,now:at});
   db.prepare('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=?,updated_at=? WHERE tenant_id=? AND id=?').run(at,at,found.tenant_id,found.id);
   await httpAudit(request,found.tenant_id as TenantId,'auth.login_succeeded',found.id,created.id,{mfaRequired:found.totp_enabled_at!==null});
   return {body:{user:{id:found.id,email:found.email,displayName:found.display_name},mfaRequired:found.totp_enabled_at!==null,expiresAt:created.accessExpiresAt},headers:{...noStore,'Set-Cookie':[cookie('session',created.accessToken,600),cookie('refresh',created.refreshToken,2_592_000)].join(', ')}};
  }
  // Access tokens live 600 seconds and `rotateRefresh` had no caller, so every session silently
  // died ten minutes in with a valid refresh cookie sitting
  // unused in the browser. Deliberately unaudited on success: a refresh every ten minutes per user
  // is roughly 144 events a day each, and burying the audit log is its own kind of breaking it.
  if(operation==='auth.refresh'){
   const presented=cookieValue(request,'refresh');
   const expired=()=>new IdentityError('SESSION_EXPIRED','Your session has expired. Please sign in again.');
   if(!presented)throw expired();
   const session=findRefreshSession(db,presented,at);
   if(!session)throw expired();
   // Re-read the user every time. A deprovisioned or suspended account must lose the ability to mint
   // new access tokens at the next refresh, not at the end of the 30-day absolute session lifetime.
   const found=userById.get(session.tenantId,session.userId);
   if(!found||found.status!=='active'){revokeSession(db,session.tenantId,session.id,'user_inactive');throw expired();}
   const assignedRole=roleForUser.get(session.tenantId,found.id)?.key;
   if(!assignedRole){revokeSession(db,session.tenantId,session.id,'role_removed');throw expired();}
   const rotated=rotateRefresh(db,session.tenantId,presented,{userId:found.id,role:assignedRole,authMethods:['password'],mfa:true,sessionVersion:1,jwtSecret:options.jwtSecret,now:at});
   // Cookie lifetime tracks the session's own absolute expiry rather than a fixed 30 days.
   const remaining=Math.max(1,Math.floor((session.expiresAt-at)/1000));
   return {body:{expiresAt:rotated.accessExpiresAt},headers:{...noStore,'Set-Cookie':[cookie('session',rotated.accessToken,600),cookie('refresh',rotated.refreshToken,remaining)].join(', ')}};
  }
  // Clearing only the access cookie left the refresh token in the browser. The row is revoked so it
  // buys nothing, but a credential that outlives the sign-out that was meant to destroy it is a
  // finding waiting to happen on the first enterprise security review.
  if(operation==='auth.logout'){const t=tenant(request);revokeSession(db,t.principal.tenantId,t.principal.sessionId,'logout');await httpAudit(request,t.principal.tenantId,'auth.logout',t.principal.userId,t.principal.sessionId,{});return{status:204,headers:{'Set-Cookie':[cookie('session','',0),cookie('refresh','',0)].join(', ')}};}
  if(operation==='auth.me'){
   const t=tenant(request),scope=forTenant({tenantId:t.principal.tenantId}),row=scope.get(meById,t.principal.userId);
   if(!row)throw new IdentityError('NOT_FOUND','User not found');
   return{body:{
    user:{id:row.id,email:row.email,displayName:row.display_name,avatarUrl:null},
    tenant:{id:row.tenant_id,name:row.tenant_name,slug:row.tenant_slug},
    membership:{id:t.principal.membershipId,roles:scope.all(rolesForUser,row.id).map(item=>item.key),groups:scope.all(groupsForUser,row.id),permissions:scope.all(permissionsForUser,row.id).map(item=>fromStorageKey(item.permission_key))},
    preferences:{density:row.density,colorMode:row.color_mode,locale:row.locale},mfa:{enabled:row.totp_enabled_at!==null},sessionId:t.principal.sessionId,
   }};
  }
  if(operation==='identity.updateMe'){const t=tenant(request),name=text(input.displayName,'displayName').normalize('NFC').slice(0,200);forTenant({tenantId:t.principal.tenantId}).run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET display_name=?,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?') as Database.Statement<[TenantId,...unknown[]]>,name,at,t.principal.userId);return{body:{id:t.principal.userId,displayName:name}};}
  if(operation==='identity.sessions'){const t=tenant(request),rows=forTenant({tenantId:t.principal.tenantId}).all(db.prepare<[TenantId,string],SessionListRow>('SELECT id,auth_method,created_at,last_seen_at,expires_at,revoked_at,user_agent FROM sessions WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC'),t.principal.userId);return{body:{items:rows.map(r=>({...r,current:r.id===t.principal.sessionId}))}};}
  if(operation==='identity.revokeSession'){const t=tenant(request),id=text(request.params.id,'id');const owned=forTenant({tenantId:t.principal.tenantId}).get(db.prepare<[TenantId,string,string],{id:string}>('SELECT id FROM sessions WHERE tenant_id=? AND id=? AND user_id=?'),id,t.principal.userId);if(!owned)throw new IdentityError('NOT_FOUND','Session not found');revokeSession(db,t.principal.tenantId,id,'user_revoked');await httpAudit(request,t.principal.tenantId,'auth.session_revoked',t.principal.userId,id,{});return{status:204};}
  if(operation==='identity.revokeOthers'){const t=tenant(request);const result=forTenant({tenantId:t.principal.tenantId}).run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND user_id=? AND id<>? AND revoked_at IS NULL') as Database.Statement<[TenantId,...unknown[]]>,at,'revoke_others',t.principal.userId,t.principal.sessionId);await httpAudit(request,t.principal.tenantId,'auth.sessions_revoked',t.principal.userId,null,{count:result.changes});return{body:{revoked:result.changes}};}
  if(operation==='identity.mfaSetup'){
   const t=tenant(request),scope=forTenant({tenantId:t.principal.tenantId});
   const issuer=(scope.get(db.prepare<[TenantId],{brand_name:string|null}>('SELECT brand_name FROM tenant_settings WHERE tenant_id=?'))?.brand_name?.trim()||PRODUCT_NAME).slice(0,200),secret=generateTotpSecret(),encrypted=encryptSecret(secret,options.encryptionKey);
   const u=db.transaction(()=>{
    const found=scope.get(userById,t.principal.userId);if(!found)throw new IdentityError('NOT_FOUND','User not found');
    if(found.totp_enabled_at!==null&&!hasRecentMfa(t.principal.tenantId,t.principal.userId,t.principal.sessionId,at))throw new IdentityError('MFA_REQUIRED','Recent MFA verification is required to replace an authenticator');
    scope.run(db.prepare('INSERT INTO mfa_enrollments(tenant_id,user_id,secret_ciphertext,issuer,created_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,issuer=excluded.issuer,created_at=excluded.created_at,expires_at=excluded.expires_at') as Database.Statement<[TenantId,...unknown[]]>,t.principal.userId,`${encrypted.keyId}:${encrypted.ciphertext}`,issuer,at,at+MFA_ENROLLMENT_TTL_MS);
    return found;
   }).immediate();
   return{status:201,headers:noStore,body:{secret,otpauthUri:otpauthUri(secret,u.email,issuer)}};
  }
  if(operation==='identity.mfaVerify'){
   const t=tenant(request),scope=forTenant({tenantId:t.principal.tenantId}),code=text(input.code,'code');
   const codes=db.transaction(()=>{
    const enrollment=scope.get(db.prepare<[TenantId,string],MfaEnrollmentRow>('SELECT secret_ciphertext,issuer,expires_at FROM mfa_enrollments WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    if(!enrollment)throw new IdentityError('MFA_INVALID','MFA enrollment not found or expired');
    if(enrollment.expires_at<=at){scope.run(db.prepare<[TenantId,string,number]>('DELETE FROM mfa_enrollments WHERE tenant_id=? AND user_id=? AND expires_at<=?'),t.principal.userId,at);return null;}
    const u=scope.get(userById,t.principal.userId);if(!u)throw new IdentityError('MFA_INVALID','MFA enrollment user no longer exists');
    if(u.totp_enabled_at!==null&&!hasRecentMfa(t.principal.tenantId,t.principal.userId,t.principal.sessionId,at))throw new IdentityError('MFA_REQUIRED','Recent MFA verification is required to replace an authenticator');
    const [keyId,ciphertext]=enrollment.secret_ciphertext.split(':');if(keyId!==options.encryptionKey.id||!ciphertext)throw new IdentityError('ENCRYPTION_KEY_MISSING','MFA encryption key unavailable');
    if(!verifyTotp(decryptSecret({keyId,ciphertext},[options.encryptionKey]),code,at))throw new IdentityError('MFA_INVALID','Invalid MFA code');
    const generated=generateRecoveryCodes(),digests=generated.map(value=>recoveryCodeDigest(value,options.recoveryPepper));
    if(scope.run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET totp_secret_ciphertext=?,totp_enabled_at=?,totp_issuer_used=?,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?') as Database.Statement<[TenantId,...unknown[]]>,enrollment.secret_ciphertext,at,enrollment.issuer,at,t.principal.userId).changes!==1)throw new IdentityError('MFA_INVALID','MFA enrollment user no longer exists');
    scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    const insert=db.prepare<[TenantId,string,string,number]>('INSERT INTO mfa_recovery_codes(tenant_id,user_id,code_digest,created_at) VALUES(?,?,?,?)');for(const digest of digests)scope.run(insert,t.principal.userId,digest,at);
    scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_enrollments WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    httpAudit(request,t.principal.tenantId,'auth.mfa_enabled',t.principal.userId,t.principal.userId,{});
    return generated;
   }).immediate();
   if(!codes)throw new IdentityError('MFA_INVALID','MFA enrollment not found or expired');
   return{headers:noStore,body:{recoveryCodes:codes,enabledAt:at}};
  }
  if(operation==='identity.mfaDelete'){
   const t=tenant(request),scope=forTenant({tenantId:t.principal.tenantId});
   db.transaction(()=>{
    if(!hasRecentMfa(t.principal.tenantId,t.principal.userId,t.principal.sessionId,at))throw new IdentityError('MFA_REQUIRED','Recent MFA verification is required');
    if(scope.run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET totp_secret_ciphertext=NULL,totp_enabled_at=NULL,totp_issuer_used=NULL,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?') as Database.Statement<[TenantId,...unknown[]]>,at,t.principal.userId).changes!==1)throw new IdentityError('NOT_FOUND','User not found');
    scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_enrollments WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    scope.run(db.prepare<[TenantId,string]>('DELETE FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?'),t.principal.userId);
    httpAudit(request,t.principal.tenantId,'auth.mfa_disabled',t.principal.userId,t.principal.userId,{});
   }).immediate();
   return{status:204};
  }
  if(operation==='auth.passwordChange'){
   const t=tenant(request),u=forTenant({tenantId:t.principal.tenantId}).get(userById,t.principal.userId);
   if(!u?.password_hash||!await verifyPassword(text(input.currentPassword,'currentPassword'),u.password_hash))throw new IdentityError('INVALID_CREDENTIALS','Current password is invalid');
   const hash=await hashPassword(text(input.newPassword,'newPassword'));
   const revoked=db.transaction(()=>{
    const scope=forTenant({tenantId:t.principal.tenantId});
    scope.run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET password_hash=?,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?') as Database.Statement<[TenantId,...unknown[]]>,hash,at,t.principal.userId);
    const result=scope.run(db.prepare('WITH tenant_scope(id) AS (VALUES (?)) UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND user_id=? AND id<>? AND revoked_at IS NULL') as Database.Statement<[TenantId,...unknown[]]>,at,'password_changed',t.principal.userId,t.principal.sessionId);
    httpAudit(request,t.principal.tenantId,'auth.password_changed',t.principal.userId,t.principal.userId,{sessionsRevoked:result.changes},t.principal.sessionId);
    return result.changes;
   }).immediate();
   return{body:{changed:true,sessionsRevoked:revoked}};
  }
  return null;
 }
 return {execute};
}
