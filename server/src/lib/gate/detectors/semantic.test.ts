import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SemanticDetector } from './semantic.js';

test('SemanticDetector queries classifier and respects budget', async () => {
    let classifyCalled = 0;
    const classifier = {
        classify: async () => {
            classifyCalled++;
            return { schemaVersion: 1, matched: true, confidence: 0.9, category: 'test_cat', rationaleCode: 'test_rat', evidenceOrdinals: [0], costMicroUsd: 100 };
        }
    };
    const detector = new SemanticDetector(classifier as any, new Uint8Array([1, 2, 3]));

    const rule = {
        id: 'r1', revision: 1, detectorKind: 'semantic_policy', action: 'block', passMask: 'both',
        priority: 1, scopeType: 'org', scopeId: 'tenant1', failureMode: 'escalate', sourceOrder: 1,
        config: { policyText: 'No sharing secrets', minimumConfidence: 0.8, dailyRequestLimit: 1, dailyCostMicroUsdLimit: 1000 }
    };

    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'p1', text: 'my secret password' }],
        policySnapshot: { rules: [rule] },
        pass: 'postflight',
        nowMs: 1000
    } as any;

    const result1 = await detector.detect(context);
    assert.equal(result1.cacheStatus, 'miss');
    assert.equal(result1.matches.length, 1);
    assert.equal(result1.matches[0]!.category, 'test_cat');
    assert.equal(classifyCalled, 1);

    const result2 = await detector.detect(context);
    assert.equal(result2.cacheStatus, 'hit');
    assert.equal(result2.matches.length, 1);
    assert.equal(classifyCalled, 1);

    const contextBudget = { ...context, parts: [{ id: 'p2', text: 'different text' }] };
    const result3 = await detector.detect(contextBudget);
    assert.equal(result3.cacheStatus, 'miss');
    assert.equal(result3.degraded, true);
    assert.ok(result3.diagnostics.includes('classifier_budget_exhausted'));
    assert.equal(classifyCalled, 1);
});
