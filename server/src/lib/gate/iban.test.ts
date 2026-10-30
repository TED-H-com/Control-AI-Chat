import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ibanValid, supportedIbanCountries } from './iban.js';

test('ibanValid identifies valid and invalid IBANs', () => {
    assert.equal(ibanValid('DE89370400440532013000'), true);
    assert.equal(ibanValid('DE89 3704 0044 0532 0130 00'), true);
    assert.equal(ibanValid('de89370400440532013000'), true);
    assert.equal(ibanValid('DE88370400440532013000'), false);
    assert.equal(ibanValid('DE8937040044053201300'), false);
    assert.equal(ibanValid('XX89370400440532013000'), false);

    assert.ok(supportedIbanCountries.includes('DE'));
    assert.ok(!supportedIbanCountries.includes('XX'));
});
