import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeExcerpt, maskedLastFour } from './excerpts.js';

test('safeExcerpt correctly generates an excerpt', () => {
    const text = 'This is a long test string that contains some secret token inside of it.';
    const span = { start: 46, end: 58 };
    assert.ok(safeExcerpt(text, span, 'REDACTED').includes('[REDACTED]'));
    assert.ok(safeExcerpt(text, span, 'REDACTED', ':abc').includes('[REDACTED:abc]'));
});

test('maskedLastFour extracts the last four digits', () => {
    assert.equal(maskedLastFour('1234567890'), '7890');
    assert.equal(maskedLastFour('12ab34cd56ef78'), '5678');
    assert.equal(maskedLastFour('123'), '123');
    assert.equal(maskedLastFour('abc'), '');
});
