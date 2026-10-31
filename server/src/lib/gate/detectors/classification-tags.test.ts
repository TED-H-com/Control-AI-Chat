import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassificationTagDetector } from './classification-tags.js';

test('ClassificationTagDetector finds classification tags', async () => {
    const detector = new ClassificationTagDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'classification_tag', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'closed', sourceOrder: 1,
        config: { blockedLevels: ['restricted', 'confidential'], documentHeaderLines: 10 }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'Classification: RESTRICTED\n\nSome content' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.category, 'restricted');
});
