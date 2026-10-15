// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminZoneName,auditActionText,dateColumnHeading,formatAdminDate,parseAdminInstant,recordValue,statusText,valueText } from './components.js';
import {readableDetectorName} from './Violations.js';
import { createTranslator } from '../i18n/runtime.js';

test('admin dates accept epoch seconds, epoch milliseconds, and ISO strings',()=>{
  const expected=Date.UTC(2024,0,2,15,4,5);
  assert.equal(parseAdminInstant(expected)?.getTime(),expected);
  assert.equal(parseAdminInstant(Math.floor(expected/1000))?.getTime(),Math.floor(expected/1000)*1000);
  assert.equal(parseAdminInstant(new Date(expected).toISOString())?.getTime(),expected);
  assert.equal(parseAdminInstant('not-a-date'),null);
});

test('admin dates use the tenant time zone and invalid values fall back safely',()=>{
  const instant='2024-01-02T15:04:05.000Z';
  assert.notEqual(formatAdminDate(instant,'en','UTC'),formatAdminDate(instant,'en','America/New_York'));
  assert.equal(formatAdminDate('invalid','en','UTC'),'—');
  assert.doesNotThrow(()=>formatAdminDate(instant,'en','Invalid/Zone'));
});

test('stand-alone dates name the zone in every locale and table headers name it once',()=>{
 const instant='2026-09-28T08:00:00.000Z';
 for(const locale of ['en','zh-TW','ja'] as const){const formatted=formatAdminDate(instant,locale,'Asia/Taipei');assert.match(formatted,/GMT\+8/u);const t=createTranslator(locale);assert.ok(dateColumnHeading(t('admin.fields.occurredAt'),locale,'Asia/Taipei',t).includes(adminZoneName(locale,'Asia/Taipei')))}
 assert.equal(adminZoneName('en','UTC'),'UTC');
 assert.equal(dateColumnHeading('Occurred','en','UTC',createTranslator('en')),'Occurred (UTC)');
});

test('column metadata controls formatting instead of guessing from field names',()=>{
  assert.equal(valueText(1_704_204_000_000,'createdAt','en',undefined,'text'),'1,704,204,000,000');
  assert.notEqual(valueText(1_704_204_000_000,'anything','en',undefined,'date','UTC'),'1,704,204,000,000');
});

test('admin records resolve camel-case columns from repository-shaped rows',()=>{
  const row={display_name:'Example',provider_key:'openai',capabilities_json:'["text","vision"]',updated_at:1_704_204_000_000};
  assert.equal(recordValue(row,'displayName'),'Example');
  assert.equal(recordValue(row,'provider'),'openai');
  assert.deepEqual(recordValue(row,'capabilities'),['text','vision']);
  assert.equal(recordValue(row,'updatedAt'),1_704_204_000_000);
});

test('provider and credential identifiers render as neutral provider names',()=>{
  assert.equal(valueText('openai'),'OpenAI');
  assert.equal(valueText('anthropic'),'Anthropic');
  assert.equal(valueText('google'),'Google');
  assert.equal(valueText('xai'),'xAI');
  assert.equal(valueText('platform','provider','en',key=>key==='admin.enums.platform'?'Product key':key),'Product key');
});

test('runtime admin values and outcomes preserve unknown raw values in every locale',()=>{
  for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale);
    assert.equal(valueText('mystery_state','state',locale,t,'enum'),'mystery_state');
    assert.equal(valueText('mystery_state','state',locale,t),'mystery_state');
    assert.equal(statusText('mystery_state',true,locale,t),'mystery_state');
    assert.equal(readableDetectorName('mystery_state',t,locale),'mystery_state');
    for(const value of [valueText('active','state',locale,t,'enum'),valueText('active','state',locale,t),statusText('success',true,locale,t),readableDetectorName('default-pii',t,locale)])assert.ok(value&&!value.startsWith('admin.'),`${locale}: ${value}`);
  }
});

test('shared status text does not apply legal-hold wording to released values',()=>{
 for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale),approval=t('admin.enums.released');assert.equal(statusText('released',false,locale,t),approval);if(locale!=='en')assert.notEqual(approval,t('admin.legalHolds.status.released'))}
});

test('audit action paths resolve namespace and action segments in every locale',()=>{
 const expected={en:'Message completed','zh-TW':'訊息已完成',ja:'メッセージが完了'} as const;
 for(const [locale,label] of Object.entries(expected)){
    assert.equal(auditActionText('chat.message_completed',createTranslator(locale)),label);
  }
});

test('unknown audit actions render a localized unavailable label instead of server text',()=>{
 const t=createTranslator('en');
 assert.doesNotThrow(()=>auditActionText('system.audit_chain_initialized',t));
 assert.equal(auditActionText('system.audit_chain_initialized',t),'Audit chain initialized');
 assert.equal(auditActionText('vendor.custom_event',t),t('admin.values.unavailable'));
 assert.equal(auditActionText(null,t),'—');
});
