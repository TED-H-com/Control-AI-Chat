import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeywordDetector, validateRegex } from './keyword.js';

test('KeywordDetector detects keywords correctly', async () => {
    const detector = new KeywordDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'keyword', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'closed', sourceOrder: 1,
        config: { terms: ['secret', 'password'], caseSensitive: false, wholeWord: true, maxMatches: 10 }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'This is a SECRET password.' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every((m: any) => m.category === 'blocked_term'));
});

test('KeywordDetector regex validation throws', () => {
    assert.throws(() => validateRegex('.*'), /gate_regex_engine_unavailable/);
});
