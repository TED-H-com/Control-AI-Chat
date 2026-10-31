import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicDetectors, detectorRegistry } from './registry.js';
import { SemanticDetector } from './detectors/semantic.js';

test('deterministicDetectors returns the standard list of detectors sorted by stage', () => {
    const detectors = deterministicDetectors();
    assert.ok(detectors.length > 0);
    for (let i = 1; i < detectors.length; i++) {
        const prev = detectors[i - 1];
        const current = detectors[i];
        assert.ok(prev!.stage <= current!.stage);
    }
});

test('detectorRegistry includes semantic detector if configured', () => {
    const withoutSemantic = detectorRegistry();
    assert.ok(!withoutSemantic.some((d: any) => d instanceof SemanticDetector));

    const withSemantic = detectorRegistry({
        classifier: {} as any,
        semanticCacheSecret: new Uint8Array([1,2,3])
    });
    assert.ok(withSemantic.some((d: any) => d instanceof SemanticDetector));
});
