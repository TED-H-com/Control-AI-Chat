import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMatch, applicableRules, confidenceRank } from './match.js';

test('makeMatch generates a match object', () => {
    const match = makeMatch({
        tenantId: 'tenant1', detectorId: 'det1', kind: 'keyword',
        rule: { id: 'r1', revision: 1, action: 'block' } as any,
        partId: 'p1', category: 'cat1', confidence: 'high',
        span: { start: 0, end: 5 }, text: '123456789', label: 'LABEL'
    });

    assert.ok(match.matchId);
    assert.equal(match.detectorId, 'det1');
    assert.equal(match.action, 'block');
    assert.equal(match.category, 'cat1');
    assert.ok(match.safeExcerpt.includes('[LABEL]'));
});

test('applicableRules filters by kind and pass', () => {
    const rules = [
        { detectorKind: 'keyword', passMask: 'both' },
        { detectorKind: 'keyword', passMask: 'preflight' },
        { detectorKind: 'keyword', passMask: 'postflight' },
        { detectorKind: 'pii', passMask: 'both' }
    ] as any[];

    const preflight = applicableRules({ pass: 'preflight', policySnapshot: { rules } }, 'keyword');
    assert.equal(preflight.length, 2);

    const postflight = applicableRules({ pass: 'postflight', policySnapshot: { rules } }, 'keyword');
    assert.equal(postflight.length, 2);
});

test('confidenceRank works as expected', () => {
    assert.equal(confidenceRank('high'), 3);
    assert.equal(confidenceRank('medium'), 2);
    assert.equal(confidenceRank('low'), 1);
});
