import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_NAME } from '../../shared/brand.js';
import Database from 'better-sqlite3';
import { encryptSecret, generateTotpSecret, recoveryCodeDigest, totp } from '../../lib/identity/mfa.js';
import { hashPassword } from '../../lib/identity/password.js';
import { authorizeAccess, createSession } from '../../lib/identity/sessions.js';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { createIdentityService, type IdentityAuditInput } from './service.js';
import type { RouteRequest } from '../../routes/types.js';
import type { TenantContext } from '../../lib/http/index.js';
import type { TenantId } from '../../shared/types.js';
import {ADMIN_RESET_LINK_TTL_MS,SETUP_LINK_TTL_MS,issueCredentialLinkInTransaction} from '../../lib/identity/credential-links.js';

const request=(body:unknown,headers:Headers=new Headers(),params:Readonly<Record<string,string>>={}):RouteRequest=>({tenant:null,requestId:'test',params,query:{},headers,body,rawBody:null});
function fixture():Database.Database{
 const db=new Database(':memory:');
 db.pragma('foreign_keys=ON');runMigrations(db);
 return db;
}
const seedTenant=(db:Database.Database,id:string,slug:string,at=Date.now())=>db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(id,slug,slug,at,at);
function assignRole(db:Database.Database,tenantId:string,userId:string,key:'owner'|'admin'|'compliance'|'member',at=Date.now()):void{
 const id=crypto.randomUUID();
 db.prepare('INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,?,?,1,?)').run(id,tenantId,key,key,at);
 db.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(tenantId,userId,id,at);
}
const service=(db:Database.Database)=>createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',audit:{append(){}}});
function auditedService(db:Database.Database){
 const productAudit=createAuditService({database:db,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:Date.now()})});
 return createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',audit:{append(input){
  productAudit.append({tenantId:input.tenantId,action:'identity.password_changed',actor:{type:'user',id:input.actorUserId,sessionId:input.actorSessionId,ip:null,userAgent:null,authMethod:null},target:{type:'user',id:input.targetId},outcome:'success',context:{requestId:input.requestId??'missing',traceId:null,source:'http'},metadata:{identityAction:input.action,...input.metadata}});
 }}});
}
function authenticatedRequest(tenantId:TenantId,userId:string,sessionId:string,requestId:string,body:unknown):RouteRequest{
 const tenant:TenantContext={principal:{tenantId,userId,membershipId:userId,sessionId,roles:['member'],permissions:new Set()},db:forTenant({tenantId}),requestId,now:new Date()};
 return{tenant,requestId,params:{},query:{},headers:new Headers(),body,rawBody:null};
}

test('/auth/me returns the persisted density preference',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333';
 seedTenant(db,tenant,'acme');
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,density,created_at,updated_at) VALUES(?,?,?,'A',?,'active',1,'compact',1,1)").run(user,tenant,'a@acme.test',await hashPassword('correct horse battery staple'));
 assignRole(db,tenant,user,'member');
 const result=await service(db).execute('auth.me',authenticatedRequest(tenant,user,session,'me-density',{}));
 assert.equal((result?.body as {preferences:{density:string}}).preferences.density,'compact');
 db.close();
});

