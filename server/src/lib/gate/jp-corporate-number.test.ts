import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jpCorporateNumberValid } from './jp-corporate-number.js';

test('jpCorporateNumberValid identifies valid and invalid Japan Corporate Numbers', () => {
    assert.equal(jpCorporateNumberValid('7123456789012'), true);
    assert.equal(jpCorporateNumberValid('8123456789012'), false);
    assert.equal(jpCorporateNumberValid('712345678901'), false);
    assert.equal(jpCorporateNumberValid('71234567890123'), false);
    assert.equal(jpCorporateNumberValid('abcdefghijklm'), false);
});
