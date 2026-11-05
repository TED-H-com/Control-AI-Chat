import { test } from 'node:test';
import { deduplicateMatches } from './action.js';
import { performance } from 'node:perf_hooks';

test('deduplicateMatches benchmark', () => {
    const matches = Array.from({ length: 100000 }, (_, i) => ({
        ruleId: `rule${i % 100}`,
        partId: `part${i % 10}`,
        span: i % 2 === 0 ? { start: i, end: i + 5 } : null,
        category: `cat${i % 50}`
    })) as any[];

    const start = performance.now();
    deduplicateMatches(matches);
    const end = performance.now();
    console.log(`deduplicateMatches took ${end - start} ms for ${matches.length} matches`);
});
