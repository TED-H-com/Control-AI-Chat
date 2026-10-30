import assert from 'node:assert/strict';
import { test } from 'node:test';
import { twResidentIdValid } from './tw-resident-id.js';

test('twResidentIdValid correctly identifies valid Taiwan Resident IDs', () => {
    assert.equal(twResidentIdValid('AC12345679'), true);
    assert.equal(twResidentIdValid('AD12345671'), true);
    assert.equal(twResidentIdValid('A823456783'), true);
    assert.equal(twResidentIdValid('A923456785'), true);

    assert.equal(twResidentIdValid('AC12345678'), false);
    assert.equal(twResidentIdValid('AD12345672'), false);
    assert.equal(twResidentIdValid('A823456784'), false);
    assert.equal(twResidentIdValid('A923456786'), false);

    assert.equal(twResidentIdValid('a823456783'), true);
    assert.equal(twResidentIdValid('ac12345679'), true);

    assert.equal(twResidentIdValid('A723456783'), false);
    assert.equal(twResidentIdValid('AE12345679'), false);
    assert.equal(twResidentIdValid('1234567890'), false);
    assert.equal(twResidentIdValid('A82345678'), false);
    assert.equal(twResidentIdValid('A8234567830'), false);
});
