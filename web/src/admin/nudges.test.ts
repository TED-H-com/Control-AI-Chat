import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n/index.js';
import { NudgeCards, type Nudge } from './Overview.js';

Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/'},configurable:true});
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null},configurable:true});

const render=(nudges:readonly Nudge[])=>renderToStaticMarkup(createElement(I18nProvider,{children:createElement(NudgeCards,{nudges})}));

test('nudge cards render every localized template with category and priority chips and no dismiss control',()=>{
  const html=render([
    {key:'approvalsPending:medium',ruleId:'approvalsPending',category:'governance',priority:'medium',count:1},
    {key:'blockedVolume:high',ruleId:'blockedVolume',category:'policy',priority:'high',count:3},
    {key:'budgetUtilization:medium',ruleId:'budgetUtilization',category:'cost',priority:'medium',percent:.75},
    {key:'warnProceed:high',ruleId:'warnProceed',category:'policy',priority:'high',count:5},
  ]);
  assert.match(html,/1 request is waiting for approval/u);
  assert.match(html,/3 requests were blocked by policy/u);
  assert.match(html,/used 75% of this period&#x27;s budget/u);
  assert.match(html,/policy warning 5 times/u);
  for(const chip of ['Governance','Policy','Cost','Medium','High'])assert.match(html,new RegExp(`>${chip}<`,'u'));
  assert.doesNotMatch(html,/<button|dismiss|aria-label="Close"|✕/iu);
});

test('plural nudge bodies select one and other forms',()=>{
  assert.match(render([{key:'one',ruleId:'approvalsPending',category:'governance',priority:'medium',count:1}]),/1 request is waiting/u);
  assert.match(render([{key:'many',ruleId:'approvalsPending',category:'governance',priority:'medium',count:3}]),/3 requests are waiting/u);
});

test('an empty nudge list renders no card or placeholder',()=>{
  assert.equal(render([]),'');
});

test('Overview fetches the nudge endpoint',()=>{
  const source=readFileSync(new URL('Overview.tsx',import.meta.url),'utf8');
  assert.match(source,/adminGet<\{items:Nudge\[\]\}>\('\/admin\/nudges',query\)/u);
});
