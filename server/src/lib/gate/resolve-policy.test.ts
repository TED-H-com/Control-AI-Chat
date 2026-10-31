import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, resolvePolicy } from './resolve-policy.js';

test('canonicalJson standardizes JSON correctly', () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(canonicalJson([1, { y: 2, x: 1 }]), '[1,{"x":1,"y":2}]');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson('test'), '"test"');
});

test('resolvePolicy filters and sorts rules correctly', () => {
    const tenantId = 'tenant1';
    const userId = 'user1';
    const groupIds = ['group1'];
    const modelId = 'model1';
    const nowMs = 12345;
    const subject = { tenantId, userId, groupIds, roles: [] } as any;

    const baseRule = {
        id: '1', revision: 1, name: 'rule', detectorKind: 'pii',
        action: 'block', passMask: 'both', priority: 1,
        scopeType: 'org', scopeId: tenantId, config: {}, failureMode: 'closed', sourceOrder: 1
    } as any;

    const ruleMismatch = { ...baseRule, id: '2', scopeType: 'org', scopeId: 'otherTenant' };

    const ruleGroup = { ...baseRule, id: '3', scopeType: 'group', scopeId: 'group1', priority: 2 };

    const snapshot = resolvePolicy({
        tenantId, modelId, subject, pass: 'preflight', policyVersion: 1,
        rules: [baseRule, ruleMismatch, ruleGroup], nowMs
    });

    assert.equal(snapshot.rules.length, 2);
    assert.equal(snapshot.rules[0]!.id, '3');
    assert.equal(snapshot.rules[1]!.id, '1');
    assert.ok(snapshot.fingerprint.length > 0);
});

test('resolvePolicy throws on tenant mismatch', () => {
    assert.throws(() => {
        resolvePolicy({
            tenantId: 'tenant1', modelId: 'm', pass: 'preflight', policyVersion: 1, rules: [], nowMs: 1,
            subject: { tenantId: 'tenant2' } as any
        });
    }, /gate_tenant_mismatch/);
});
