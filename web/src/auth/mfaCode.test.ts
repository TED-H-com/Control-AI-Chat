// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { catalogues } from '../i18n/catalogues.js';
import { mfaCodeForSubmission, normalizeMfaCode } from './mfaCode.js';

test('MFA input normalizes TOTP and pasted recovery codes to server-verifiable values',()=>{
  assert.equal(normalizeMfaCode(' 12 34 56 '),'123456');
  assert.equal(normalizeMfaCode(' ab12c - d3e4f '),'AB12C-D3E4F');
  assert.equal(normalizeMfaCode('ab12cd3e4f'),'AB12C-D3E4F');
  assert.equal(mfaCodeForSubmission(' 12 34 56 '),'123456');
  assert.equal(mfaCodeForSubmission(' ab12c - d3e4f '),'AB12C-D3E4F');
});

test('MFA validation rejects every shape except six digits or XXXXX-XXXXX uppercase alphanumerics',()=>{
  for(const value of ['', '12345', '1234567', '123-456', 'ABCDE-FGHI', 'ABCDE-FGHIJK', 'ABCDE--FGHIJ', 'ABCDE_FGHIJ', 'ABCDE-FGHI!', '１２３４５６']){
    assert.equal(mfaCodeForSubmission(value),null,value);
  }
  assert.equal(mfaCodeForSubmission('000000'),'000000');
  assert.equal(mfaCodeForSubmission('ABCDE-FGHIJ'),'ABCDE-FGHIJ');
});

test('the MFA form preserves one-time-code autocomplete and enables only a validated submission',async()=>{
  const page=readFileSync(new URL('./LoginPage.tsx',import.meta.url),'utf8');
  assert.match(page,/autoComplete="one-time-code"/);
  assert.doesNotMatch(page,/ui-mfa-code-help/);
  assert.match(page,/setCode\(normalizeMfaCode\(event\.target\.value\)\)/);
  assert.match(page,/disabled=\{!submissionCode\|\|busy\}/);
  assert.match(page,/JSON\.stringify\(\{mfaTicket,code:submissionCode\}\)/);
  assert.doesNotMatch(page,/inputMode="numeric"|pattern="\[0-9\]\{6\}"|maxLength=\{6\}|replace\(\/\\D\/g/);
  const {registerCssImports}=await import('../test-support/css-imports.js');
  const {createElement}=await import('react');
  const {renderToStaticMarkup}=await import('react-dom/server');
  await registerCssImports();
  Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/login',hash:'',origin:'http://127.0.0.1',assign(){}},configurable:true});
  Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>'en',setItem(){},removeItem(){}},configurable:true});
  const {I18nProvider,createTranslator}=await import('../i18n/index.js');
  const {LoginPage}=await import('./LoginPage.js');
  const html=renderToStaticMarkup(createElement(I18nProvider,null,createElement(LoginPage,{initialPhase:'mfa'})));
  const t=createTranslator('en');
  const label=new RegExp(`<label\\b[^>]*\\bfor="([^"]+)"[^>]*>${t('auth.code')}</label>`).exec(html);
  assert.ok(label,t('auth.code'));
  const described=/<input\b(?=[^>]*\bid="([^"]+)")(?=[^>]*\baria-describedby="([^"]+)")[^>]*>/.exec(html);
  assert.ok(described);
  const [,controlId,hintId]=described;
  assert.equal(label[1],controlId);
  assert.match(html,new RegExp(`<small\\b[^>]*\\bid="${hintId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*>${t('auth.codeHelp')}</small>`));
});

test('all locales name both verification and recovery codes in label, help, and error copy',()=>{
  const expected={en:/recovery code/i,'zh-TW':/恢復碼/u,ja:/リカバリーコード/u};
  for(const [locale,catalogue] of Object.entries(catalogues)){
    for(const key of ['code','codeHelp','invalidCode'])assert.match(catalogue.auth[key],expected[locale],`${locale} auth.${key}`);
  }
});
