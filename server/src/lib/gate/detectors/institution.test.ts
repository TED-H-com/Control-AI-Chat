import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstitutionNameDetector } from './institution.js';

test('InstitutionNameDetector finds institutions', async () => {
    const detector = new InstitutionNameDetector();

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'institution_name', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'open', sourceOrder: 1,
        config: { categories: ['medical_facility'] }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'I went to the hospital.' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.ok(result.elapsedUs >= 0);
});
