import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceCodeDetector } from './source-code.js';

test('SourceCodeDetector detects source code in text', async () => {
    const detector = new SourceCodeDetector();
    const context = {
        subject: { tenantId: 'tenant1' },
        parts: [{ id: 'part1', text: 'import React from "react";\n\nfunction App() {\n  return <div>Hello</div>;\n}\n\nexport default App;' }],
        policySnapshot: {
            rules: [{
                id: 'rule1', detectorKind: 'source_code', scopeType: 'org', scopeId: 'tenant1',
                passMask: 'both', priority: 1, action: 'block', config: { minimumLines: 5, minimumScore: 6 },
                failureMode: 'closed', sourceOrder: 1
            }]
        },
        pass: 'postflight'
    } as any;

    const result = await detector.detect(context);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]!.category, 'source_code');
    assert.ok(result.elapsedUs >= 0);
});
