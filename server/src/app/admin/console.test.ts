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
import { toStorageKey } from '../../shared/permissions.js';
import type { AuditService } from '../../lib/audit/index.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { RequestPrincipal, Role, TenantId } from '../../shared/types.js';

/**
 * The eight reporting operations were implemented and routed but never dispatched, so the whole admin
 * console answered 501 — the one thing this product is sold on is that an administrator can run
 * reports and read the log. These assert the numbers as well as the wiring: a summary that returns
 * zeros for a tenant with traffic is the same outage with a 200 on it.
 */
const AT = 1_700_000_000_000, HOUR = 3_600_000;

function fixture() {
  const database = new Database(':memory:'); database.pragma('foreign_keys=ON'); runMigrations(database);
  const tenantId = randomUUID() as TenantId, userId = randomUUID(), other = randomUUID() as TenantId;
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);
  for (const [id, slug] of [[tenantId, 'acme'], [other, 'globex']] as const) {
    run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`, id, slug, slug, AT, AT);
    run(`INSERT INTO tenant_settings(tenant_id,conversation_retention_days,audit_retention_days,updated_at) VALUES(?,30,365,?)`, id, AT);
  }
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)`, userId, tenantId, 'owner@acme.test', AT, AT);
  const roleId = randomUUID();
  run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'auditor','Auditor',0,?)`, roleId, tenantId, AT);
  for (const permission of ['audit:read', 'model:read'] as const) {
    run(`INSERT INTO permissions(key,description) VALUES(?,?)`, toStorageKey(permission), permission);
    run(`INSERT INTO role_permissions(role_id,permission_key) VALUES(?,?)`, roleId, toStorageKey(permission));
  }
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)`, tenantId, userId, roleId, AT);

  // usage_records.message_id is the only key that links a request to its gate decision, so the one
  // run that was blocked needs a real message behind it.
  const conversationId = randomUUID(), blockedMessage = randomUUID();
  run(`INSERT INTO conversations(id,tenant_id,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)`, conversationId, tenantId, userId, AT, AT);
  run(`INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,'user','complete',0,?)`, blockedMessage, tenantId, conversationId, userId, AT);

  // Traffic for the tenant under test, plus one identical run belonging to the other tenant: every
  // number below is wrong by exactly one if the tenant predicate is not doing its job.
  const usage = (tenant: string, at: number, status: string, cost: number, messageId: string | null) =>
    run(`INSERT INTO usage_records(id,tenant_id,user_id,message_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,completed_at,status) VALUES(?,?,?,?,'openai','gpt-5.6',100,200,?,?,?,?)`,
      randomUUID(), tenant, tenant === tenantId ? userId : null, messageId, cost, at, at + 900, status);
  usage(tenantId, AT - HOUR, 'success', 1_000, blockedMessage);
  usage(tenantId, AT - 2 * HOUR, 'success', 2_000, null);
  usage(tenantId, AT - 3 * HOUR, 'failed', 0, null);
  usage(other, AT - HOUR, 'success', 999_000, null);
  run(`INSERT INTO gate_decisions(id,tenant_id,user_id,message_id,direction,final_action,status,content_sha256,latency_ms,decided_at) VALUES(?,?,?,?,'outbound','block','final',?,12,?)`,
    randomUUID(), tenantId, userId, blockedMessage, 'a'.repeat(64), AT - HOUR);

  const audit = { append: () => ({ id: randomUUID() }), transact: <T,>(work: (tx: unknown) => T) => work({ append: () => ({ id: randomUUID() }) }), enqueue() { throw new Error('unused') } } as unknown as AuditService;
  const adapter = createAdminAdapter({ database, statements: prepareAdminStatements(database), console: prepareConsoleStatements(database), analytics: prepareAnalyticsStatements(database), nudges:prepareNudgeStatements(database), directory: createDirectoryReader(database, () => AT), audit, now: () => AT, appOrigin:'https://app.test', idempotencyHmacKey:Buffer.alloc(32,1), invitationResponseEncryptionKey:Buffer.alloc(32,2) });

  const request = (roles: Role[] = ['owner'], query: Record<string, string> = {}): RouteRequest => {
    const principal: RequestPrincipal = { userId, tenantId, membershipId: userId, sessionId: randomUUID(), roles, permissions: new Set() };
    return { tenant: { principal, db: forTenant({ tenantId }), requestId: randomUUID(), now: new Date(AT) }, requestId: randomUUID(), params: {}, query, headers: new Headers(), body: null, rawBody: null };
  };
  return { database, adapter, request, tenantId, userId, other, run };
}

const ok = (result: RouteResult): Record<string, unknown> => { assert.equal(result.status, undefined, `expected a 200, got ${result.status}: ${JSON.stringify(result.body)}`); return result.body as Record<string, unknown> };

