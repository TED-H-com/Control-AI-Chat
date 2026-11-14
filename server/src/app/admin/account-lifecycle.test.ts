import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAdminAdapter, prepareAdminStatements } from './index.js';
import { prepareConsoleStatements } from './capabilities.js';
import { prepareAnalyticsStatements } from './analytics.js';
import { prepareNudgeStatements } from './nudges.js';
import { createDirectoryReader } from './directory.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { forTenant } from '../../lib/db.js';
import type { AuditService } from '../../lib/audit/index.js';
import { createSession } from '../../lib/identity/sessions.js';
import type { RouteRequest } from '../../routes/types.js';
import type { RequestPrincipal, Role, TenantId } from '../../shared/types.js';

const AT = 1_700_000_000_000;
const jwtSecret = 'j'.repeat(32);

function fixture(failAudit = false) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  const tenantId = randomUUID() as TenantId;
  const userId = randomUUID();
  const memberId = randomUUID();
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);
  run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'acme','Acme','active',?,?)`, tenantId, AT, AT);
  run(`INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)`, tenantId, AT);
  for (const [id, email, name] of [[userId, 'owner@example.test', 'Owner'], [memberId, 'member@example.test', 'Member']] as const) {
    run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)`, id, tenantId, email, name, AT, AT);
  }
  const roleIds = new Map<Role, string>();
  for (const key of ['owner', 'admin', 'compliance', 'member'] as const) {
    const roleId = randomUUID();
    roleIds.set(key, roleId);
    run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,?,?,1,?)`, roleId, tenantId, key, key, AT);
  }
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)`, tenantId, userId, roleIds.get('owner')!, AT);
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)`, tenantId, memberId, roleIds.get('member')!, AT);

  const events: string[] = [];
  const append = (input: { action: string }) => {
    if (failAudit) throw new Error('forced audit failure');
    events.push(input.action);
    return { id: randomUUID(), tenantId, chainEpoch: 1, sequence: events.length, eventHash: 'a'.repeat(64), recordedAtMs: AT };
  };
  const audit = {
    append,
    transact: <T>(work: (tx: { append: typeof append }) => T) => database.transaction(() => work({ append })).immediate(),
    enqueue() { throw new Error('unused'); },
  } as unknown as AuditService;

  const adapter = createAdminAdapter({
    database,
    statements: prepareAdminStatements(database),
    console: prepareConsoleStatements(database),
    analytics: prepareAnalyticsStatements(database),
    nudges: prepareNudgeStatements(database),
    directory: createDirectoryReader(database, () => AT),
    audit,
    now: () => AT,
    appOrigin: 'https://app.test',
    idempotencyHmacKey: Buffer.alloc(32, 1),
    invitationResponseEncryptionKey: Buffer.alloc(32, 2),
  });

  const tenantDb = forTenant({ tenantId });
  const request = (body: unknown, params: Record<string, string> = {}, roles: Role[] = ['owner']): RouteRequest => {
    const principal: RequestPrincipal = { userId, tenantId, membershipId: userId, sessionId: randomUUID(), roles, permissions: new Set() };
    return {
      tenant: { principal, db: tenantDb, requestId: randomUUID(), now: new Date(AT) },
      requestId: randomUUID(),
      params,
      query: {},
      headers: new Headers({ 'Idempotency-Key': randomUUID() }),
      body,
      rawBody: null,
    };
  };
  const openSession = (targetUserId: string, targetTenantId: TenantId = tenantId) => createSession(database, {
    userId: targetUserId,
    sessionId: randomUUID(),
    tenantId: targetTenantId,
    role: 'member',
    authMethods: ['password'],
    mfa: false,
    sessionVersion: 1,
    authMethod: 'password',
    jwtSecret,
    now: AT,
  });
  const count = (sql: string, ...params: unknown[]) => database.prepare(sql).pluck().get(...params) as number;
  return { database, adapter, request, openSession, count, events, tenantId, userId, memberId, allowAudit() { failAudit = false; } };
}

const withMatch = (request: RouteRequest, version: number): RouteRequest => {
  const headers = new Headers(request.headers);
  headers.set('If-Match', `"${version}"`);
  return { ...request, headers };
};

for (const operation of ['admin.users.update', 'admin.users.delete'] as const) {
  test(`${operation} revokes all target sessions`, async () => {
    const f = fixture();
    try {
      const targetSessions = [f.openSession(f.memberId), f.openSession(f.memberId)];
      const priorRevoked = f.openSession(f.memberId);
      f.database.prepare('UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=? AND id=?')
        .run(AT - 10, 'logout', f.tenantId, priorRevoked.id);
      const adminSession = f.openSession(f.userId);
      const foreignTenant = randomUUID() as TenantId;
      const foreignUser = randomUUID();
      f.database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'other','Other','active',?,?)`).run(foreignTenant, AT, AT);
      f.database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Other','hash','active',?,?)`).run(foreignUser, foreignTenant, 'other@example.test', AT, AT);
      const foreignSession = f.openSession(foreignUser, foreignTenant);

      let version = AT;
      if (operation === 'admin.users.update') {
        await f.adapter.execute(operation, withMatch(f.request({ displayName: 'Renamed' }, { id: f.memberId }), version));
        assert.equal(f.count('SELECT count(*) FROM sessions WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL', f.tenantId, f.memberId), 2);
        version += 1;
      }

      const result = await f.adapter.execute(
        operation,
        withMatch(f.request(operation === 'admin.users.update' ? { status: 'suspended' } : null, { id: f.memberId }), version),
      );
      assert.equal(result.status, operation === 'admin.users.delete' ? 204 : undefined);

      const reason = operation === 'admin.users.update' ? 'admin_suspended' : 'admin_deprovisioned';
      for (const session of targetSessions) {
        assert.deepEqual(
          f.database.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, session.id),
          { revoked_at: AT, revoke_reason: reason },
        );
      }
      assert.deepEqual(
        f.database.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, priorRevoked.id),
        { revoked_at: AT - 10, revoke_reason: 'logout' },
      );
      assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE tenant_id=? AND id=?').pluck().get(f.tenantId, adminSession.id), null);
      assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE tenant_id=? AND id=?').pluck().get(foreignTenant, foreignSession.id), null);

      if (operation === 'admin.users.update') {
        await f.adapter.execute(operation, withMatch(f.request({ status: 'active' }, { id: f.memberId }), version + 1));
        assert.equal(f.count('SELECT count(*) FROM sessions WHERE tenant_id=? AND user_id=? AND revoked_at IS NOT NULL', f.tenantId, f.memberId), 3);
      }
    } finally {
      f.database.close();
    }
  });
}

for (const operation of ['admin.users.update', 'admin.users.delete'] as const) {
  test(`${operation} rolls back session revocation when auditing fails`, async () => {
    const f = fixture(true);
    try {
      const target = [f.openSession(f.memberId), f.openSession(f.memberId)];
      const other = f.openSession(f.userId);
      const request = withMatch(f.request(operation === 'admin.users.update' ? { status: 'suspended' } : null, { id: f.memberId }), AT);

      await assert.rejects(f.adapter.execute(operation, request), /forced audit failure/u);
      assert.deepEqual(
        f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId, f.memberId),
        { status: 'active', deleted_at: null },
      );
      for (const session of target) {
        assert.deepEqual(
          f.database.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, session.id),
          { revoked_at: null, revoke_reason: null },
        );
      }

      f.allowAudit();
      await f.adapter.execute(operation, request);
      const reason = operation === 'admin.users.update' ? 'admin_suspended' : 'admin_deprovisioned';
      for (const session of target) {
        assert.deepEqual(
          f.database.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, session.id),
          { revoked_at: AT, revoke_reason: reason },
        );
      }
      assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE tenant_id=? AND id=?').pluck().get(f.tenantId, other.id), null);
    } finally {
      f.database.close();
    }
  });
}
