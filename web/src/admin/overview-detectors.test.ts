import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, createTranslator } from '../i18n/index.js';
import { BarChart, ChartCard } from './charts.js';
import { chartDate,detectorSeries,overviewActivity,type Summary } from './Overview.js';

const summary=(overrides:Partial<Summary>={}):Summary=>({requests:3,activeUsers:2,tokens:{total:0},spendMicroUsd:0,blockedRequests:0,pendingApprovals:0,budgetUsedMicroUsd:25,budgetLimitMicroUsd:100,providerErrorRate:0,dataFreshThrough:null,...overrides});

test('overview KPI data renders real zeroes and omits only unavailable rates',()=>{
  const present=overviewActivity(summary(),'en');
  assert.deepEqual(present.map(([key])=>key),['admin.overview.requests','admin.overview.activeUsers','admin.overview.tokens','admin.overview.spend','admin.overview.blockedRequests','admin.overview.pendingApprovals','admin.overview.providerErrorRate','admin.overview.budgetUtilization']);
  assert.equal(present.find(([key])=>key==='admin.overview.tokens')?.[1],'0');
  assert.equal(present.find(([key])=>key==='admin.overview.blockedRequests')?.[1],'0');
  assert.equal(present.find(([key])=>key==='admin.overview.providerErrorRate')?.[1],'0%');
  const absent=overviewActivity(summary({providerErrorRate:null,budgetUsedMicroUsd:null,budgetLimitMicroUsd:null}),'en');
  assert.ok(!absent.some(([key])=>key==='admin.overview.providerErrorRate'));
  assert.ok(!absent.some(([key])=>key==='admin.overview.budgetUtilization'));
  assert.equal(absent.length,6);
});

test('detector panel renders localized detector names and its existing empty state',()=>{
  Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/'},configurable:true});
  Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null},configurable:true});
  const points=detectorSeries({items:[{label:'default-pii',value:4}]},createTranslator('en'),'en');
  const populated=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(ChartCard,{title:'Sensitive detectors',description:'Description',children:createElement(BarChart,{data:points,label:'Detections'})})}));
  assert.match(populated,/Personal information \(PII\)/u);
  assert.doesNotMatch(populated,/default-pii/u);
  const empty=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(ChartCard,{title:'Sensitive detectors',description:'Description',empty:true,children:createElement(BarChart,{data:[],label:'Detections'})})}));
  assert.match(empty,/No data in this period/u);
});

test('Overview fetches detector analytics and maps raw labels through the shared helper',()=>{
  const source=readFileSync(new URL('Overview.tsx',import.meta.url),'utf8');
  assert.match(source,/adminGet<unknown>\('\/admin\/analytics\/detectors',query\)/u);
  assert.match(source,/readableDetectorName\(point\.label,translate,locale\)/u);
});

test('Overview chart texts, tooltips, alignment hours and day keys use the workspace zone and locale',()=>{
  const timestamp=Date.parse('2026-09-28T16:30:00Z');
  const cases=[
    ['Asia/Taipei','en','12 AM','Sep 29, 12 AM','Sep 29','2026-09-29'],
    ['Asia/Taipei','zh-TW','0時','9月29日 0時','9月29日','2026-09-29'],
    ['Asia/Taipei','ja','0時','9月29日 0時','9月29日','2026-09-29'],
    ['Asia/Kathmandu','en','10 PM','Sep 28, 10 PM','Sep 28','2026-09-28'],
    ['Asia/Kathmandu','zh-TW','22時','9月28日 22時','9月28日','2026-09-28'],
    ['Asia/Kathmandu','ja','22時','9月28日 22時','9月28日','2026-09-28'],
  ] as const;
  for(const [timeZone,locale,shortLabel,longLabel,dateLabel,dayKey] of cases){
    const localHour=timeZone==='Asia/Taipei'?0:22;
    assert.deepEqual(chartDate(timestamp,locale,timeZone,'hour'),{shortLabel,longLabel,dayKey,tooltipLabel:longLabel,localHour});
    assert.deepEqual(chartDate(timestamp,locale,timeZone,'day'),{shortLabel:dateLabel,longLabel:dateLabel,dayKey,tooltipLabel:dateLabel});
  }
});