test('the dashboard reports this tenant\'s traffic and nobody else\'s', async () => {
  const f = fixture();
  const summary = ok(await f.adapter.execute('admin.dashboard', f.request(['owner'], { range: '24h' }))) as unknown as
    { requests: number; activeUsers: number; tokens: { total: number }; spendMicroUsd: number; blockedRequests: number; providerErrorRate: number; usage: { requests: number }[] };
  assert.equal(summary.requests, 3, 'three runs in the window, and the fourth belongs to another tenant');
  assert.equal(summary.activeUsers, 1);
  assert.equal(summary.tokens.total, 900);
  assert.equal(summary.spendMicroUsd, 3_000, 'the other tenant\'s 999,000 must not be in this total');
  assert.equal(summary.blockedRequests, 1);
  assert.equal(summary.providerErrorRate, 1 / 3);
  // Quiet buckets are emitted, so the chart cannot draw a straight line across an hour with no traffic.
  assert.ok(summary.usage.length > 3 && summary.usage.some(point => point.requests === 0));
  f.database.close();
});

test('capabilities answers from role_permissions', async () => {
  const f = fixture();
  // The caller claims 'owner' on the token and still gets only the two grants the database holds.
  const body = ok(await f.adapter.execute('admin.capabilities', f.request(['owner']))) as unknown as { tenantId: string; userId:string; roleIds: string[]; permissions: string[] };
  assert.equal(body.tenantId, f.tenantId);
  assert.equal(body.userId, f.userId);
  assert.deepEqual(body.roleIds, ['auditor']);
  assert.deepEqual([...body.permissions].sort(), ['audit:read', 'model:read']);
  f.database.close();
});

test('capabilities stays open to a member so the console can ask what it may show', async () => {
  const f = fixture();
  f.run(`DELETE FROM user_roles WHERE tenant_id=?`, f.tenantId);
  const body = ok(await f.adapter.execute('admin.capabilities', f.request(['member']))) as unknown as { permissions: string[] };
  assert.deepEqual(body.permissions, [], 'no grants, but an answer rather than a 403 the console cannot recover from');
  f.database.close();
});

test('reporting is refused to a role that holds no report permission', async () => {
  const f = fixture();
  for (const operation of ['admin.dashboard', 'admin.nudges', 'admin.analytics.timeseries', 'admin.analytics.breakdown', 'admin.analytics.detectors']) {
    const denied = await f.adapter.execute(operation, f.request(['member']));
    assert.equal(denied.status, 403, `${operation} must refuse a member`);
  }
  // Compliance holds report.read and must get through.
  assert.equal((await f.adapter.execute('admin.dashboard', f.request(['compliance'], { range: '24h' }))).status, undefined);
  f.database.close();
});

test('analytics buckets and breaks down the same window the dashboard summarised', async () => {
  const f = fixture();
  const series = ok(await f.adapter.execute('admin.analytics.timeseries', f.request(['owner'], { range: '24h' }))) as unknown as { items: { bucket: string; requests: number }[] };
  assert.equal(series.items.reduce((total, point) => total + point.requests, 0), 3);
  const breakdown = ok(await f.adapter.execute('admin.analytics.breakdown', f.request(['owner'], { range: '24h', dimension: 'provider' }))) as unknown as { items: { id: string; requests: number; spendMicroUsd: number }[] };
  assert.deepEqual(breakdown.items.map(row => [row.id, row.requests, row.spendMicroUsd]), [['openai', 3, 3_000]]);
  f.database.close();
});

test('a mistyped filter is the caller\'s error, not a 500', async () => {
  const f = fixture();
  const cases = [['admin.analytics.breakdown', { range: 'yesterday' }], ['admin.analytics.breakdown', { dimension: 'weather' }],
    ['admin.analytics.breakdown', { limit: '0' }], ['admin.analytics.breakdown', { cursor: 'nonsense' }],
    ['admin.analytics.timeseries', { granularity: 'fortnight' }], ['admin.dashboard', { range: 'yesterday' }]] as const;
  for (const [operation, query] of cases) {
    const response = await f.adapter.execute(operation, f.request(['owner'], query));
    assert.equal(response.status, 422, `${operation} ${JSON.stringify(query)} must be a 422`);
  }
  f.database.close();
});

test('the bounded list screens return rows rather than 501', async () => {
  const f = fixture();

  const roles = ok(await f.adapter.execute('admin.roles.list', f.request())) as unknown as { items: { name: string; type: string }[] };
  assert.ok(roles.items.length > 0 && roles.items.every(row => typeof row.name === 'string'));

  const retention = ok(await f.adapter.execute('admin.retention.list', f.request())) as unknown as { items: { dataClass: string; retentionDays: number | null }[] };
  assert.deepEqual(retention.items.map(row => row.dataClass), ['conversations', 'messages', 'audit_events', 'files']);
  assert.equal(retention.items[0]!.retentionDays, 30, 'the tenant\'s own setting, not a default');

  f.database.close();
});

