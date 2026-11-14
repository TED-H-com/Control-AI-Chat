import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import { encryptSecret, generateTotpSecret, totp } from '../../lib/identity/mfa.js';
import { hashPassword } from '../../lib/identity/password.js';
import { authorizeAccess, createSession } from '../../lib/identity/sessions.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest } from '../../routes/types.js';
import type { TenantId } from '../../shared/types.js';
import { createIdentityService, type IdentityAuditInput } from './service.js';

const jwtSecret = 'j'.repeat(32);
const encryptionKey = { id: 'test', key: Buffer.alloc(32, 1) };
const currentPassword = 'current password';
const newPassword = 'replacement password';

async function fixture(mfa = false, failAuditAction: string | null = null) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = Date.now();
  const tenantId = randomUUID() as TenantId;
  const userId = randomUUID();
  const roleId = randomUUID();
  const events: IdentityAuditInput[] = [];
  const passwordHash = await hashPassword(currentPassword);
  db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)")
    .run(tenantId, tenantId, 'Synthetic', now, now);
  db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,'A',?,'active',?,?,?)")
    .run(userId, tenantId, 'user-a@example.test', passwordHash, now, now, now);
  db.prepare("INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'member','Member',1,?)")
    .run(roleId, tenantId, now);
  db.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)')
    .run(tenantId, userId, roleId, now);

  const open = (method: 'password' | 'mfa') => createSession(db, {
    userId,
    tenantId,
    sessionId: randomUUID(),
    role: 'member',
    authMethods: ['password'],
    mfa: method === 'mfa',
    sessionVersion: 1,
    authMethod: method,
    jwtSecret,
    now,
  });
  const a = open(mfa ? 'mfa' : 'password');
  const b = open('password');
  const priorRevoked = open('password');
  db.prepare('UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=? AND id=?')
    .run(now - 1000, 'logout', tenantId, priorRevoked.id);

  const identity = createIdentityService({
    database: db,
    jwtSecret,
    appOrigin: 'https://app.test',
    encryptionKey,
    recoveryPepper: 'pepper',
    now: () => now,
    audit: {
      append(input) {
        if (failAuditAction && input.action === failAuditAction) throw new Error('audit unavailable');
        events.push(input);
      },
    },
  });

  const privateRequest = (body: unknown): RouteRequest => ({
    tenant: {
      principal: { tenantId, userId, membershipId: userId, sessionId: a.id, roles: ['member'], permissions: new Set() },
      db: forTenant({ tenantId }),
      requestId: 'test',
      now: new Date(now),
    },
    requestId: 'test',
    params: {},
    query: {},
    headers: new Headers(),
    body,
    rawBody: null,
  });
  const publicRequest = (body: unknown): RouteRequest => ({
    tenant: null,
    requestId: 'test',
    params: {},
    query: {},
    headers: new Headers(),
    body,
    rawBody: null,
  });
  const refreshRequest = (token: string): RouteRequest => ({
    tenant: null,
    requestId: 'test',
    params: {},
    query: {},
    headers: new Headers({ cookie: `__Host-refresh=${encodeURIComponent(token)}` }),
    body: {},
    rawBody: null,
  });
  const enableMfa = () => {
    const sealed = encryptSecret(generateTotpSecret(), encryptionKey);
    db.prepare('UPDATE users SET totp_secret_ciphertext=?,totp_enabled_at=? WHERE tenant_id=? AND id=?')
      .run(`${sealed.keyId}:${sealed.ciphertext}`, now, tenantId, userId);
  };
  const sessions = () => db.prepare('SELECT id,revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND user_id=? ORDER BY id').all(tenantId, userId);

  return { db, now, tenantId, userId, a, b, priorRevoked, identity, events, privateRequest, publicRequest, refreshRequest, enableMfa, sessions };
}

for (const item of [
  { name: 'password change', operation: 'auth.passwordChange', reason: 'password_changed', action: 'auth.password_changed' },
  { name: 'MFA enrollment', operation: 'identity.mfaVerify', reason: 'mfa_enrolled', action: 'auth.mfa_enabled' },
  { name: 'MFA replacement', operation: 'identity.mfaVerify', reason: 'mfa_enrolled', action: 'auth.mfa_enabled' },
  { name: 'MFA removal', operation: 'identity.mfaDelete', reason: 'mfa_disabled', action: 'auth.mfa_disabled' },
] as const) {
  test(`${item.name} revokes other sessions but keeps the current session`, async () => {
    const f = await fixture(item.operation === 'identity.mfaDelete' || item.name === 'MFA replacement');
    try {
      let body: unknown = { currentPassword, newPassword };
      if (item.operation === 'identity.mfaVerify') {
        if (item.name === 'MFA replacement') f.enableMfa();
        const setup = await f.identity.execute('identity.mfaSetup', f.privateRequest({}));
        body = { code: totp((setup!.body as { secret: string }).secret, f.now) };
      } else if (item.operation === 'identity.mfaDelete') {
        f.enableMfa();
        body = {};
      }
      assert.equal(authorizeAccess(f.db, f.b.accessToken, jwtSecret).sid, f.b.id);
      const result = await f.identity.execute(item.operation, f.privateRequest(body));
      assert.throws(() => authorizeAccess(f.db, f.b.accessToken, jwtSecret), /revoked or expired/u, 'the other access token must be refused');
      assert.deepEqual(
        f.db.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, f.b.id),
        { revoked_at: f.now, revoke_reason: item.reason },
      );
      assert.deepEqual(
        f.db.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, f.priorRevoked.id),
        { revoked_at: f.now - 1000, revoke_reason: 'logout' },
        'already-revoked sessions must keep their original revocation reason',
      );
      await assert.rejects(f.identity.execute('auth.refresh', f.refreshRequest(f.b.refreshToken)), /session has expired/iu);
      assert.equal(authorizeAccess(f.db, f.a.accessToken, jwtSecret).sid, f.a.id);
      assert.ok((await f.identity.execute('auth.refresh', f.refreshRequest(f.a.refreshToken)))?.headers?.['Set-Cookie']);
      assert.deepEqual(f.events.find(event => event.action === item.action)?.metadata, { sessionsRevoked: 1 });
      if (item.operation === 'auth.passwordChange') assert.deepEqual(result?.body, { changed: true, sessionsRevoked: 1 });
      if (item.operation === 'identity.mfaDelete') assert.equal(result?.status, 204);
    } finally {
      f.db.close();
    }
  });
}

