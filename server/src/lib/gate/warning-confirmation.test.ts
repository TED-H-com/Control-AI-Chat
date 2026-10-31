import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { verifyWarningToken, redeemWarningConfirmation } from './warning-confirmation.js';

test('verifyWarningToken handles correct and incorrect tokens', () => {
    const secret = new Uint8Array(32);
    secret.fill(1);

    const validPayload = Buffer.from(JSON.stringify({
        e: 'eval1', u: 'user1', p: 'fingerprint1', x: 1000
    })).toString('base64url');
    const validSignature = createHmac('sha256', secret).update(validPayload).digest('base64url');
    const validToken = `${validPayload}.${validSignature}`;

    const result = verifyWarningToken(validToken, { secret, userId: 'user1', policyFingerprint: 'fingerprint1', nowMs: 500 });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.claims.evaluationId, 'eval1');
    }

    assert.equal(verifyWarningToken(validToken, { secret, userId: 'user1', policyFingerprint: 'fingerprint1', nowMs: 1001 }).ok, false);
    assert.equal(verifyWarningToken(validToken, { secret, userId: 'user2', policyFingerprint: 'fingerprint1', nowMs: 500 }).ok, false);
    assert.equal(verifyWarningToken(validToken, { secret, userId: 'user1', policyFingerprint: 'fingerprint2', nowMs: 500 }).ok, false);

    const badSignatureToken = `${validPayload}.badsignature`;
    assert.equal(verifyWarningToken(badSignatureToken, { secret, userId: 'user1', policyFingerprint: 'fingerprint1', nowMs: 500 }).ok, false);
});