test('MFA enrollment stays pending until verified, remains tenant-isolated, and carries HTTP attribution',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',otherTenant='55555555-5555-4555-8555-555555555555' as TenantId,otherUser='66666666-6666-4666-8666-666666666666';
 const at=Date.now(),password='current password',nextPassword='new password',clientIp='198.51.100.42',userAgent='Identity service attribution test/1.0',requestId='identity-attribution',otherRecoveryCode='OTHER-RECOV';let now=at;
 seedTenant(db,tenant,'acme',at);
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword(password),'active',at,at,at);
 assignRole(db,tenant,user,'owner',at);
 seedTenant(db,otherTenant,'other',at);
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(otherUser,otherTenant,'other@other.test','Other',null,'invited',null,at,at);
 db.prepare('UPDATE users SET totp_secret_ciphertext=?,totp_enabled_at=?,totp_issuer_used=?,updated_at=? WHERE tenant_id=? AND id=?').run('other:active',at-1,'Other active issuer',at-1,otherTenant,otherUser);
 db.prepare('INSERT INTO mfa_enrollments(tenant_id,user_id,secret_ciphertext,issuer,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(otherTenant,otherUser,'other:sealed','Other issuer',at,at+600_000);
 db.prepare('INSERT INTO mfa_recovery_codes(tenant_id,user_id,code_digest,created_at) VALUES(?,?,?,?)').run(otherTenant,otherUser,recoveryCodeDigest(otherRecoveryCode,'pepper'),at);
 const otherMfaState=()=>({user:db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used,updated_at FROM users WHERE tenant_id=? AND id=?').get(otherTenant,otherUser),enrollment:db.prepare('SELECT secret_ciphertext,issuer,created_at,expires_at FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').get(otherTenant,otherUser),codes:db.prepare('SELECT code_digest,created_at FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').all(otherTenant,otherUser)}),otherBefore=otherMfaState();
 let sessionId=createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now:at}).id;const passwordSessionId=sessionId;
 const inputs:IdentityAuditInput[]=[],headers=new Headers({'X-Gateway-Client-IP':clientIp,'User-Agent':userAgent});
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>now,audit:{append(input){inputs.push(input)}}});
 const publicRequest=(body:unknown):RouteRequest=>({...request(body,headers),requestId});
 const privateRequest=(body:unknown,params:Readonly<Record<string,string>>={}):RouteRequest=>({...authenticatedRequest(tenant,user,sessionId,requestId,body),headers,params});

 await identity.execute('auth.login',publicRequest({email:'a@acme.test',password}));
 await assert.rejects(identity.execute('auth.login',publicRequest({tenantSlug:'acme',email:'a@acme.test',password:'wrong password'})),/Invalid email or password/u);
 await identity.execute('auth.passwordChange',privateRequest({currentPassword:password,newPassword:nextPassword}));
 const expiredSetup=await identity.execute('identity.mfaSetup',privateRequest({})),expiredSecret=(expiredSetup?.body as {secret:string}).secret;
 const pendingLogin=await identity.execute('auth.login',publicRequest({email:'a@acme.test',password:nextPassword}));
 assert.equal((pendingLogin?.body as {mfaRequired:boolean}).mfaRequired,false,'a pending enrollment must not lock the next login behind an unverified secret');
 now=at+600_001;
 await assert.rejects(identity.execute('identity.mfaVerify',privateRequest({code:totp(expiredSecret,now)})),/not found or expired/u);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0,'an expired pending secret is rejected and removed');
 const setup=await identity.execute('identity.mfaSetup',privateRequest({})),secret=(setup?.body as {secret:string}).secret;
 assert.equal(setup?.headers?.['Cache-Control'],'no-store');assert.equal(setup?.headers?.Pragma,'no-cache');
 const beforeVerify=await identity.execute('auth.login',publicRequest({email:'a@acme.test',password:nextPassword}));
 assert.equal((beforeVerify?.body as {mfaRequired:boolean}).mfaRequired,false,'a pending enrollment must not lock the next login behind an unverified secret');
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{totp_secret_ciphertext:null,totp_enabled_at:null});
 const verified=await identity.execute('identity.mfaVerify',privateRequest({code:totp(secret,now)})),recoveryCodes=(verified?.body as {recoveryCodes:string[]}).recoveryCodes;
 assert.equal(verified?.headers?.['Cache-Control'],'no-store');assert.equal(verified?.headers?.Pragma,'no-cache');
 assert.equal(recoveryCodes.length,10);
 assert.deepEqual(db.prepare('SELECT totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{totp_enabled_at:now,totp_issuer_used:PRODUCT_NAME});
 assert.equal(db.prepare('SELECT count(*) FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),10);
 assert.deepEqual(otherMfaState(),otherBefore);
 await assert.rejects(identity.execute('identity.mfaSetup',privateRequest({})),/Recent MFA verification is required to replace an authenticator/u,'an old password session cannot start an authenticator takeover');
 assert.equal(db.prepare('SELECT count(*) FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0);
 const supersededChallenge=await identity.execute('auth.login',publicRequest({email:'a@acme.test',password:nextPassword})),supersededTicket=(supersededChallenge?.body as {mfaTicket:string}).mfaTicket;
 const challenge=await identity.execute('auth.login',publicRequest({email:'a@acme.test',password:nextPassword})),mfaTicket=(challenge?.body as {mfaRequired:boolean;mfaTicket:string}).mfaTicket;
 assert.equal((challenge?.body as {mfaRequired:boolean}).mfaRequired,true);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),1,'only the latest password challenge remains live');
 await assert.rejects(identity.execute('auth.login',publicRequest({mfaTicket:supersededTicket,code:recoveryCodes[0]})),/Invalid MFA challenge/u,'a newer password challenge invalidates the older signed ticket');
 await assert.rejects(identity.execute('identity.mfaDelete',privateRequest({})),/Recent MFA verification is required/u);
 const [encodedTicket,ticketSignature]=mfaTicket.split('.'),ticketClaims=JSON.parse(Buffer.from(encodedTicket!,'base64url').toString()) as Record<string,unknown>;
 const crossTenantTicket=`${Buffer.from(JSON.stringify({...ticketClaims,tenantId:otherTenant})).toString('base64url')}.${ticketSignature}`;
 await assert.rejects(identity.execute('auth.login',publicRequest({mfaTicket:crossTenantTicket,code:recoveryCodes[0]})),/Invalid MFA challenge/u);
 await assert.rejects(identity.execute('auth.login',publicRequest({mfaTicket,code:otherRecoveryCode})),/Invalid MFA code/u,'another tenant recovery digest cannot satisfy this challenge');
 const normalizedRecovery=` ${recoveryCodes[0]!.toLowerCase().replace('-', ' - ')} `;
 const recoveryLogin=await identity.execute('auth.login',publicRequest({mfaTicket,code:normalizedRecovery}));
 assert.equal((recoveryLogin?.body as {mfaRequired:boolean}).mfaRequired,false);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),9);
 await assert.rejects(identity.execute('auth.login',publicRequest({mfaTicket,code:recoveryCodes[1]})),/Invalid MFA challenge/u,'a successfully consumed MFA ticket cannot create another session');
 sessionId=db.prepare("SELECT id FROM sessions WHERE tenant_id=? AND user_id=? AND auth_method='mfa'").pluck().get(tenant,user) as string;const recentMfaSessionId=sessionId;
 const secondChallenge=await identity.execute('auth.login',publicRequest({email:'a@acme.test',password:nextPassword})),secondTicket=(secondChallenge?.body as {mfaTicket:string}).mfaTicket;
 await assert.rejects(identity.execute('auth.login',publicRequest({mfaTicket:secondTicket,code:recoveryCodes[0]})),/Invalid MFA code/u,'a consumed recovery code stays unusable with a fresh ticket');
 await identity.execute('auth.login',publicRequest({mfaTicket:secondTicket,code:recoveryCodes[1]}));
 assert.equal(db.prepare('SELECT count(*) FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),8);
 const activeBeforeRotation=db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),rotation=await identity.execute('identity.mfaSetup',privateRequest({})),rotationSecret=(rotation?.body as {secret:string}).secret;
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),activeBeforeRotation,'a pending rotation must leave the working authenticator active');
 sessionId=passwordSessionId;
 await assert.rejects(identity.execute('identity.mfaVerify',privateRequest({code:totp(rotationSecret,now)})),/Recent MFA verification is required to replace an authenticator/u,'an old password session cannot finish an authenticator takeover');
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),activeBeforeRotation);
 sessionId=recentMfaSessionId;
 await identity.execute('identity.mfaDelete',privateRequest({}));
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{totp_secret_ciphertext:null,totp_enabled_at:null,totp_issuer_used:null});
 assert.equal(db.prepare('SELECT count(*) FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0);
 assert.deepEqual(otherMfaState(),otherBefore);
 const targetSessionId=createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now}).id;
 await identity.execute('identity.revokeSession',privateRequest(undefined,{id:targetSessionId}));
 createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now});
 await identity.execute('identity.revokeOthers',privateRequest({}));
 await identity.execute('auth.logout',privateRequest({}));

 assert.deepEqual(inputs.map(input=>input.action),['auth.login_succeeded','auth.login_failed','auth.password_changed','auth.login_succeeded','auth.login_succeeded','auth.mfa_enabled','auth.mfa_challenge_issued','auth.mfa_challenge_issued','auth.login_failed','auth.login_succeeded','auth.mfa_challenge_issued','auth.login_failed','auth.login_succeeded','auth.mfa_disabled','auth.session_revoked','auth.sessions_revoked','auth.logout']);
 assert.deepEqual(inputs.find(input=>input.action==='auth.mfa_enabled')?.metadata,{});
 assert.doesNotMatch(JSON.stringify(inputs),new RegExp(recoveryCodeDigest(recoveryCodes[0]!,'pepper'),'u'),'recovery-code digests are authentication data, not audit metadata');
 for(const input of inputs)assert.deepEqual({clientIp:input.clientIp,userAgent:input.userAgent,requestId:input.requestId},{clientIp,userAgent,requestId},`${input.action} lost its HTTP attribution`);
 db.close();
});

