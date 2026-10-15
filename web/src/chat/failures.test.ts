// @ts-nocheck -- production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ERROR_REASONS} from '@shared/types';
import {createTranslator} from '../i18n/runtime.js';
import {chatFailureCanRetry,chatFailureText} from './failures.js';
import {MessageList} from './MessageList.js';
import {RunFailureNotice} from './RunFailureNotice.js';

const sentinel='SERVER-TEXT-SENTINEL';
const envelope=(code,reason=null,retryable=true)=>({code,message:sentinel,requestId:'request-1',retryable,...(reason?{details:{reason}}:{})});
const count=(text,needle)=>text.split(needle).length-1;
const prompt={id:'prompt',conversationId:'conversation-1',parentMessageId:null,role:'user',content:'Question',modelId:null,provider:null,createdAt:'2026-09-29T12:00:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};
const gate=(direction)=>({decisionId:`${direction}-decision`,action:'block',direction,detectorCount:1,protectedItemCount:1,approvalId:null,userNotice:sentinel});
const listProps=(t)=>({messages:[prompt],models:[],showMetadata:false,locale:'en',t,onEdit:()=>{},onRegenerate:()=>{},streamPhase:'error'});

test('chat failure text prefers reason, then code, then HTTP status, then interrupted text without rendering server text',()=>{
 for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale),cases=[
  [{kind:'run',error:envelope('INTERNAL_ERROR','chat_context_too_large'),partialMessageId:'reply'},t('errors.reason.chat_context_too_large')],
  [{kind:'api',error:envelope('RATE_LIMITED'),status:429},t('errors.code.rateLimited')],
  [{kind:'status',status:503},t('errors.status.server')],
  [{kind:'interrupted'},t('chat.state.streamError')],
 ];for(const [failure,expected] of cases){const text=chatFailureText(failure,t);assert.equal(text,expected);assert.doesNotMatch(text,/SERVER-TEXT-SENTINEL/);}}
});

test('Retry is offered only where the recorded retry can make progress',()=>{
 assert.equal(chatFailureCanRetry({kind:'api',status:500,error:envelope('INTERNAL_ERROR',null,false)}),true,'pre-stream INTERNAL_ERROR ignores the envelope default');
 assert.equal(chatFailureCanRetry({kind:'api',status:429,error:envelope('RATE_LIMITED',null,true)}),true);
 assert.equal(chatFailureCanRetry({kind:'run',error:envelope('BUDGET_HARD_LIMIT'),partialMessageId:'reply'}),false);
 assert.equal(chatFailureCanRetry({kind:'run',error:envelope('PROVIDER_UNAVAILABLE','chat_provider_not_allowed',false),partialMessageId:'reply'}),false);
 assert.equal(chatFailureCanRetry({kind:'run',error:envelope('INTERNAL_ERROR'),partialMessageId:null}),false);
 assert.equal(chatFailureCanRetry({kind:'status',status:502}),true);assert.equal(chatFailureCanRetry({kind:'status',status:422}),false);assert.equal(chatFailureCanRetry({kind:'interrupted'}),true);
});

test('each failure kind renders its localized refusal text exactly once in the response entry',()=>{
 for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale);for(const failure of [
  {kind:'run',error:envelope('PROVIDER_UNAVAILABLE'),partialMessageId:'reply'},
  {kind:'api',status:429,error:envelope('RATE_LIMITED')},
  {kind:'status',status:502},
  {kind:'interrupted'},
 ]){const expected=chatFailureText(failure,t),html=renderToStaticMarkup(createElement(MessageList,{...listProps(t),locale,failure,retry:{path:'/retry',body:{}},onRetry:()=>{}}));assert.equal(count(html,expected),1,`${locale}:${failure.kind}`);assert.equal(count(html,'ui-response-row'),1);assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/);}}
});

test('RunFailureNotice offers Retry only when the failure rule does',()=>{
 const t=createTranslator('en'),request={path:'/retry',body:{}};
 const retryable=renderToStaticMarkup(createElement(RunFailureNotice,{failure:{kind:'api',status:500,error:envelope('INTERNAL_ERROR',null,false)},retry:request,onRetry:()=>{},t}));
 const permanent=renderToStaticMarkup(createElement(RunFailureNotice,{failure:{kind:'run',error:envelope('BUDGET_HARD_LIMIT'),partialMessageId:'reply'},retry:request,onRetry:()=>{},t}));
 assert.equal((retryable.match(/<button/g)??[]).length,1);assert.doesNotMatch(permanent,/<button/);
});

test('a bare HTTP 429 renders an enabled Retry action',()=>{
 const t=createTranslator('en'),request={path:'/retry',body:{clientRequestId:'same-request'}},html=renderToStaticMarkup(createElement(RunFailureNotice,{failure:{kind:'status',status:429},retry:request,onRetry:()=>{},t}));
 assert.match(html,/<button[^>]*>Try again<\/button>/u);assert.doesNotMatch(html,/<button[^>]*disabled/u);
});

test('non-gate failure cards use a distinct localized title in every locale',()=>{
 for(const locale of ['en','zh-TW','ja']){
  const t=createTranslator(locale),failure={kind:'run',error:envelope('INTERNAL_ERROR'),partialMessageId:'reply'},title=t('chat.failure.title'),body=chatFailureText(failure,t);
  const html=renderToStaticMarkup(createElement(RunFailureNotice,{failure,retry:null,onRetry:()=>{},t}));
  assert.notEqual(title,body,locale);assert.ok(html.includes(`<strong>${title}</strong>`),locale);assert.ok(html.includes(`<p>${body}</p>`),locale);
 }
});

test('an outbound block renders only the prompt receipt and no response row',()=>{
 const t=createTranslator('en'),failure={kind:'run',error:envelope('GATE_BLOCKED',null,false),partialMessageId:null};
 const html=renderToStaticMarkup(createElement(MessageList,{...listProps(t),failure,liveGate:gate('outbound')}));
 assert.equal(count(html,'ui-prompt-row'),1);assert.equal(count(html,'ui-response-row'),0);assert.equal(count(html,t('chat.gate.blocked.title')),1);assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/);
});

test('an inbound block clears streamed text and renders one withheld receipt even without a gate notice',()=>{
 const t=createTranslator('en'),failure={kind:'run',error:envelope('GATE_BLOCKED',null,false),partialMessageId:'reply'};
 for(const liveResponseGate of [null,gate('inbound')]){const html=renderToStaticMarkup(createElement(MessageList,{...listProps(t),failure,liveResponseGate,streamText:'restricted response'}));assert.equal(count(html,t('chat.gate.response.withheld.title')),1);assert.doesNotMatch(html,/restricted response|SERVER-TEXT-SENTINEL/);}
});

test('every shared chat error reason has localized reader text in all locales',()=>{
 for(const reason of ERROR_REASONS.filter(value=>value.startsWith('chat_')))for(const locale of ['en','zh-TW','ja'])assert.notEqual(createTranslator(locale)(`errors.reason.${reason}`),`errors.reason.${reason}`);
});
