import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSession, findRefreshSession, revokeSession } from './sessions.js';
import { runMigrations, migrations } from '../migrations/index.js';
import type { TenantId } from '../../shared/types.js';
import { provisionTestTenant } from '../../test/tenant-fixture.js';

function getDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const now = Date.now();
  const f = provisionTestTenant(db, { email: 'test@example.com', name: 'Test Tenant', now });
  return { db, tenantId: f.tenantId, userId: f.ownerUserId };
}

test('session creation returns expected tokens and sets expiry', () => {
  const { db, tenantId, userId } = getDb();
  const input = {
    tenantId: tenantId as TenantId,
    userId,
    sessionId: randomUUID(), // Provided to satisfy IssueAccessInput but overwritten internally by createSession
    authMethod: 'password' as const,
    jwtSecret: 'x'.repeat(32),
    now: Date.now(),
    role: 'member' as const,
    authMethods: ['password'] as const,
    mfa: false,
    sessionVersion: 1
  };

  const session = createSession(db, input);

  assert.ok(session.id);
  assert.ok(session.refreshToken);
  assert.ok(session.accessToken);
  assert.ok(session.accessExpiresAt > Math.floor(input.now / 1000));

  db.close();
});

test('findRefreshSession handles invalid and revoked sessions', () => {
  const { db, tenantId, userId } = getDb();
  const now = Date.now();
  const input = {
    tenantId: tenantId as TenantId,
    userId,
    sessionId: randomUUID(),
    authMethod: 'password' as const,
    jwtSecret: 'x'.repeat(32),
    now,
    role: 'member' as const,
    authMethods: ['password'] as const,
    mfa: false,
    sessionVersion: 1
  };

  const session = createSession(db, input);

  const found = findRefreshSession(db, session.refreshToken, now);
  assert.ok(found);
  assert.equal(found.id, session.id);

  const invalid = findRefreshSession(db, 'invalid-token', now);
  assert.equal(invalid, null);

  revokeSession(db, tenantId as TenantId, session.id, 'logout', now + 1000);
  const revoked = findRefreshSession(db, session.refreshToken, now + 2000);
  assert.equal(revoked, null);

  db.close();
});
