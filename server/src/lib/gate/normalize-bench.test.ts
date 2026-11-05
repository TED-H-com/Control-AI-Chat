import { test } from 'node:test';
import { normalizeText } from './normalize.js';
import { performance } from 'node:perf_hooks';

test('normalizeText benchmark', () => {
    const text = 'This is a test text with some special characters like ｅ and ｔ and \u1E9B\u0323. '.repeat(10000);
    const start = performance.now();
    normalizeText(text);
    const end = performance.now();
    console.log(`normalizeText took ${end - start} ms for ${text.length} characters`);
});
