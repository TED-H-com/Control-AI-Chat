import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AhoCorasick } from './aho-corasick.js';

test('AhoCorasick finds string matches correctly', () => {
    const ac = new AhoCorasick(['he', 'she', 'his', 'hers']);
    const matches = ac.search('ushers');
    assert.equal(matches.length, 3);

    assert.ok(matches.some(m => m.termId === 1 && m.start === 1 && m.end === 4));
    assert.ok(matches.some(m => m.termId === 0 && m.start === 2 && m.end === 4));
    assert.ok(matches.some(m => m.termId === 3 && m.start === 2 && m.end === 6));
});

test('AhoCorasick throws on empty term', () => {
    assert.throws(() => new AhoCorasick(['hello', '']), /gate_empty_term/);
});

test('AhoCorasick limits results to max', () => {
    const ac = new AhoCorasick(['a']);
    const matches = ac.search('aaaaa', 2);
    assert.equal(matches.length, 2);
});
