// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../i18n/runtime.js';
import { SCREENS } from './catalog.js';
import { AuditEventDetail, loadScreenDetail } from './GenericScreen.js';

test('only the audit screen opts into one lazy detail request',async()=>{
  const audit=SCREENS.find(screen=>screen.key==='audit')!,users=SCREENS.find(screen=>screen.key==='users')!;
  const paths:string[]=[];
  const get=async(path:string)=>{paths.push(path);return {id:'event-1'}};
  assert.equal(await loadScreenDetail(users,{id:'user-1'},get),null);
  assert.deepEqual(paths,[],'a screen without detailEndpoint must make no row-click detail request');
  assert.deepEqual(await loadScreenDetail(audit,{id:'event-1'},get),{id:'event-1'});
  assert.deepEqual(paths,['/audit/events/event-1']);
});

test('audit detail renders resolved policies, tally, and cleansed prompt as plain text',()=>{
  const t=createTranslator('en'),token='Send ⟦REDACTED:SECRET:token-1:check⟧ & never the original';
  const html=renderToStaticMarkup(createElement(AuditEventDetail,{t,record:{id:'event-1',detail:{policiesApplied:[{ruleId:'rule-1',ruleName:'Customer secrets',detector:'keyword',action:'redact'}],matchCount:2,ruleCount:1,cleansedPrompt:{text:token,transformed:true}}}}));
  assert.match(html,/Policies applied/);assert.match(html,/Customer secrets/);assert.match(html,/2 matches across 1 rules/);assert.match(html,/Cleansed prompt/);assert.match(html,/⟦REDACTED:SECRET:token-1:check⟧/);assert.match(html,/ui-action--redact/);assert.match(html,/&amp; never the original/);assert.doesNotMatch(html,/<script>/);
});
