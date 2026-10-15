// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiClientError } from '../api.js';
import { chatApi } from '../chat/api.js';
import { createTranslator } from '../i18n/runtime.js';
import { groupedTotpSecret, mfaErrorKind, MfaRecoveryPanel, MfaSetupPanel, normalizeSetupTotpCode, recoveryCodesText, safeOtpauthUri } from './MfaSettings.js';
import { PRODUCT_NAME } from '@shared/brand.js';

const setup={
  secret:'JBSWY3DPEHPK3PXP',
  otpauthUri:`otpauth://totp/${encodeURIComponent(`${PRODUCT_NAME}:user@example.test`)}?secret=JBSWY3DPEHPK3PXP&issuer=${encodeURIComponent(PRODUCT_NAME)}`,
  rotating:false,
};
const codes=Array.from({length:10},(_,index)=>`ABCD${index}-EFGH${index}`);

test('setup input, provisioning links, and recovery exports stay in exact server formats',()=>{
  assert.equal(normalizeSetupTotpCode(' 12-3x４45678 '),'123456');
  assert.equal(normalizeSetupTotpCode('１２３４５６'),'');
  assert.equal(groupedTotpSecret(setup.secret),'JBSW Y3DP EHPK 3PXP');
  assert.equal(safeOtpauthUri(setup.otpauthUri),setup.otpauthUri);
  assert.equal(safeOtpauthUri('https://example.test/enrol'),null);
  assert.equal(safeOtpauthUri('javascript:alert(1)'),null);
  assert.equal(recoveryCodesText(codes),codes.join('\n'));
});

test('recent-MFA errors are distinguished from ordinary setup failures without trusting message text',()=>{
  const error=code=>new ApiClientError(403,{error:{code,message:'server copy may change',requestId:'request-id',retryable:false}});
  assert.equal(mfaErrorKind(error('MFA_REQUIRED'),'setupError'),'recentRequired');
  assert.equal(mfaErrorKind(error('FORBIDDEN'),'setupError'),'setupError');
  assert.equal(mfaErrorKind(new Error('offline'),'verifyError'),'verifyError');
});

test('MFA settings API uses authenticated identity routes without claiming replay idempotency',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  const replies=[
    new Response(JSON.stringify({mfa:{enabled:false}}),{status:200,headers:{'Content-Type':'application/json'}}),
    new Response(JSON.stringify(setup),{status:201,headers:{'Content-Type':'application/json'}}),
    new Response(JSON.stringify({recoveryCodes:codes,enabledAt:123}),{status:200,headers:{'Content-Type':'application/json'}}),
    new Response(null,{status:204}),
  ];
  globalThis.fetch=async(input,init={})=>{calls.push({path:String(input),init});return replies.shift()};
  try {
    assert.equal((await chatApi.me()).mfa.enabled,false);
    assert.deepEqual(await chatApi.mfaSetup(),setup);
    assert.deepEqual((await chatApi.mfaVerify('123456')).recoveryCodes,codes);
    assert.equal(await chatApi.mfaDelete(),undefined);
  } finally { globalThis.fetch=originalFetch; }

  assert.deepEqual(calls.map(call=>[call.path,call.init.method??'GET']),[
    ['/api/v1/auth/me','GET'],
    ['/api/v1/identity/mfa/totp/setup','POST'],
    ['/api/v1/identity/mfa/totp/verify','POST'],
    ['/api/v1/identity/mfa/totp','DELETE'],
  ]);
  assert.equal(calls[1].init.body,'{}');
  assert.equal(calls[2].init.body,'{"code":"123456"}');
  for(const call of calls.slice(1)){
    assert.equal(call.init.credentials,'include');
    assert.equal(new Headers(call.init.headers).has('Idempotency-Key'),false);
  }
});

test('setup is keyboard-ready, validates six ASCII digits, and explains safe rotation in every locale',()=>{
  const noise=console.error;console.error=()=>{};
  try {
    for(const locale of ['en','zh-TW','ja']){
      const t=createTranslator(locale);
      const fresh=renderToStaticMarkup(createElement(MfaSetupPanel,{t,enrollment:setup,code:'12345',busy:false,error:null,copyState:null,onCode:()=>{},onVerify:()=>{},onCancel:()=>{},onCopy:()=>{}}));
      assert.ok(fresh.includes(t('chat.settings.mfa.setupTitle')),locale);
      assert.ok(fresh.includes(t('chat.settings.mfa.setupDescription')),locale);
      assert.match(fresh,/href="otpauth:\/\/totp\//u);
      assert.match(fresh,/inputMode="numeric"/u);
      assert.match(fresh,/pattern="\[0-9\]\*"/u);
      assert.match(fresh,/maxLength="6"/u);
      assert.match(fresh,/autoComplete="one-time-code"/u);
      assert.match(fresh,/aria-describedby="ui-mfa-setup-help"/u);
      assert.match(fresh,/class="ui-button ui-primary" disabled=""/u);

      const rotation=renderToStaticMarkup(createElement(MfaSetupPanel,{t,enrollment:{...setup,rotating:true},code:'123456',busy:false,error:null,copyState:null,onCode:()=>{},onVerify:()=>{},onCancel:()=>{},onCopy:()=>{}}));
      assert.ok(rotation.includes(t('chat.settings.mfa.rotationDescription')),`${locale} rotation must say the old authenticator remains active`);
      assert.doesNotMatch(rotation,/class="ui-button ui-primary" disabled=""/u);
    }
  } finally {console.error=noise;}
});

test('recovery codes render once as selectable text and require an explicit saved acknowledgement',()=>{
  const noise=console.error;console.error=()=>{};
  try {
    for(const locale of ['en','zh-TW','ja']){
      const t=createTranslator(locale);
      const pending=renderToStaticMarkup(createElement(MfaRecoveryPanel,{t,codes,acknowledged:false,copyState:null,onAcknowledge:()=>{},onCopy:()=>{},onDone:()=>{}}));
      assert.ok(pending.includes(t('chat.settings.mfa.recoveryWarning')),locale);
      assert.equal((pending.match(/<code>/gu)??[]).length,10);
      for(const code of codes)assert.ok(pending.includes(code));
      assert.match(pending,/class="ui-primary" type="button" disabled=""/u);
      const saved=renderToStaticMarkup(createElement(MfaRecoveryPanel,{t,codes,acknowledged:true,copyState:'codes',onAcknowledge:()=>{},onCopy:()=>{},onDone:()=>{}}));
      assert.ok(saved.includes(t('chat.settings.mfa.codesCopied')),locale);
      assert.doesNotMatch(saved,/class="ui-primary" type="button" disabled=""/u);
    }
  } finally {console.error=noise;}
});

test('settings mounts MFA management without persisting plaintext enrollment material',()=>{
  const pages=readFileSync(new URL('../chat/Pages.tsx',import.meta.url),'utf8');
  const source=readFileSync(new URL('./MfaSettings.tsx',import.meta.url),'utf8');
  assert.match(pages,/<MfaSettings t=\{t\}\/>/u);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB/u);
  assert.match(source,/setEnrollment\(null\)[\s\S]{0,120}setCode\(''\)/u);
  assert.match(source,/setRecoveryCodes\(\[\]\)/u);
  assert.match(source,/role="alertdialog"/u);
  assert.match(source,/event\.key!=='Escape'/u);
  assert.match(source,/href="\/login\?returnTo=%2Fsettings"/u);
});
