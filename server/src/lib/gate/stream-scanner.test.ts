import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostflightScanner } from './stream-scanner.js';
import { GateEngine } from './types.js';

test('PostflightScanner basic streaming logic', async () => {
    let mockDispositions: any[] = [];
    const mockEngine: GateEngine = {
        evaluate: async (ctx: any) => {
            const disp = mockDispositions.shift();
            return disp || { disposition: 'allowed', matches: [], redactions: [], masks: [], displayParts: [{text: ctx.parts[0].text}], messages: [], warnings: [] };
        }
    } as unknown as GateEngine;
    const context = { parts: [{ text: '' }], evaluationId: 'test-eval' } as any;

    const scanner = new PostflightScanner(mockEngine, context, 2);

    mockDispositions.push({ disposition: 'allowed', matches: [], redactions: [], masks: [], displayParts: [{text: 'abcd'}] });
    let events = await scanner.pushCumulative('abcd');
    assert.equal(events.length, 1);
    assert.equal((events[0] as any).type, 'release');
    assert.equal((events[0] as any).text, 'ab');

    mockDispositions.push({ disposition: 'allowed', matches: [], redactions: [], masks: [], displayParts: [{text: 'abcd'}] });
    events = await scanner.finish();
    assert.ok(events.length >= 2);
    assert.equal((events[0] as any).type, 'release');
    assert.equal((events[0] as any).text, 'cd');
});
