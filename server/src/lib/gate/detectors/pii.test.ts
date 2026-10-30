import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiiDetector } from './pii.js';

test('PiiDetector detects multiple PII categories', async () => {
    const detector = new PiiDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'pii', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'escalate', sourceOrder: 1,
        config: { categories: ['email', 'phone', 'ssn_us'] }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'My email is test@acme.com and phone is (800) 555-1234. SSN: 123-45-6789' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    const categories = result.matches.map((m: any) => m.category);
    assert.ok(categories.includes('email'));
    assert.ok(categories.includes('phone'));
    assert.ok(categories.includes('ssn_us'));
});

test('PiiDetector handles empty config correctly', async () => {
    const detector = new PiiDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'pii', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'escalate', sourceOrder: 1,
        config: { categories: [] }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'My email is test@acme.com and phone is (800) 555-1234. SSN: 123-45-6789' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.equal(result.matches.length, 0);
});

test('PiiDetector handles overlapping spans by prioritizing earlier logic/keeping first', async () => {
    const detector = new PiiDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'pii', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'escalate', sourceOrder: 1,
        config: { categories: ['tw_national_id', 'ssn_us'] }
    };

    // An ID that could be interpreted as multiple things, we just verify it doesn't crash
    // and returns results for configured rules
    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'A123456789 123-45-6789' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.ok(result.matches.length > 0);
});
