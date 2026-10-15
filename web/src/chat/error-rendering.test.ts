// @ts-nocheck -- production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTranslator} from '../i18n/runtime.js';
import {RunFailureNotice} from './RunFailureNotice.js';

test('run.failed renders localized text and never the server message in every locale',()=>{
 const error={code:'PROVIDER_UNAVAILABLE',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:true};
 for(const locale of ['en','zh-TW','ja']){
  const t=createTranslator(locale),failure={kind:'run',error,partialMessageId:'reply'},html=renderToStaticMarkup(createElement(RunFailureNotice,{failure,retry:{path:'/retry',body:{}},t,onRetry:()=>{}}));
  assert.ok(html.includes(t('errors.code.providerUnavailable')),locale);
  assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/u,locale);
 }
});

test('a pre-stream hard-budget refusal is localized and omits Retry in every locale',()=>{
 const error={code:'BUDGET_HARD_LIMIT',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false};
 for(const locale of ['en','zh-TW','ja']){
  const t=createTranslator(locale),failure={kind:'api',status:422,error},html=renderToStaticMarkup(createElement(RunFailureNotice,{failure,retry:null,t,onRetry:()=>{}}));
  assert.ok(html.includes(t('errors.code.budgetHard')),locale);
  assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL|<button/u,locale);
 }
});

test('an in-stream provider policy refusal is localized and omits Retry in every locale',()=>{
 const error={code:'PROVIDER_UNAVAILABLE',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false,details:{reason:'chat_provider_not_allowed'}};
 for(const locale of ['en','zh-TW','ja']){
  const t=createTranslator(locale),failure={kind:'run',error,partialMessageId:'reply'},html=renderToStaticMarkup(createElement(RunFailureNotice,{failure,retry:null,t,onRetry:()=>{}}));
  assert.ok(html.includes(t('errors.reason.chat_provider_not_allowed')),locale);
  assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL|<button/u,locale);
 }
});