test('wrong password and TOTP code leave credentials and sessions unchanged', async () => {
  const f = await fixture();
  try {
    const before = f.sessions();
    const userBefore = f.db.prepare('SELECT password_hash,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId, f.userId);
    await assert.rejects(
      f.identity.execute('auth.passwordChange', f.privateRequest({ currentPassword: 'incorrect password', newPassword })),
      /Current password is invalid/u,
    );
    const setup = await f.identity.execute('identity.mfaSetup', f.privateRequest({}));
    assert.ok(setup?.body);
    const enrollmentBefore = f.db.prepare('SELECT * FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').get(f.tenantId, f.userId);
    for (const wrongCode of ['not-a-totp', 'AAAA-BBBB']) {
      await assert.rejects(f.identity.execute('identity.mfaVerify', f.privateRequest({ code: wrongCode })), /Invalid MFA code/u);
    }
    assert.deepEqual(f.db.prepare('SELECT * FROM mfa_enrollments WHERE tenant_id=? AND user_id=?').get(f.tenantId, f.userId), enrollmentBefore);
    assert.deepEqual(f.db.prepare('SELECT password_hash,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId, f.userId), userBefore);
    assert.deepEqual(f.sessions(), before);
    assert.equal(authorizeAccess(f.db, f.a.accessToken, jwtSecret).sid, f.a.id);
    assert.equal(authorizeAccess(f.db, f.b.accessToken, jwtSecret).sid, f.b.id);
  } finally {
    f.db.close();
  }
});

test('MFA removal rolls back session revocation if auditing fails', async () => {
  const f = await fixture(true, 'auth.mfa_disabled');
  try {
    f.enableMfa();
    const before = f.sessions();
    const userBefore = f.db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId, f.userId);
    await assert.rejects(f.identity.execute('identity.mfaDelete', f.privateRequest({})), /audit unavailable/u);
    assert.deepEqual(f.sessions(), before);
    assert.deepEqual(f.db.prepare('SELECT totp_secret_ciphertext,totp_enabled_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId, f.userId), userBefore);
    assert.equal(authorizeAccess(f.db, f.b.accessToken, jwtSecret).sid, f.b.id);
  } finally {
    f.db.close();
  }
});

test('a second password change verified against the same current password is refused', async () => {
  const f = await fixture();
  try {
    const firstReplacement = 'first replacement password';
    const secondReplacement = 'second replacement password';
    const results = await Promise.allSettled([
      f.identity.execute('auth.passwordChange', f.privateRequest({ currentPassword, newPassword: firstReplacement })),
      f.identity.execute('auth.passwordChange', f.privateRequest({ currentPassword, newPassword: secondReplacement })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match((rejected[0]!.reason as Error).message, /Current password is invalid/u);
    assert.equal((rejected[0]!.reason as { code?: unknown }).code, 'INVALID_CREDENTIALS');

    const winner = results[0]!.status === 'fulfilled' ? firstReplacement : secondReplacement;
    const loser = results[0]!.status === 'fulfilled' ? secondReplacement : firstReplacement;
    assert.equal(f.events.filter(event => event.action === 'auth.password_changed').length, 1);
    const login = await f.identity.execute('auth.login', f.publicRequest({ email: 'user-a@example.test', password: winner }));
    assert.match(login?.headers?.['Set-Cookie'] ?? '', /__Host-session=/u);
    await assert.rejects(
      f.identity.execute('auth.login', f.publicRequest({ email: 'user-a@example.test', password: loser })),
      /Invalid email or password/u,
    );
    await assert.rejects(
      f.identity.execute('auth.login', f.publicRequest({ email: 'user-a@example.test', password: currentPassword })),
      /Invalid email or password/u,
    );
    assert.deepEqual(
      f.db.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND id=?').get(f.tenantId, f.b.id),
      { revoked_at: f.now, revoke_reason: 'password_changed' },
    );
    assert.equal(authorizeAccess(f.db, f.a.accessToken, jwtSecret).sid, f.a.id);
  } finally {
    f.db.close();
  }
});