test('MFA state, challenges, and one-time credentials roll back when their audit append fails',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',at=Date.now(),password='correct horse battery staple';
 seedTenant(db,tenant,'acme',at);
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword(password),'active',at,at,at);
 assignRole(db,tenant,user,'owner',at);
 let sessionId=createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now:at}).id,failAction:string|null='auth.mfa_enabled';
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,audit:{append(input){if(input.action===failAction)throw new Error('audit unavailable')}}});
 const privateRequest=(body:unknown):RouteRequest=>authenticatedRequest(tenant,user,sessionId,'mfa-transaction',body);
 const setup=await identity.execute('identity.mfaSetup',privateRequest({})),secret=(setup?.body as {secret:string}).secret;

 await assert.rejects(identity.execute('identity.mfaVerify',privateRequest({code:totp(secret,at)})),/audit unavailable/u);
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{totp_secret_ciphertext:null,totp_enabled_at:null});
 assert.equal(db.prepare('SELECT count(*) FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),1);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0);

 failAction=null;await identity.execute('identity.mfaVerify',privateRequest({code:totp(secret,at)}));
 failAction='auth.mfa_challenge_issued';
 await assert.rejects(identity.execute('auth.login',request({email:'a@acme.test',password})),/audit unavailable/u);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0);
 failAction=null;
 const challenge=await identity.execute('auth.login',request({email:'a@acme.test',password})),ticket=(challenge?.body as {mfaTicket:string}).mfaTicket;
 const sessionsBefore=db.prepare('SELECT count(*) FROM sessions WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user);
 failAction='auth.login_failed';
 await assert.rejects(identity.execute('auth.login',request({mfaTicket:ticket,code:'definitely-wrong'})),/audit unavailable/u);
 assert.deepEqual(db.prepare('SELECT failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{failed_login_count:0,locked_until:null},'an unavailable audit sink rolls back the failed-MFA counter');
 assert.equal(db.prepare('SELECT count(*) FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),1);
 failAction='auth.login_succeeded';
 await assert.rejects(identity.execute('auth.login',request({mfaTicket:ticket,code:totp(secret,at)})),/audit unavailable/u);
 assert.equal(db.prepare('SELECT count(*) FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),1);
 assert.equal(db.prepare('SELECT count(*) FROM sessions WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),sessionsBefore);
 failAction=null;await identity.execute('auth.login',request({mfaTicket:ticket,code:totp(secret,at)}));

 sessionId=db.prepare("SELECT id FROM sessions WHERE tenant_id=? AND user_id=? AND auth_method='mfa'").pluck().get(tenant,user) as string;
 const activeBefore=db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),codesBefore=db.prepare('SELECT code_digest FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=? ORDER BY code_digest').all(tenant,user);
 failAction='auth.mfa_disabled';
 await assert.rejects(identity.execute('identity.mfaDelete',privateRequest({})),/audit unavailable/u);
 assert.deepEqual(db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at,totp_issuer_used FROM users WHERE tenant_id=? AND id=?').get(tenant,user),activeBefore);
 assert.deepEqual(db.prepare('SELECT code_digest FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=? ORDER BY code_digest').all(tenant,user),codesBefore);
 failAction=null;await identity.execute('identity.mfaDelete',privateRequest({}));
 db.close();
});

test('password change stores the caller identity, request context and session-revocation count',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',requestId='password-change-request';
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('current password'),'active',1,1,1);
 assignRole(db,tenant,user,'member');
 const current=createSession(db,{userId:user,sessionId:'33333333-3333-4333-8333-333333333333',tenantId:tenant,role:'member',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now:Date.now()}),sessionId=current.id;
 const other=createSession(db,{userId:user,sessionId:'44444444-4444-4444-8444-444444444444',tenantId:tenant,role:'member',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now:Date.now()});
 const changed=await auditedService(db).execute('auth.passwordChange',authenticatedRequest(tenant,user,sessionId,requestId,{currentPassword:'current password',newPassword:'new password'}));
 assert.deepEqual(changed?.body,{changed:true,sessionsRevoked:1});
 assert.deepEqual(db.prepare('SELECT id,revoked_at IS NOT NULL revoked FROM sessions WHERE tenant_id=? AND user_id=? ORDER BY revoked').all(tenant,user),[{id:sessionId,revoked:0},{id:other.id,revoked:1}]);
 const changedAt=db.prepare('SELECT updated_at FROM users WHERE tenant_id=? AND id=?').pluck().get(tenant,user) as number;
 assert.ok(changedAt>1,'password change must advance updated_at');
 const login=await service(db).execute('auth.login',request({email:'a@acme.test',password:'new password'}));
 assert.match(login?.headers?.['Set-Cookie']??'',/__Host-session=/u,'new password must authenticate');
 await assert.rejects(service(db).execute('auth.login',request({email:'a@acme.test',password:'current password'})),/Invalid email or password/u,'old password must not authenticate');
 const row=db.prepare("SELECT action,actor_id,actor_session_id,request_id,metadata_json FROM audit_events WHERE action='identity.password_changed'").get() as {action:string;actor_id:string;actor_session_id:string;request_id:string;metadata_json:string}|undefined;
 assert.deepEqual(row&&{...row,metadata:JSON.parse(row.metadata_json),metadata_json:undefined},{action:'identity.password_changed',actor_id:user,actor_session_id:sessionId,request_id:requestId,metadata_json:undefined,metadata:{identityAction:'auth.password_changed',sessionsRevoked:1}});
 db.close();
});

test('wrong current password stores no password-changed row',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',sessionId='33333333-3333-4333-8333-333333333333';
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('current password'),'active',1,1,1);
 const identity=auditedService(db),makeRequest=(currentPassword:string)=>authenticatedRequest(tenant,user,sessionId,`request-${currentPassword}`,{currentPassword,newPassword:'new password'});
 await identity.execute('auth.passwordChange',makeRequest('current password'));
 await assert.rejects(identity.execute('auth.passwordChange',makeRequest('wrong password')),/Current password is invalid/u);
 assert.equal(db.prepare("SELECT count(*) FROM audit_events WHERE action='identity.password_changed'").pluck().get(),1);
 db.close();
});

test('email-first password login persists a session without requiring a tenant slug',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('correct horse battery staple'),'active',1,1,1);
 assignRole(db,tenant,user,'member');
 const result=await service(db).execute('auth.login',request({email:'A@ACME.TEST',password:'correct horse battery staple'}));
 assert.match(result?.headers?.['Set-Cookie']??'',/__Host-session=/);
 assert.match(result?.headers?.['Set-Cookie']??'',/__Host-refresh=/);
 assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as {n:number}).n,1);
 const access=/__Host-session=([^;]+)/.exec(result?.headers?.['Set-Cookie']??'')?.[1];assert.ok(access);
 assert.equal(authorizeAccess(db,decodeURIComponent(access),'j'.repeat(32)).role,'member');
 const refresh=/__Host-refresh=([^;,]+)/.exec(result?.headers?.['Set-Cookie']??'')?.[1];assert.ok(refresh);
 const refreshed=await service(db).execute('auth.refresh',request({},new Headers({cookie:`__Host-refresh=${refresh}`})));
 const refreshedAccess=/__Host-session=([^;]+)/.exec(refreshed?.headers?.['Set-Cookie']??'')?.[1];assert.ok(refreshedAccess);
 assert.equal(authorizeAccess(db,decodeURIComponent(refreshedAccess),'j'.repeat(32)).role,'member','refresh must preserve the database role');
});

