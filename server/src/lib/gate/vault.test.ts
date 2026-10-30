import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeMaskReplacement, maskWithoutVault, StatelessGateVault } from './vault.js';

test('sanitizeMaskReplacement cleans replacements', () => {
    assert.equal(sanitizeMaskReplacement('xxx'), 'xxx');
    assert.equal(sanitizeMaskReplacement('⟦REDACTED:stuff⟧'), 'stuff');
    assert.equal(sanitizeMaskReplacement(''), '[MASKED]');
    assert.equal(sanitizeMaskReplacement(123), '[MASKED]');
});

test('maskWithoutVault applies masking without redactions', () => {
    const context = {
        parts: [{ id: 'p1', text: 'Hello secret world' }],
        policySnapshot: { rules: [{ id: 'r1', config: { maskReplacement: '***' } }] }
    } as any;

    const matches = [{
        partId: 'p1', ruleId: 'r1', action: 'mask',
        span: { start: 6, end: 12 }
    }] as any;

    const result = maskWithoutVault(context, matches);
    assert.equal(result.parts[0]!.text, 'Hello *** world');
    assert.equal(result.masks.length, 1);
});

test('StatelessGateVault applies redactions correctly', async () => {
    const vault = new StatelessGateVault();
    const context = {
        parts: [{ id: 'p1', text: 'Hello secret world' }],
        policySnapshot: { rules: [{ id: 'r1', config: { } }] }
    } as any;

    const matches = [{
        partId: 'p1', ruleId: 'r1', action: 'redact',
        span: { start: 6, end: 12 }, replacementLabel: 'SECRET'
    }] as any;

    const result = await vault.redact(context, matches);
    assert.ok(result.parts[0]!.text.includes('⟦REDACTED:SECRET:'));
    assert.equal(result.redactions.length, 1);
});
