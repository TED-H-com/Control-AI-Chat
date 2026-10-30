import assert from 'node:assert/strict';
import { test } from 'node:test';
import { luhnValid } from './luhn.js';

test('luhnValid identifies valid and invalid Luhn sequences', () => {
    assert.equal(luhnValid('79927398713'), true);
    assert.equal(luhnValid('49927398716'), true);
    assert.equal(luhnValid('4992-7398-716'), true);
    assert.equal(luhnValid('79927398714'), false);
    assert.equal(luhnValid('1234567'), false);
    assert.equal(luhnValid('11111111'), false);
});
