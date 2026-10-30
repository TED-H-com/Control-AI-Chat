import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jpMyNumberValid } from './jp-my-number.js';

test('jpMyNumberValid identifies valid and invalid Japan My Numbers', () => {
    assert.equal(jpMyNumberValid('123456789018'), true);
    assert.equal(jpMyNumberValid('123456789019'), false);
    assert.equal(jpMyNumberValid('1234-5678-9018'), true);
    assert.equal(jpMyNumberValid('12345678901'), false);
    assert.equal(jpMyNumberValid('1234567890181'), false);
    assert.equal(jpMyNumberValid('abcdefghijkl'), false);
});
