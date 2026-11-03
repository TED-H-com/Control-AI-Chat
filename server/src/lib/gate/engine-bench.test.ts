import { test } from 'node:test';
import { DefaultGateEngine } from './engine.js';
import { performance } from 'node:perf_hooks';

test('engine benchmark', async () => {
    const engine = new DefaultGateEngine({
        detectors: [{
            id: 'mock', stage: 10, kind: 'keyword', supportedPasses: new Set(['preflight']),
            failureMode: 'closed', timeoutMs: 1000,
            detect: async () => ({ matches: [], degraded: false, cacheStatus: 'not_applicable', diagnostics: [], elapsedUs: 0 })
        } as any],
        maxPartCodePoints: 2000000,
        maxAggregateCodePoints: 4000000
    });

    const context = {
        pass: 'preflight', evaluationId: 'eval1', nowMs: 1000, subject: { tenantId: 't1', userId: 'u1' },
        policySnapshot: { tenantId: 't1', snapshotId: 'snap1', fingerprint: 'fp', rules: [] },
        parts: [{ id: 'p1', text: 'test content'.repeat(100000) }], abortSignal: new AbortController().signal, metadata: {}
    } as any;

    const start = performance.now();
    await engine.evaluate(context);
    const end = performance.now();
    console.log(`engine evaluate took ${end - start} ms`);
});
