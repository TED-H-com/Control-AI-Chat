import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vinValid } from './vin.js';

test('vinValid identifies valid and invalid VINs', () => {
    assert.equal(vinValid('1234567890123456'), false);
    assert.equal(vinValid('1M8GDM9AIKP042788'), false);
    assert.equal(vinValid('1M8GDM9A0KP042788'), false);
});