test('an ambiguous email fails closed while tenantSlug remains a compatibility escape hatch',async()=>{
 const db=fixture(),first='11111111-1111-4111-8111-111111111111',second='33333333-3333-4333-8333-333333333333',firstUser='22222222-2222-4222-8222-222222222222',secondUser='44444444-4444-4444-8444-444444444444',password='correct horse battery staple',hash=await hashPassword(password);
 seedTenant(db,first,'acme');seedTenant(db,second,'other');
 for(const [tenantId,userId] of [[first,firstUser],[second,secondUser]] as const){
  db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'A',?,'active',1,1,1)").run(userId,tenantId,'a@shared.test',hash);
  assignRole(db,tenantId,userId,'member');
 }
 await assert.rejects(service(db).execute('auth.login',request({email:'a@shared.test',password})),/Invalid email or password/u);
 assert.equal((db.prepare('SELECT count(*) FROM sessions').pluck().get() as number),0);
 const selected=await service(db).execute('auth.login',request({tenantSlug:'other',email:'a@shared.test',password}));
 assert.match(selected?.headers?.['Set-Cookie']??'',/__Host-session=/u);
 assert.equal((db.prepare('SELECT tenant_id FROM sessions').pluck().get() as string),second);
 db.close();
});

test('consumed, expired, superseded, and suspended credential links have one generic failure and change nothing',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,at=1_800_000_000_000;
 seedTenant(db,tenant,'acme',at);const roleId=crypto.randomUUID();db.prepare("INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'member','member',1,?)").run(roleId,tenant,at);
 const addUser=(label:string,status:'active'|'invited')=>{const id=crypto.randomUUID();db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,tenant,`${label}@acme.test`,label,status==='active'?`old-${label}`:null,status,status==='active'?at:null,at,at);db.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(tenant,id,roleId,at);return id};
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,audit:{append(){}}}),makeRequest=(token:string)=>request({token,password:'a sufficiently long password'}),generic='This link is expired or has already been used',dead=(error:unknown)=>error instanceof Error&&error.message===generic&&'code'in error&&error.code==='CREDENTIAL_LINK_INVALID';
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest('not-a-token')),dead);
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest(Buffer.alloc(32,9).toString('base64url'))),dead);
 const consumedUser=addUser('consumed','active'),consumed=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:consumedUser,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-1});
 await identity.execute('auth.passwordReset',makeRequest(consumed.token));const consumedBefore=db.prepare('SELECT password_hash,status,email_verified_at FROM users WHERE tenant_id=? AND id=?').get(tenant,consumedUser);
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest(consumed.token)),dead);assert.deepEqual(db.prepare('SELECT password_hash,status,email_verified_at FROM users WHERE tenant_id=? AND id=?').get(tenant,consumedUser),consumedBefore);
 const expiredUser=addUser('expired','active'),expired=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:expiredUser,purpose:'reset',issuedByUserId:null,lifetimeMs:1,appOrigin:'https://app.test',now:at-2}),expiredBefore=db.prepare('SELECT password_hash,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,expiredUser);
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest(expired.token)),dead);assert.deepEqual(db.prepare('SELECT password_hash,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,expiredUser),expiredBefore);
 const supersededUser=addUser('superseded','active'),first=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:supersededUser,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-2});issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:supersededUser,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-1});const supersededBefore=db.prepare('SELECT password_hash,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,supersededUser);
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest(first.token)),dead);assert.deepEqual(db.prepare('SELECT password_hash,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,supersededUser),supersededBefore);
 const suspendedUser=addUser('suspended','active'),suspended=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:suspendedUser,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-1});db.prepare("UPDATE users SET status='suspended' WHERE tenant_id=? AND id=?").run(tenant,suspendedUser);const suspendedBefore=db.prepare('SELECT password_hash,status,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,suspendedUser);
 await assert.rejects(identity.execute('auth.passwordReset',makeRequest(suspended.token)),dead);assert.deepEqual(db.prepare('SELECT password_hash,status,failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,suspendedUser),suspendedBefore);
 db.close();
});

test('two concurrent submissions consume one credential link exactly once',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',at=1_800_000_000_000;
 seedTenant(db,tenant,'acme',at);db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'Active','old-hash','active',?,?,?)").run(user,tenant,'parallel@acme.test',at,at,at);assignRole(db,tenant,user,'member',at);
 const link=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:user,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-1}),actions:string[]=[];
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,audit:{append(input){actions.push(input.action)}}}),submission=()=>identity.execute('auth.passwordReset',request({token:link.token,password:'a sufficiently long password'}));
 const results=await Promise.allSettled([submission(),submission()]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason instanceof Error&&result.reason.message==='This link is expired or has already been used').length,1);
 assert.equal(db.prepare('SELECT count(*) FROM credential_links WHERE tenant_id=? AND user_id=? AND consumed_at IS NOT NULL').pluck().get(tenant,user),1);assert.deepEqual(actions,['auth.password_reset_completed']);
 db.close();
});

