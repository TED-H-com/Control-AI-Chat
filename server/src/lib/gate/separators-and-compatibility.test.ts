import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DefaultGateEngine,
  StatelessGateVault,
  deterministicDetectors,
  resolvePolicy
} from './index.js';
import { PiiDetector } from './detectors/pii.js';
import { KeywordDetector } from './detectors/keyword.js';
import type { GateAction, GateContext, ResolvedRule } from './types.js';

const now = Date.now(), tenant = randomUUID(), user = randomUUID();

function rule(kind: ResolvedRule['detectorKind'], action: GateAction, config: Record<string, unknown>): ResolvedRule {
  return {
    id: randomUUID(),
    revision: 1,
    name: kind,
    detectorKind: kind,
    action,
    passMask: 'both',
    priority: 100,
    scopeType: 'org',
    scopeId: tenant,
    config,
    failureMode: kind === 'source_code' || kind === 'institution_name' ? 'open' : kind === 'pii' || kind === 'prompt_injection' ? 'escalate' : 'closed',
    sourceOrder: 0
  };
}

function context(rules: readonly ResolvedRule[], text: string, pass: 'preflight' | 'postflight' = 'preflight'): GateContext {
  const subject = { tenantId: tenant, userId: user, groupIds: [], roles: ['member'] as const };
  return {
    evaluationId: randomUUID(),
    requestId: randomUUID(),
    pass,
    subject,
    conversationId: null,
    messageId: null,
    projectId: null,
    providerId: 'test',
    modelId: 'test',
    locale: 'en',
    nowMs: now,
    parts: [{ id: 'part', source: pass === 'preflight' ? 'user_prompt' : 'provider_response', text, mimeType: 'text/plain', fileId: null, provenance: {} }],
    policySnapshot: resolvePolicy({ tenantId: tenant, modelId: 'test', subject, pass, policyVersion: 1, rules, nowMs: now }),
    abortSignal: new AbortController().signal,
    confirmedWarningToken: null,
    metadata: {}
  };
}

const wideCard = '４５３２０１５１１２８３０３６６';

test('outbound card compatibility and redaction', async () => {
  const r = rule('pii', 'redact', { categories: ['credit_card'], minimumConfidence: 'medium' });
  const vault = new StatelessGateVault();
  const engine = new DefaultGateEngine({
    detectors: deterministicDetectors(),
    vault
  });
  const ascii = await engine.evaluate(context([r], 'before 4532015112830366 after'));
  const wide = await engine.evaluate(context([r], `before ${wideCard} after`));
  assert.equal(wide.action, ascii.action);
  assert.equal(wide.disposition, ascii.disposition);
  assert.deepEqual(wide.matches.map(x => x.category), ascii.matches.map(x => x.category));
  assert.deepEqual(wide.matches[0]?.span, { start: 7, end: 23 });
  assert.match(wide.providerParts![0]!.text, /^before ⟦REDACTED:CREDIT_CARD:[^⟧]+⟧ after$/u);
  assert.doesNotMatch(wide.providerParts![0]!.text, /[０-９]/u);
});

test('compatibility span after surrogate and expansion', async () => {
  const r = rule('pii', 'redact', { categories: ['credit_card'] });
  const result = await new PiiDetector().detect(context([r], `😀 ㈱ ${wideCard} end`));
  assert.deepEqual(result.matches[0]?.span, { start: 4, end: 20 });
});

test('full-width email', async () => {
  const r = rule('pii', 'redact', { categories: ['email'] });
  const detector = new PiiDetector();
  const ascii = await detector.detect(context([r], 'jane@corp.invalid'));
  const wide = await detector.detect(context([r], 'ｊａｎｅ＠ｃｏｒｐ．ｉｎｖａｌｉｄ'));
  assert.deepEqual(wide.matches.map(x => x.category), ascii.matches.map(x => x.category));
  assert.equal(wide.matches[0]?.category, 'email');
  assert.equal(wide.matches[0]?.normalizedFingerprint, ascii.matches[0]?.normalizedFingerprint);
});

test('ASCII spans and excerpts unchanged', async () => {
  const r = rule('pii', 'redact', { categories: ['credit_card', 'email'] });
  const result = await new PiiDetector().detect(context([r], 'jane@corp.invalid 4532015112830366'));
  assert.deepEqual(
    result.matches.map(x => ({ category: x.category, span: x.span, replacementLabel: x.replacementLabel })),
    [
      { category: 'email', span: { start: 0, end: 17 }, replacementLabel: 'EMAIL' },
      { category: 'credit_card', span: { start: 18, end: 34 }, replacementLabel: 'CREDIT_CARD' }
    ]
  );
});

test('credit card match ends at last digit without trailing space or hyphen', async () => {
  const r = rule('pii', 'redact', { categories: ['credit_card'], minimumConfidence: 'medium' });
  const detector = new PiiDetector();
  const hyphenated = await detector.detect(context([r], '4532015112830366-end'));
  assert.deepEqual(hyphenated.matches[0]?.span, { start: 0, end: 16 });
  const spaced = await detector.detect(context([r], '4532 0151 1283 0366 '));
  assert.deepEqual(spaced.matches[0]?.span, { start: 0, end: 19 });
});