test('the assets screen counts a project\'s real conversations, files and people', async () => {
  const f = fixture();
  const [projectId, second, other] = [randomUUID(), randomUUID(), randomUUID()];
  const collaborator = randomUUID();
  f.run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'colleague@acme.test','Colleague','hash','active',?,?)`, collaborator, f.tenantId, AT, AT);
  f.run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Vendor Risk Review',?,?)`, projectId, f.tenantId, f.userId, AT - HOUR, AT - HOUR);
  f.run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at,archived_at) VALUES(?,?,?,'Retired Programme',?,?,?)`, second, f.tenantId, f.userId, AT - 2 * HOUR, AT - 2 * HOUR, AT);
  f.run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,NULL,'Theirs',?,?)`, other, f.other, AT, AT);
  // Two conversations by two different people, one of them the owner; the deleted one must not count.
  for (const [owner, at, deleted] of [[f.userId, AT - HOUR, null], [collaborator, AT, null], [collaborator, AT, AT]] as const) {
    const conversationId = randomUUID();
    f.run(`INSERT INTO conversations(id,tenant_id,owner_user_id,created_at,updated_at,status,deleted_at) VALUES(?,?,?,?,?,?,?)`, conversationId, f.tenantId, owner, at, at, deleted ? 'deleted' : 'active', deleted);
    f.run(`INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)`, projectId, conversationId, owner, at);
  }
  f.run(`INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,created_at) VALUES(?,?,?,?,'evidence.txt','k','text/plain',4096,?,'ready',?)`, randomUUID(), f.tenantId, projectId, f.userId, 'a'.repeat(64), AT);
  // Still listed, no longer stored: retention purged its content. It counts as a file and as no
  // bytes, because bytes is what the tenant is holding, not what it once held.
  f.run(`INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,created_at,content_purged_at) VALUES(?,?,?,?,'expired.txt','k2','text/plain',9999,?,'ready',?,?)`, randomUUID(), f.tenantId, projectId, f.userId, 'b'.repeat(64), AT - 2 * HOUR, AT);

  const body = ok(await f.adapter.execute('admin.projects.list', f.request())) as unknown as
    { items: { name: string; owner: string; members: number; conversations: number; files: number; bytes: number; status: string }[]; nextCursor: string | null };
  assert.deepEqual(body.items.map(row => [row.name, row.owner, row.members, row.conversations, row.files, row.bytes, row.status]),
    [['Vendor Risk Review', 'Owner', 2, 2, 2, 4096, 'active'], ['Retired Programme', 'Owner', 1, 0, 0, 0, 'archived']],
    'the other tenant\'s project, the deleted conversation and a second count of the owner must all be absent');
  assert.equal(body.nextCursor, null, 'two rows do not fill a page');
  // Ordered by activity, so the archived project sorts under the one that was used an hour ago.
  const active = ok(await f.adapter.execute('admin.projects.list', f.request(['owner'], { status: 'active' }))) as unknown as { items: { name: string }[] };
  assert.deepEqual(active.items.map(row => row.name), ['Vendor Risk Review']);
  assert.equal((await f.adapter.execute('admin.projects.list', f.request(['owner'], { cursor: 'nonsense' }))).status, 422);
  f.database.close();
});

test('the assets screen pages without skipping or repeating a project', async () => {
  const f = fixture();
  // 51 projects against a 50-row page: enough to cross the boundary exactly once. Distinct
  // updated_at values so the keyset has a total order to resume from.
  const expected: string[] = [];
  for (let index = 0; index < 51; index += 1) {
    const name = `Project ${String(index).padStart(2, '0')}`;
    expected.push(name);
    f.run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)`, randomUUID(), f.tenantId, f.userId, name, AT, AT - index * 1_000);
  }
  const first = ok(await f.adapter.execute('admin.projects.list', f.request())) as unknown as { items: { name: string }[]; nextCursor: string | null };
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor, 'a full page with a row behind it must hand back a cursor');
  const second = ok(await f.adapter.execute('admin.projects.list', f.request(['owner'], { cursor: first.nextCursor! }))) as unknown as { items: { name: string }[]; nextCursor: string | null };
  assert.equal(second.nextCursor, null, 'the last page must not offer another');
  const seen = [...first.items, ...second.items].map(row => row.name);
  assert.deepEqual(seen, expected, 'every project exactly once, newest activity first');
  assert.equal(new Set(seen).size, 51);
  f.database.close();
});

test('the list screens do not leak another tenant\'s rows', async () => {
  const f = fixture();
  assert.deepEqual((ok(await f.adapter.execute('admin.projects.list', f.request())) as unknown as { items: unknown[] }).items, []);
  f.database.close();
});
