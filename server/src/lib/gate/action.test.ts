import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strongestAction, deduplicateMatches } from './action.js';

test('strongestAction returns the action with highest rank', () => {
    assert.equal(strongestAction([]), 'allow');
    assert.equal(strongestAction([{ action: 'flag' }] as any), 'flag');
    assert.equal(strongestAction([{ action: 'flag' }, { action: 'block' }, { action: 'warn' }] as any), 'block');
});

test('deduplicateMatches removes duplicate matches', () => {
    const matches = [
        { ruleId: '1', partId: 'p1', span: { start: 0, end: 5 }, category: 'cat1' },
        { ruleId: '1', partId: 'p1', span: { start: 0, end: 5 }, category: 'cat1' },
        { ruleId: '2', partId: 'p1', span: { start: 0, end: 5 }, category: 'cat1' },
        { ruleId: '1', partId: 'p1', span: null, category: 'cat1' },
        { ruleId: '1', partId: 'p1', span: null, category: 'cat1' }
    ] as any;

    const deduplicated = deduplicateMatches(matches);
    assert.equal(deduplicated.length, 3);
});
