import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint } from './fingerprint.js';
import { createHmac } from 'node:crypto';

test('fingerprint creates consistent HMAC SHA256 of value using tenantId', () => {
    const tenantId = 'test-tenant';
    const value = 'test-value';
    const expected = createHmac('sha256', tenantId).update(value).digest('hex');
    assert.equal(fingerprint(tenantId, value), expected);

    const normalizedExpected = createHmac('sha256', tenantId).update('\u1E9B\u0323'.normalize('NFKC')).digest('hex');
    assert.equal(fingerprint(tenantId, '\u1E9B\u0323'), normalizedExpected);
});