test('password reset revokes every session, clears lockout, preserves TOTP, and still challenges for MFA',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',at=1_800_000_000_000,secret=generateTotpSecret(),encrypted=encryptSecret(secret,{id:'test',key:Buffer.alloc(32,1)});
 seedTenant(db,tenant,'acme',at);db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,totp_secret_ciphertext,totp_enabled_at,totp_issuer_used,failed_login_count,locked_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(user,tenant,'mfa@acme.test','MFA',await hashPassword('old password value'),'active',at,`${encrypted.keyId}:${encrypted.ciphertext}`,at,'Test',4,at+60_000,at,at);assignRole(db,tenant,user,'member',at);
 createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'member',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32),now:at-1});createSession(db,{userId:user,sessionId:crypto.randomUUID(),tenantId:tenant,role:'member',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'mfa',jwtSecret:'j'.repeat(32),now:at-1});
 const link=issueCredentialLinkInTransaction(db,{tenantId:tenant,userId:user,purpose:'reset',issuedByUserId:null,lifetimeMs:ADMIN_RESET_LINK_TTL_MS,appOrigin:'https://app.test',now:at-1}),actions:string[]=[];
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,audit:{append(input){actions.push(input.action)}}});
 assert.deepEqual((await identity.execute('auth.passwordReset',request({token:link.token,password:'new secure password value'})))?.body,{changed:true,purpose:'reset'});
 assert.deepEqual(db.prepare('SELECT failed_login_count,locked_until,totp_secret_ciphertext,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{failed_login_count:0,locked_until:null,totp_secret_ciphertext:`${encrypted.keyId}:${encrypted.ciphertext}`,totp_enabled_at:at});
 assert.equal(db.prepare('SELECT count(*) FROM sessions WHERE tenant_id=? AND user_id=? AND revoked_at IS NOT NULL').pluck().get(tenant,user),2);
 const login=await identity.execute('auth.login',request({tenantSlug:'acme',email:'mfa@acme.test',password:'new secure password value'}));assert.equal((login?.body as {mfaRequired:boolean}).mfaRequired,true);assert.equal(typeof (login?.body as {mfaTicket:string}).mfaTicket,'string');assert.ok(actions.includes('auth.password_reset_completed'));
 db.close();
});

