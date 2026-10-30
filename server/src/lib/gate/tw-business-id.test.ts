import assert from 'node:assert/strict';
import { test } from 'node:test';
import { twBusinessIdValid } from './tw-business-id.js';

test('twBusinessIdValid correctly identifies valid Taiwan Business Registration Numbers', () => {
    assert.equal(twBusinessIdValid('04595257'), true);
    assert.equal(twBusinessIdValid('10458575'), true);
    assert.equal(twBusinessIdValid('04595252'), true);
    assert.equal(twBusinessIdValid('12345678'), false);
    assert.equal(twBusinessIdValid('1234567'), false);
    assert.equal(twBusinessIdValid('123456789'), false);
    assert.equal(twBusinessIdValid('abcdefgh'), false);
});