test("this repository's Asian identifier categories detect compatibility forms", async () => {
  const categories = [
    'tw_national_id',
    'tw_resident_id',
    'tw_business_id',
    'jp_my_number',
    'jp_corporate_number',
    'jp_residence_card',
    'jp_drivers_license'
  ];
  const asciiText = '身分證字號 A123456789；居留證號 FC23456786；統一編號 22099131；個人番号 123456789018；法人番号 7000012050002；在留カード AB12345678CD；免許証番号 123456789012';
  const toFullWidth = (value: string) =>
    Array.from(value, ch => {
      const code = ch.codePointAt(0)!;
      return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
        ? String.fromCodePoint(code + 0xfee0)
        : ch;
    }).join('');
  const r = rule('pii', 'block', { categories, minimumConfidence: 'medium' });
  const detector = new PiiDetector();
  const asciiResult = await detector.detect(context([r], asciiText));
  const wideResult = await detector.detect(context([r], toFullWidth(asciiText)));
  for (const category of categories) {
    const asciiMatch = asciiResult.matches.find(match => match.category === category);
    const wideMatch = wideResult.matches.find(match => match.category === category);
    assert.ok(asciiMatch, `missing ASCII ${category}`);
    assert.ok(wideMatch, `missing compatibility ${category}`);
    assert.equal(wideMatch.category, asciiMatch.category, `category mismatch for ${category}`);
    assert.deepEqual(wideMatch.span, asciiMatch.span, `span mismatch for ${category}`);
    assert.equal(wideMatch.normalizedFingerprint, asciiMatch.normalizedFingerprint, `fingerprint mismatch for ${category}`);
  }
});

async function keyword(text: string, options: Record<string, unknown> = {}, terms = ['password']) {
  return (await new KeywordDetector().detect(context([rule('keyword', 'block', { terms, ...options })], text))).matches;
}

test('separators require opt-in', async () => {
  for (const value of ['p.a.s.s.w.o.r.d', 'p a s s w o r d', 'pass-word', 'pass\u200bword']) {
    const matches = await keyword(`!${value}!`, { allowSeparators: true });
    assert.equal(matches.length, 1, value);
    assert.deepEqual(matches[0]?.span, { start: 1, end: 1 + Array.from(value).length });
    for (const option of [{ allowSeparators: false }, {}]) {
      assert.equal((await keyword(value, option)).length, 0);
    }
  }
});

test('CJK separators', async () => {
  for (const value of ['機 密', '機・密']) {
    assert.equal((await keyword(value, { allowSeparators: true }, ['機密'])).length, 1);
  }
});

test('whole word boundaries', async () => {
  assert.equal((await keyword('compass-word', { allowSeparators: true, wholeWord: true })).length, 0);
  assert.equal((await keyword('x pass-word y', { allowSeparators: true, wholeWord: true })).length, 1);
});

test('merge and limit by position', async () => {
  const text = 'password and p-a-s-s-w-o-r-d';
  assert.deepEqual((await keyword(text, { allowSeparators: true })).map(x => x.span), [{ start: 0, end: 8 }, { start: 13, end: 28 }]);
  assert.deepEqual((await keyword(text, { allowSeparators: true, maxMatches: 1 })).map(x => x.span), [{ start: 0, end: 8 }]);
});

test('one-character term retains ordinary validation', async () => {
  for (const options of [{}, { allowSeparators: true }]) {
    await assert.rejects(keyword('x', options, ['x']), /gate_invalid_term/);
  }
});

test('separator matching uses the large-rule matcher and preserves case', async () => {
  const terms = ['password', ...Array.from({ length: 31 }, (_, i) => `unused${i}`)];
  assert.deepEqual((await keyword('PASSWORD p-a-s-s-w-o-r-d', { allowSeparators: true, caseSensitive: true }, terms)).map(x => x.span), [{ start: 9, end: 24 }]);
  assert.deepEqual((await keyword('p-a-s-s-w-o-r-d password', { allowSeparators: true, maxMatches: 1 }, terms)).map(x => x.span), [{ start: 0, end: 15 }]);
});

test('separator gap limit in both matchers', async () => {
  const three = 'p a s s   w o r d', four = 'p a s s    w o r d';
  for (const terms of [['password'], ['password', ...Array.from({ length: 31 }, (_, i) => `unused${i}`)]]) {
    assert.equal((await keyword(four, { allowSeparators: true }, terms)).length, 0);
    const ok = await keyword(three, { allowSeparators: true }, terms);
    assert.equal(ok.length, 1);
    assert.deepEqual(ok[0]?.span, { start: 0, end: Array.from(three).length });
  }
});

test('short Latin terms disable separator tolerance', async () => {
  assert.equal((await keyword('p.a.s.s', { allowSeparators: true }, ['pass'])).length, 0);
  assert.equal((await keyword('pass', { allowSeparators: true }, ['pass'])).length, 1);
  assert.equal((await keyword('p.a.s.s.w', { allowSeparators: true }, ['passw'])).length, 1);
});

test('CJK terms retain separator tolerance from two code points', async () => {
  assert.equal((await keyword('기 밀', { allowSeparators: true }, ['기밀'])).length, 1);
  assert.equal((await keyword('ヒ・ミ・ツ', { allowSeparators: true }, ['ヒミツ'])).length, 1);
});

test('gap check runs before match limit', async () => {
  assert.deepEqual((await keyword('p    assword and pass-word', { allowSeparators: true, maxMatches: 1 }, ['password'])).map(x => x.span), [{ start: 17, end: 26 }]);
});
