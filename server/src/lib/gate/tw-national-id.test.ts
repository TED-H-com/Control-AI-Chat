import assert from 'node:assert/strict';
import { test } from 'node:test';
import { twNationalIdValid } from './tw-national-id.js';

test('twNationalIdValid correctly identifies valid Taiwan National IDs', () => {
    assert.equal(twNationalIdValid('A123456789'), true);
    assert.equal(twNationalIdValid('B123456780'), true);
    assert.equal(twNationalIdValid('B123456781'), false);
    assert.equal(twNationalIdValid('a123456789'), true);
    assert.equal(twNationalIdValid('1123456789'), false);
    assert.equal(twNationalIdValid('A323456789'), false);
    assert.equal(twNationalIdValid('A12345678'), false);
    assert.equal(twNationalIdValid('A1234567890'), false);
});
