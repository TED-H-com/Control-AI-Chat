// @ts-nocheck -- production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ERROR_REASONS} from '@shared/types';
import {ApiClientError} from './api.js';
import {errorMessageKey,REASON_MESSAGE_KEYS} from './error-message.js';
import {createTranslator} from './i18n/runtime.js';

const api=(status,code,reason)=>new ApiClientError(status,{error:{code,message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false,...(reason?{details:{reason}}:{})}});

test('localized error mapping prefers reason, then code, then status, then generic',()=>{
 assert.equal(errorMessageKey(api(503,'BUDGET_HARD_LIMIT','email_taken')),'errors.reason.email_taken');
 assert.equal(errorMessageKey(api(503,'BUDGET_HARD_LIMIT','future_reason')),'errors.code.budgetHard');
 assert.equal(errorMessageKey(api(422,'FUTURE_CODE')),'errors.status.validation');
 assert.equal(errorMessageKey(api(418,'FUTURE_CODE')),'errors.status.client');
 assert.equal(errorMessageKey(new Error('SERVER-TEXT-SENTINEL')),'errors.code.generic');
});

test('every server reason has one distinct localized message in all locales',()=>{
 assert.deepEqual(Object.keys(REASON_MESSAGE_KEYS).sort(),[...ERROR_REASONS].sort());
 const keys=Object.values(REASON_MESSAGE_KEYS);
 assert.equal(new Set(keys).size,keys.length,'different causes must not share a message key');
 for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale),messages=ERROR_REASONS.map(reason=>t(REASON_MESSAGE_KEYS[reason]));
  assert.ok(messages.every(message=>message&&!message.includes('SERVER-TEXT-SENTINEL')&&!message.startsWith('errors.')),locale);
  assert.equal(new Set(messages).size,messages.length,`${locale} must give every reason distinct text`);
 }
});