test('forgot-password responses are uniform, mail only the unique eligible user, and throttle for five minutes',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,otherTenant='33333333-3333-4333-8333-333333333333' as TenantId,at=1_800_000_000_000,unique=crypto.randomUUID(),ambiguousA=crypto.randomUUID(),ambiguousB=crypto.randomUUID();
 seedTenant(db,tenant,'acme',at);seedTenant(db,otherTenant,'other',at);const add=(tenantId:TenantId,id:string,email:string)=>db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?,?)").run(id,tenantId,email,at,at,at);
 add(tenant,unique,'unique@acme.test');add(tenant,ambiguousA,'ambiguous@example.test');add(otherTenant,ambiguousB,'ambiguous@example.test');
 const scheduled:Array<()=>void|Promise<void>>=[],run=async()=>{const work=scheduled.shift();assert.ok(work);await work()};
 const messages:unknown[]=[],actions:string[]=[],warnings:unknown[]=[];const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,scheduler:work=>scheduled.push(work),mailer:{async send(message){messages.push(message)}},logger:{warn(message,details){warnings.push({message,details})}},audit:{append(input){actions.push(input.action)}}});
 const forgot=(body:unknown)=>identity.execute('auth.passwordForgot',request(body));const existing=await forgot({email:'unique@acme.test'}),missing=await forgot({email:'missing@acme.test'}),ambiguous=await forgot({email:'ambiguous@example.test'}),again=await forgot({email:'unique@acme.test'});
 for(const result of [missing,ambiguous,again])assert.deepEqual(result,existing);assert.equal(actions.length,0);assert.equal(messages.length,0);assert.equal(db.prepare('SELECT count(*) FROM credential_links').pluck().get(),0);while(scheduled.length)await run();
 assert.equal(messages.length,1);assert.equal(db.prepare("SELECT count(*) FROM credential_links WHERE tenant_id=? AND user_id=? AND purpose='reset'").pluck().get(tenant,unique),1);assert.deepEqual(actions,['auth.password_reset_requested','auth.password_reset_requested']);assert.deepEqual(warnings,[]);
 let failedMessage='',failureWarning:unknown;const failedWork:Array<()=>void|Promise<void>>=[];const throwing=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at+301_000,scheduler:work=>failedWork.push(work),mailer:{async send(message){failedMessage=message.text;throw new Error('delivery failed')}},logger:{warn(message,details){failureWarning={message,details}}},audit:{append(){}}});await throwing.execute('auth.passwordForgot',request({email:'unique@acme.test'}));await failedWork[0]!();const failedToken=new URL(failedMessage.match(/https?:\/\/\S+#\S+/u)![0]).hash.slice(1);assert.doesNotMatch(JSON.stringify(failureWarning),new RegExp(failedToken,'u'));assert.doesNotMatch(JSON.stringify(failureWarning),/unique@acme\.test/u);
 const noSmtpWork:Array<()=>void|Promise<void>>=[];const withoutSmtp=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at+602_000,scheduler:work=>noSmtpWork.push(work),audit:{append(){}}});await withoutSmtp.execute('auth.passwordForgot',request({email:'unique@acme.test'}));await noSmtpWork[0]!();assert.equal(db.prepare("SELECT count(*) FROM credential_links WHERE tenant_id=? AND user_id=?").pluck().get(tenant,unique),2,'SMTP-disabled forgot must create no link');
 db.close();
});

