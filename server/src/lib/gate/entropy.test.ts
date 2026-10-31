import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shannonEntropy, isLikelySecretToken } from './entropy.js';

test('shannonEntropy calculates entropy correctly', () => {
    assert.equal(shannonEntropy(''), 0);
    assert.equal(shannonEntropy('a'), 0);
    assert.equal(shannonEntropy('aa'), 0);
    assert.equal(shannonEntropy('ab'), 1);
    assert.equal(shannonEntropy('aabb'), 1);
    assert.equal(shannonEntropy('abcd'), 2);
});

test('isLikelySecretToken identifies potential secrets', () => {
    assert.equal(isLikelySecretToken('abcd', 20, 1), false);
    assert.equal(isLikelySecretToken('550e8400-e29b-41d4-a716-446655440000'), false);
    assert.equal(isLikelySecretToken('a'.repeat(40)), false);
    assert.equal(isLikelySecretToken('YOUR_SUPER_SECRET_TOKEN_HERE', 20, 1), false);
    assert.equal(isLikelySecretToken('SOME_REDACTED_VALUE_HERE_WOW', 20, 1), false);

    const randomHighEntropy = 'U2VjcmV0VG9rZW5WYWx1ZVRoYXRJc0xvbmc=';
    assert.equal(isLikelySecretToken(randomHighEntropy, 20, 3.5), true);

    const randomLowEntropy = 'aaaaaaaaabbbbbbbbbcccccccccc';
    assert.equal(isLikelySecretToken(randomLowEntropy, 20, 3.5), false);
});
