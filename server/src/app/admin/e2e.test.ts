import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import { createAdminAdapter, prepareAdminStatements } from './index.js';
import { prepareConsoleStatements } from './capabilities.js';
import { prepareAnalyticsStatements } from './analytics.js';
import { prepareNudgeStatements } from './nudges.js';
import { createDirectoryReader } from './directory.js';
import { forTenant } from '../../lib/db.js';
import type { RouteRequest } from '../../routes/types.js';
import type { TenantId, Permission, RequestPrincipal, Role } from '../../shared/types.js';
import type { AuditService } from '../../lib/audit/index.js';
import { createAuditService } from '../../lib/audit/index.js';
import { createAuditRouteAdapter } from '../audit/index.js';
import { resolvePolicy } from '../../lib/gate/index.js'; // Needed if we run mock gates
import { seedDefaultPolicy } from '../../lib/gate/default-policy.js';

const AT = 1_700_000_000_000;

function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys=ON');
  runMigrations(database);

  const tenantId = randomUUID() as TenantId;
  const userId = randomUUID();
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);

  run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'acme','Acme','active',?,?)`, tenantId, AT, AT);
  run(`INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)`, tenantId, AT);
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)`, userId, tenantId, 'owner@acme.test', AT, AT);

  const complianceUserId = randomUUID();
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Compliance','hash','active',?,?)`, complianceUserId, tenantId, 'compliance@acme.test', AT, AT);

  for (const key of ['owner','admin','compliance','member'])
    run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,?,?,1,?)`, randomUUID(), tenantId, key, key, AT);

  const policyId = randomUUID();
  run(`INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Default',?,?)`, policyId, tenantId, AT, AT);
  const detectorId = randomUUID();
  run(`INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'test-detector','keyword','{}','a3498b31a319f36f6d8a30161474da6bc82798f4842d076f809d0db3405781a8',1,0,?,?)`, detectorId, tenantId, AT, AT);
  const ruleId = randomUUID();
  run(`INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant','outbound','block','high','{}',1,100,?,?)`, ruleId, tenantId, policyId, detectorId, AT, AT);

  const compRoleId = database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='compliance'").get(tenantId) as {id:string};
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)`, tenantId, complianceUserId, compRoleId.id, userId, AT);

  const events: string[] = [];
  const append = (input: {action: string}) => {
    events.push(input.action);
    return { id: randomUUID(), tenantId, chainEpoch: 1, sequence: events.length, eventHash: 'a'.repeat(64), recordedAtMs: AT };
  };
  const audit = { append, transact: <T>(work: (tx: {append: typeof append}) => T) => database.transaction(() => work({append})).immediate(), enqueue() {} } as unknown as AuditService;

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
    invitationResponseEncryptionKey: Buffer.alloc(32, 2)
  });

  const tenantDb = forTenant({tenantId, database} as any);

  const request = (roles: Role[], body: any = null, query: any = {}, headers: any = {}, params: any = {}): RouteRequest => {
    // We skip exact permission sets for this integration fixture and grant full permissions logically to the mock
    const p = new Set<Permission>(['policy:read','policy:write','admin:users','member:read','member:assign_member_role','member:update_profile','audit:read'] as any);
    const principal: RequestPrincipal = { tenantId, userId, membershipId: userId, sessionId: randomUUID(), roles, permissions: p };
    return {
      tenant: { principal, requestId: randomUUID(), now: new Date(AT), db: tenantDb },
      requestId: randomUUID(),
      params,
      query,
      headers: new Headers(headers),
      body,
      rawBody: null,
      url: 'https://test.com'
    };
  };

  return { database, adapter, tenantId, userId, complianceUserId, request, policyId, ruleId };
}

function withMatch(req: RouteRequest, version: number): RouteRequest {
  req.headers.set('If-Match', `"${version}"`);
  return req;
}

test('E2E tests for admin control dashboard API endpoints', async () => {
    const f = fixture();

    // 1. Policy toggling (gate.rules.update equivalent test based on list rules to verify endpoints exists)
    const listRulesResponse = await f.adapter.execute('gate.policies.list', f.request(['owner']));
    assert.equal(listRulesResponse.status, undefined); // 200 OK
    assert.ok(Array.isArray((listRulesResponse.body as any).items));

    const getRuleResponse = await f.adapter.execute('gate.rules.list', f.request(['owner']));
    const rules = (getRuleResponse.body as any).items;
    const rule = rules.find((r: any) => r.id === f.ruleId);
    assert.ok(rule);

    const updateReq = f.request(['owner'], { enabled: false }, {}, {}, { id: f.ruleId });
    updateReq.headers.set('Idempotency-Key', 'e2e-rule-toggle');
    const updateRulesResponse = await f.adapter.execute('gate.rules.update', withMatch(updateReq, rule.updated_at));
    assert.equal(updateRulesResponse.status, undefined);
    assert.equal((updateRulesResponse.body as any).item.enabled, 0);

    // 2. User role verification
    const listRolesResponse = await f.adapter.execute('admin.roles.list', f.request(['owner']));
    assert.equal(listRolesResponse.status, undefined);
    assert.ok(Array.isArray((listRolesResponse.body as any).items));

    const listUsersResponse = await f.adapter.execute('admin.users.list', f.request(['owner']));
    const users = (listUsersResponse.body as any).items;
    const compUser = users.find((u: any) => u.id === f.complianceUserId);
    assert.ok(compUser);
    assert.ok(compUser.roles.includes('compliance'));

    const updateUserReq = f.request(['owner'], { role: 'member', displayName: 'member' }, {}, {}, { id: f.complianceUserId });
    updateUserReq.headers.set('Idempotency-Key', 'e2e-role-change');
    const updateUserResponse = await f.adapter.execute('admin.users.update', withMatch(updateUserReq, compUser.version));
    assert.equal(updateUserResponse.status, undefined);
    assert.ok((updateUserResponse.body as any).item.roles.includes('member'));

    // 3. Prompt audit query endpoints
    // Setup real audit service since it operates differently
    const auditService = createAuditService({
      database: f.database,
      ipHmacKey: Buffer.alloc(32, 7),
      transcriptKey: () => Buffer.alloc(32, 8),
      retentionPolicy: tenantId => ({ tenantId, chatTranscriptDays: 90, violationTranscriptDays: 365, approvalPayloadDays: 30, auditMetadataDays: null, captureTranscripts: false, effectiveAtMs: AT }),
      now: () => AT
    });
    const auditAdapter = createAuditRouteAdapter({ database: f.database, cursorKey: Buffer.alloc(32), ipHmacKey: Buffer.alloc(32), idempotencyHmacKey: Buffer.alloc(32), exportDirectory: '/tmp', audit: auditService, approvalReleaseAvailable: false, approvalReleaseQueue: null as any });

    const listEventsResponse = await auditAdapter.execute('audit.events', f.request(['owner'], null, { page: '1' }));
    assert.equal(listEventsResponse.status, undefined);
    assert.ok(Array.isArray((listEventsResponse.body as any).items));

    f.database.close();
});