test('forgot-password defers lookup, audit, issue, and mail while retaining the request clock',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user=crypto.randomUUID(),at=1_800_000_000_000;let now=at;
 seedTenant(db,tenant,'acme',at);
 const scheduled:Array<()=>void|Promise<void>>=[],actions:string[]=[],messages:unknown[]=[];
 const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>now,scheduler:work=>scheduled.push(work),mailer:{async send(message){messages.push(message)}},audit:{append(input){actions.push(input.action)}}});
 const result=await identity.execute('auth.passwordForgot',request({email:'deferred@acme.test',tenantSlug:'acme'}));
 assert.equal(result?.status,202);assert.equal(scheduled.length,1);assert.deepEqual(actions,[]);assert.deepEqual(messages,[]);assert.equal(db.prepare('SELECT count(*) FROM credential_links').pluck().get(),0);
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'Deferred','hash','active',?,?,?)").run(user,tenant,'deferred@acme.test',at,at,at);
 now=at+60_000;await scheduled[0]!();
 assert.deepEqual(actions,['auth.password_reset_requested']);assert.equal(messages.length,1);assert.deepEqual(db.prepare('SELECT created_at FROM credential_links WHERE tenant_id=? AND user_id=?').get(tenant,user),{created_at:at});
 db.close();
});

test('forgot-password does not issue or mail for ineligible users or a suspended workspace',async()=>{
 const db=fixture(),at=1_800_000_000_000,tenant='11111111-1111-4111-8111-111111111111' as TenantId,suspendedTenant='33333333-3333-4333-8333-333333333333' as TenantId;
 seedTenant(db,tenant,'acme',at);seedTenant(db,suspendedTenant,'paused',at);db.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(suspendedTenant);
 const cases=[['invited',tenant,'invited'],['suspended',tenant,'suspended'],['deprovisioned',tenant,'deprovisioned'],['workspace',suspendedTenant,'active']] as const;
 for(const [label,tenantId,status] of cases)db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),tenantId,`${label}@example.test`,label,status==='invited'?null:'hash',status,status==='invited'?null:at,at,at);
 const scheduled:Array<()=>void|Promise<void>>=[],messages:unknown[]=[];const identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>at,scheduler:work=>scheduled.push(work),mailer:{async send(message){messages.push(message)}},audit:{append(){}}});
 let baseline:unknown;
 for(const [label,,] of cases){const response=await identity.execute('auth.passwordForgot',request({email:`${label}@example.test`}));baseline??=response;assert.deepEqual(response,baseline)}
 while(scheduled.length)await scheduled.shift()!();
 assert.equal(db.prepare('SELECT count(*) FROM credential_links').pluck().get(),0);assert.deepEqual(messages,[]);
 db.close();
});

test('password failures lock the account and success after expiry resets the counter',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',password='correct horse battery staple';
 seedTenant(db,tenant,'acme');
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'A',?,'active',1,1,1)").run(user,tenant,'locked@acme.test',await hashPassword(password));assignRole(db,tenant,user,'member');
 const identity=service(db);
 for(let attempt=0;attempt<5;attempt++)await assert.rejects(identity.execute('auth.login',request({email:'locked@acme.test',password:'definitely incorrect password'})),/Invalid email or password/u);
 const locked=db.prepare('SELECT failed_login_count,locked_until FROM users WHERE id=?').get(user) as {failed_login_count:number;locked_until:number|null};
 assert.equal(locked.failed_login_count,5);assert.ok((locked.locked_until??0)>Date.now());
 await assert.rejects(identity.execute('auth.login',request({email:'locked@acme.test',password})),/Invalid email or password/u);
 db.prepare('UPDATE users SET locked_until=0 WHERE id=?').run(user);
 await identity.execute('auth.login',request({email:'locked@acme.test',password}));
 assert.deepEqual(db.prepare('SELECT failed_login_count,locked_until FROM users WHERE id=?').get(user),{failed_login_count:0,locked_until:null});
 db.close();
});

test('password login fails closed when the user has no tenant role',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('correct horse battery staple'),'active',1,1,1);
 await assert.rejects(service(db).execute('auth.login',request({tenantSlug:'acme',email:'a@acme.test',password:'correct horse battery staple'})),/Invalid email or password/);
 assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as {n:number}).n,0);
 db.close();
});

