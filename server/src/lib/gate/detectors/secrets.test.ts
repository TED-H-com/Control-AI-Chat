import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretDetector } from './secrets.js';

test('SecretDetector identifies various secrets', async () => {
    const detector = new SecretDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'secret', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'closed', sourceOrder: 1,
        config: { categories: ['aws_access_key', 'api_token', 'private_key'] }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'AWS key is AKIA1234567890123456\n-----BEGIN PRIVATE KEY-----\nsecretstuff\n-----END PRIVATE KEY-----' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.equal(result.matches.length, 2);

    const categories = result.matches.map((m: any) => m.category);
    assert.ok(categories.includes('aws_access_key'));
    assert.ok(categories.includes('private_key'));
});
