import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { provisionTestTenant } from '../../test/tenant-fixture.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { AuditStore } from '../../lib/audit/audit-store.js';
import { authorizeAccess } from '../../lib/identity/sessions.js';
import { createIdentityService } from './service.js';
import type { RouteRequest } from '../../routes/types.js';

/**
 * Access tokens last 600 seconds. `rotateRefresh` was written and unit-tested and then never called
 * from anywhere, so `auth.refresh` answered 501 and every session in production — including every
 * browser session went dead ten minutes in while a perfectly good
 * refresh cookie sat unused in the browser. These tests run the real path.
 */
const SECRET='j'.repeat(32);
// Session expiry checks use the real clock, so this cannot be a fixed calendar date. Pinned to
// 2026-08-09T16:00Z, every test in this file passed briefly after it was written and failed later.
// What makes the test reproducible is its seed; `now` only
// chooses the timeline the seeded history is laid out on, and nothing here asserts on that timeline.
const NOW=Date.now();
const request=(cookies:string):RouteRequest=>({tenant:null,requestId:'test',params:{},query:{},headers:new Headers(cookies?{cookie:cookies}:{}),body:{},rawBody:null});
const auditStore=(db:Database.Database):AuditStore=>new AuditStore({database:db,ipHmacKey:Buffer.alloc(32,1),
  transcriptKey:()=>Buffer.alloc(32,2),
  retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});

function signedIn(){
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db);
  const provisioned=provisionTestTenant(db,{email:'alex@prospect.example',name:'Northstar Systems',now:NOW,passwordHash:bcrypt.hashSync('correct horse battery staple',4)});
  const audited:{action:string;metadata:Readonly<Record<string,unknown>>}[]=[];
  const service=createIdentityService({database:db,jwtSecret:SECRET,
    encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',
    audit:{append(input){audited.push({action:input.action,metadata:input.metadata})}}});
  return {db,service,audited,tenantId:provisioned.tenantId,ownerUserId:provisioned.ownerUserId};
}
const cookieOf=(headers:Record<string,string>|undefined,name:string):string=>{
  const match=new RegExp(`__Host-${name}=([^;]*)`).exec(headers?.['Set-Cookie']??'');
  assert.ok(match,`expected a ${name} cookie`);return decodeURIComponent(match[1]!);
};
const maxAgeOf=(headers:Record<string,string>|undefined,name:string):number=>{
  const match=new RegExp(`__Host-${name}=[^;]*;[^,]*?Max-Age=(\\d+)`).exec(headers?.['Set-Cookie']??'');
  assert.ok(match,`expected a Max-Age on ${name}`);return Number(match[1]);
};
async function open(){
  const context=signedIn();
  const result=await context.service.execute('auth.login',{...request(''),body:{email:'alex@prospect.example',password:'correct horse battery staple'}});
  return {...context,refresh:cookieOf(result?.headers,'refresh'),access:cookieOf(result?.headers,'session')};
}

test('a refresh cookie mints a fresh access token for the same session',async()=>{
  const {db,service,access,refresh,ownerUserId}=await open();
  const before=authorizeAccess(db,access,SECRET);
  const result=await service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`));
  const renewed=cookieOf(result?.headers,'session');
  const after=authorizeAccess(db,renewed,SECRET);
  assert.equal(after.sub,ownerUserId);
  assert.equal(after.sid,before.sid,'refresh must extend the existing session, not fork a new one');
  assert.notEqual(renewed,access,'a refresh that returns the same token has refreshed nothing');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {n:number}).n,1);
});

test('the refresh token is rotated and the spent one is refused',async()=>{
  const {service,refresh}=await open();
  const result=await service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`));
  const rotated=cookieOf(result?.headers,'refresh');
  assert.notEqual(rotated,refresh,'a refresh token that survives its own use is a replayable credential');
  await assert.rejects(()=>service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`)),
    /expired/i,'the superseded refresh token must not work a second time');
  const again=await service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(rotated)}`));
  assert.ok(cookieOf(again?.headers,'session'),'the rotated token must itself be usable');
});

test('the refresh cookie tracks the session lifetime',async()=>{
  const {service,refresh}=await open();
  const result=await service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`));
  const remaining=maxAgeOf(result?.headers,'refresh');
  assert.ok(remaining<=2_592_000,`expected at most the session's 30 days, got ${remaining}s`);
  assert.ok(remaining>2_591_000,`expected nearly the full remaining lifetime, got ${remaining}s`);
});

test('a suspended user cannot refresh, and the session is revoked on the spot',async()=>{
  const {db,service,refresh,ownerUserId,tenantId}=await open();
  db.prepare('UPDATE users SET status=? WHERE id=?').run('suspended',ownerUserId);
  await assert.rejects(()=>service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`)),
    /expired/i,'deprovisioning must take effect at the next refresh, not at the end of the absolute session lifetime');
  const row=db.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=?').get(tenantId) as {revoked_at:number|null;revoke_reason:string|null};
  assert.ok(row.revoked_at!==null,'the session must be revoked, not merely refused this once');
  assert.equal(row.revoke_reason,'user_inactive');
});

test('a missing, unknown or revoked refresh cookie is refused identically',async()=>{
  const {db,service,refresh,tenantId}=await open();
  await assert.rejects(()=>service.execute('auth.refresh',request('')),/expired/i);
  await assert.rejects(()=>service.execute('auth.refresh',request('__Host-refresh=not-a-real-token')),/expired/i);
  db.prepare('UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=?').run(NOW,'logout',tenantId);
  await assert.rejects(()=>service.execute('auth.refresh',request(`__Host-refresh=${encodeURIComponent(refresh)}`)),/expired/i);
});

test('signing out clears the refresh cookie as well as the access cookie',async()=>{
  const {db,service,ownerUserId,tenantId}=await open();
  const session=db.prepare('SELECT id FROM sessions WHERE tenant_id=?').get(tenantId) as {id:string};
  const result=await service.execute('auth.logout',{...request(''),
    tenant:{principal:{tenantId,userId:ownerUserId,sessionId:session.id,roles:['owner'],permissions:[]}} as unknown as RouteRequest['tenant']});
  const header=result?.headers?.['Set-Cookie']??'';
  // A credential that outlives the sign-out meant to destroy it is a finding waiting to happen.
  assert.match(header,/__Host-session=; [^,]*Max-Age=0/);
  assert.match(header,/__Host-refresh=; [^,]*Max-Age=0/);
});