test('password login with MFA enabled returns only a challenge and creates no session',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,totp_secret_ciphertext,totp_enabled_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('correct horse battery staple'),'active',1,'test:enrolled',Date.now(),Date.now(),Date.now());
 assignRole(db,tenant,user,'compliance');
 const result=await service(db).execute('auth.login',request({tenantSlug:'acme',email:'a@acme.test',password:'correct horse battery staple'}));
 const body=result?.body as {mfaRequired:boolean;mfaTicket:string};
 assert.equal(body.mfaRequired,true);
 assert.equal(typeof body.mfaTicket,'string');
 assert.equal(result?.headers?.['Set-Cookie'],undefined);
 assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as {n:number}).n,0);
});

test('valid TOTP challenge creates the MFA-complete session',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',key={id:'test',key:Buffer.alloc(32,1)},secret=generateTotpSecret(),encrypted=encryptSecret(secret,key);
 seedTenant(db,tenant,'acme');
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,totp_secret_ciphertext,totp_enabled_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword('correct horse battery staple'),'active',Date.now(),`${encrypted.keyId}:${encrypted.ciphertext}`,Date.now(),Date.now(),Date.now());
 assignRole(db,tenant,user,'admin');
 const identity=service(db),challenge=await identity.execute('auth.login',request({tenantSlug:'acme',email:'a@acme.test',password:'correct horse battery staple'})),mfaTicket=(challenge?.body as {mfaTicket:string}).mfaTicket;
 const result=await identity.execute('auth.login',request({mfaTicket,code:totp(secret)}));
 assert.equal((result?.body as {mfaRequired:boolean}).mfaRequired,false);
 assert.match(result?.headers?.['Set-Cookie']??'',/__Host-session=/);
 assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as {n:number}).n,1);
 const access=/__Host-session=([^;]+)/.exec(result?.headers?.['Set-Cookie']??'')?.[1];assert.ok(access);
 assert.equal(authorizeAccess(db,decodeURIComponent(access),'j'.repeat(32)).role,'admin');
});

test('invalid MFA codes retain the password-failure budget across renewed tickets and lock the account',async()=>{
 const db=fixture(),tenant='11111111-1111-4111-8111-111111111111' as TenantId,user='22222222-2222-4222-8222-222222222222',key={id:'test',key:Buffer.alloc(32,1)},secret=generateTotpSecret(),encrypted=encryptSecret(secret,key),password='correct horse battery staple',at=1_800_000_000_000;let now=at;
 seedTenant(db,tenant,'acme',at);
 db.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,totp_secret_ciphertext,totp_enabled_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(user,tenant,'a@acme.test','A',await hashPassword(password),'active',at,`${encrypted.keyId}:${encrypted.ciphertext}`,at,at,at);
 assignRole(db,tenant,user,'member',at);
 const audits:IdentityAuditInput[]=[],identity=createIdentityService({database:db,jwtSecret:'j'.repeat(32),encryptionKey:key,recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>now,audit:{append(input){audits.push(input)}}});
 const issue=async()=>((await identity.execute('auth.login',request({tenantSlug:'acme',email:'a@acme.test',password})))?.body as {mfaTicket:string}).mfaTicket;
 const firstTicket=await issue();
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(identity.execute('auth.login',request({mfaTicket:firstTicket,code:`wrong-recovery-${attempt}`})),/Invalid MFA code/u);
 const secondTicket=await issue();
 await assert.rejects(identity.execute('auth.login',request({mfaTicket:firstTicket,code:totp(secret,now)})),/Invalid MFA challenge/u,'renewing a challenge must not leave the previous ticket usable');
 for(let attempt=2;attempt<5;attempt++)await assert.rejects(identity.execute('auth.login',request({mfaTicket:secondTicket,code:`wrong-recovery-${attempt}`})),/Invalid MFA code/u);

 assert.deepEqual(db.prepare('SELECT failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{failed_login_count:5,locked_until:at+15*60_000});
 assert.equal(db.prepare('SELECT count(*) FROM mfa_login_challenges WHERE tenant_id=? AND user_id=?').pluck().get(tenant,user),0,'locking the account invalidates every outstanding MFA ticket');
 await assert.rejects(identity.execute('auth.login',request({mfaTicket:secondTicket,code:totp(secret,now)})),/Invalid MFA challenge/u);
 const failures=audits.filter(input=>input.action==='auth.login_failed');assert.equal(failures.length,5);
 for(const input of failures)assert.deepEqual(input.metadata,{email:'a@acme.test',reason:'bad_mfa'});
 assert.doesNotMatch(JSON.stringify(failures),/wrong-recovery/u,'submitted MFA credentials must not enter the audit trail');

 now=at+15*60_000+1;
 const recoveredTicket=await issue();
 await identity.execute('auth.login',request({mfaTicket:recoveredTicket,code:totp(secret,now)}));
 assert.deepEqual(db.prepare('SELECT failed_login_count,locked_until FROM users WHERE tenant_id=? AND id=?').get(tenant,user),{failed_login_count:0,locked_until:null});
 db.close();
});
