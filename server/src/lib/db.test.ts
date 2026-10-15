import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations/index.js';
import { assertTenantFirst, forTenant } from './db.js';
import { createSession, authorizeAccess, revokeSession, rotateRefresh } from './identity/sessions.js';
import type { TenantId } from '../shared/types.js';

/**
 * `forTenant` binds tenantId as the first parameter. A statement whose tenant predicate sits after a
 * SET clause therefore receives the tenant id in the wrong column and matches nothing, and the write
 * silently does nothing — no error, no rows, no clue. `revokeSession` was written that way, so
 * signing out never revoked anything.
 */
test('the binding guard accepts the forms that actually work',()=>{
  assert.equal(assertTenantFirst('SELECT id FROM users WHERE tenant_id = ? AND id = ?'),null);
  assert.equal(assertTenantFirst('DELETE FROM files WHERE tenant_id=? AND id=?'),null);
  assert.equal(assertTenantFirst('SELECT * FROM t WHERE tenant_id IN (?, ?)'),null);
  assert.equal(assertTenantFirst('WITH tenant_scope(id) AS (VALUES (?)) UPDATE t SET a=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?'),null);
  // A statement that needs the tenant id in several places hoists its whole filter list instead.
  assert.equal(assertTenantFirst('WITH q(tenant_id,q_kind) AS (VALUES(?,?)) SELECT * FROM roles r,q WHERE r.tenant_id=q.tenant_id AND (q.q_kind IS NULL OR r.kind=q.q_kind)'),null);
  // The reversed comparison spends the tenant parameter inside the SET clause and is still correct.
  assert.equal(assertTenantFirst("UPDATE users SET status=CASE WHEN ?=tenant_id THEN 'x' ELSE status END,deleted_at=? WHERE tenant_id=? AND id=?"),null);
});

test('the binding guard names the two ways a tenant statement goes wrong',()=>{
  assert.match(String(assertTenantFirst('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE tenant_id = ? AND id = ?')),
    /binds 2 parameter\(s\) before tenant_id/);
  // better-sqlite3 binds arrays only to anonymous `?`; a numbered statement throws on every call.
  assert.match(String(assertTenantFirst('UPDATE sessions SET revoked_at=?2 WHERE tenant_id=?1 AND id=?3')),/numbered parameters/);
  // A hoisted filter list is only tenant-scoped if the body joins against it. These two read exactly
  // like the accepted form above and return every tenant's rows.
  assert.match(String(assertTenantFirst('WITH q(tenant_id,q_kind) AS (VALUES(?,?)) SELECT * FROM roles r,q WHERE q.q_kind IS NULL OR r.kind=q.q_kind')),
    /never compares any tenant_id to it/);
  assert.match(String(assertTenantFirst('WITH q(q_kind,tenant_id) AS (VALUES(?,?)) SELECT * FROM roles r,q WHERE r.tenant_id=q.tenant_id')),
    /binds q\.q_kind first, which is not the tenant id/);
});

test('better-sqlite3 really does refuse numbered parameters, which is why the guard rejects them',()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE t(a TEXT,b TEXT)');db.prepare("INSERT INTO t VALUES('1','2')").run();
  assert.throws(()=>db.prepare('UPDATE t SET b=?2 WHERE a=?1').run('1','x'),/Too many parameter values/);
});

test('a misbound statement now throws instead of quietly changing nothing',()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE t(tenant_id TEXT,id TEXT,note TEXT)');
  const statement=db.prepare('UPDATE t SET note=? WHERE tenant_id=? AND id=?') as never;
  assert.throws(()=>forTenant({tenantId:'tenant' as TenantId}).run(statement,'note','id'),
    /binds 1 parameter\(s\) before tenant_id/);
});

function signedIn(){
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db);
  const tenantId=crypto.randomUUID() as TenantId,userId=crypto.randomUUID(),at=Date.now();
  db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,'acme','Acme',at,at);
  db.prepare("INSERT INTO users(tenant_id,id,email,display_name,status,locale,password_hash,created_at,updated_at,email_verified_at) VALUES(?,?,?,?,'active','en','x',?,?,?)")
    .run(tenantId,userId,'a@acme.test','A',at,at,at);
  const session=createSession(db,{userId,sessionId:crypto.randomUUID(),tenantId,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,authMethod:'password',jwtSecret:'j'.repeat(32)});
  return {db,tenantId,userId,session};
}

test('revoking a session actually revokes it, and the access token stops working',()=>{
  const {db,tenantId,session}=signedIn();
  assert.doesNotThrow(()=>authorizeAccess(db,session.accessToken,'j'.repeat(32)),'precondition: the token works before revocation');
  assert.equal(revokeSession(db,tenantId,session.id,'logout'),true,'revokeSession must report that it changed a row');
  const row=db.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE id=?').get(session.id) as {revoked_at:number|null;revoke_reason:string|null};
  assert.ok(row.revoked_at!==null);
  assert.equal(row.revoke_reason,'logout');
  // The whole point. Clearing the cookie is cosmetic; the server has to stop honouring the token.
  assert.throws(()=>authorizeAccess(db,session.accessToken,'j'.repeat(32)),/revoked or expired/i);
});

test('one tenant cannot revoke or rotate another tenant\'s session',()=>{
  const a=signedIn(),other=crypto.randomUUID() as TenantId;
  assert.equal(revokeSession(a.db,other,a.session.id,'logout'),false,'a foreign tenant id must not match the row');
  assert.throws(()=>rotateRefresh(a.db,other,a.session.refreshToken,{userId:a.userId,role:'owner',authMethods:['password'],mfa:true,sessionVersion:1,jwtSecret:'j'.repeat(32)}),/expired/i);
  assert.equal((a.db.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(a.session.id) as {revoked_at:number|null}).revoked_at,null);
});
