import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import { createAuditService, verifyAuditChain } from '../../lib/audit/index.js';
import type { TenantId } from '../../shared/types.js';

const AT = 1_700_000_000_000;

function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys=ON');
  runMigrations(database);

  const tenantId = randomUUID() as TenantId;
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);

  run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'acme','Acme','active',?,?)`, tenantId, AT, AT);

  let now = AT;
  const audit = createAuditService({
    database,
    ipHmacKey: Buffer.alloc(32, 1),
    transcriptKey: () => Buffer.alloc(32, 2),
    retentionPolicy: id => ({tenantId: id, chatTranscriptDays: 90, violationTranscriptDays: 365, approvalPayloadDays: 30, auditMetadataDays: null, captureTranscripts: false, effectiveAtMs: now}),
    now: () => now++
  });

  return { database, tenantId, audit };
}

test('E2E tests for audit chain creation and tampering detection', async () => {
    const f = fixture();

    // 1. Create a chain of events
    for (let i = 0; i < 5; i++) {
        f.audit.append({
            tenantId: f.tenantId,
            action: 'chat.conversation_created',
            actor: {type: 'user', id: null, sessionId: null, ip: null, userAgent: null, authMethod: 'password'},
            target: {type: 'conversation', id: null},
            outcome: 'success',
            context: {requestId: `req-${i}`, traceId: null, source: 'http'},
            metadata: {mode: 'chat', projectId: null}
        });
    }

    // 2. Verify chain is healthy
    const head = f.database.prepare('SELECT status, last_sequence FROM audit_chain_heads WHERE tenant_id=?').get(f.tenantId) as {status: string, last_sequence: number};
    assert.equal(head.status, 'healthy');
    assert.equal(head.last_sequence, 6); // Genesis event + 5 appends

    const verificationBefore = verifyAuditChain(f.database, f.tenantId);
    assert.equal(verificationBefore.valid, true);

    // 3. Tamper with an event
    f.database.prepare("UPDATE audit_events SET metadata_json=json_set(metadata_json,'$.mode','tampered') WHERE tenant_id=? AND sequence=3").run(f.tenantId);

    // 4. Run chain verification manually to ensure it correctly identifies the tampering
    const verification = verifyAuditChain(f.database, f.tenantId);

    assert.equal(verification.valid, false);
    assert.equal(verification.breakAtSequence, 3);
    assert.equal(verification.reason, 'event_hash_mismatch');

    f.database.close();
});
