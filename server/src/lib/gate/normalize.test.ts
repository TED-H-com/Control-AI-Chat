import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeText, codePointIndex, clearCodePointIndexCache, sliceCodePoints, cpSpan } from './normalize.js';

test('normalizeText normalizes and maps correctly', () => {
    const original = 'Tｅsｔ sｔrｉng with \u1E9B\u0323';
    const normalized = normalizeText(original);

    assert.equal(normalized.original, original);
    assert.equal(normalized.nfkc.startsWith('Test string'), true);

    const span = normalized.toOriginalSpan({ start: 0, end: 4 });
    assert.equal(span.start, 0);
    assert.equal(span.end, 4);
});

test('codePointIndex provides correct slicing and indexing', () => {
    const text = 'ab\uD83D\uDE00cd';
    const index = codePointIndex(text);

    assert.equal(index.length, 5);

    assert.equal(index.toCodePointOffset(0), 0);
    assert.equal(index.toCodePointOffset(1), 1);
    assert.equal(index.toCodePointOffset(2), 2);
    assert.equal(index.toCodePointOffset(3), 3);
    assert.equal(index.toCodePointOffset(4), 3);
    assert.equal(index.toCodePointOffset(5), 4);

    assert.equal(sliceCodePoints(text, { start: 1, end: 4 }), 'b\uD83D\uDE00c');
});

test('clearCodePointIndexCache clears cache', () => {
    clearCodePointIndexCache();
});
