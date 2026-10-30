import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultGateEngine } from './engine.js';

test('DefaultGateEngine evaluates policies', async () => {
    const engine = new DefaultGateEngine({
        detectors: [{
            id: 'mock', stage: 10, kind: 'keyword', supportedPasses: new Set(['preflight']),
            failureMode: 'closed', timeoutMs: 1000,
            detect: async () => ({ matches: [], degraded: false, cacheStatus: 'not_applicable', diagnostics: [], elapsedUs: 0 })
        } as any]
    });

    const context = {
        pass: 'preflight', evaluationId: 'eval1', nowMs: 1000, subject: { tenantId: 't1', userId: 'u1' },
        policySnapshot: { tenantId: 't1', snapshotId: 'snap1', fingerprint: 'fp', rules: [] },
        parts: [{ id: 'p1', text: 'test content' }], abortSignal: new AbortController().signal, metadata: {}
    } as any;

    const verdict = await engine.evaluate(context);
    assert.equal(verdict.action, 'allow');
    assert.equal(verdict.disposition, 'allow_provider_call');
});
