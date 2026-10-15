// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {holdPagingReducer,holdPayload,holdStatusText,holdTargetText,initialHoldPagingState,mergeHoldPages,validateHoldDraft,validateReleaseReason} from './Retention.js';
import {createTranslator} from '../i18n/runtime.js';

const draft=(overrides={})=>({scopeType:'tenant',scopeId:'',startsAt:'',endsAt:'',reason:'Matter',...overrides});

test('legal-hold form validation mirrors server scope, date and reason rules',()=>{
  for(const scopeType of ['user','conversation','project'])assert.equal(validateHoldDraft(draft({scopeType})).scopeId,'required');
  for(const scopeType of ['tenant','date_range'])assert.equal(validateHoldDraft(draft({scopeType,scopeId:'unexpected',startsAt:'2026-01-01'})).scopeId,'absent');
  assert.equal(validateHoldDraft(draft({scopeType:'date_range'})).startsAt,'bound_required');
  assert.equal(validateHoldDraft(draft({scopeType:'date_range',startsAt:'not-a-date'})).startsAt,'invalid_date');
  assert.equal(validateHoldDraft(draft({scopeType:'date_range',startsAt:'2026-02-02',endsAt:'2026-02-01'})).endsAt,'end_before_start');
  for(const reason of ['', ' ', 'x'.repeat(1001)])assert.equal(validateHoldDraft(draft({reason})).reason,'length');
  assert.deepEqual(validateHoldDraft(draft({scopeType:'date_range',startsAt:'2026-02-01',endsAt:'2026-02-02'})),{});
  assert.deepEqual(validateHoldDraft(draft({scopeType:'date_range',startsAt:'2026-02-01',endsAt:'2026-02-01'})),{});
  assert.equal(validateReleaseReason(' '),false);assert.equal(validateReleaseReason('x'.repeat(1001)),false);assert.equal(validateReleaseReason(' Matter '),true);
});

test('hold payload uses tenant-zone day starts and an exclusive day after the inclusive end',()=>{
  assert.deepEqual(holdPayload(draft({scopeType:'date_range',startsAt:'2026-02-01',endsAt:'2026-02-28'}),'Asia/Taipei'),{scopeType:'date_range',startsAt:'2026-01-31T16:00:00.000Z',endsAt:'2026-02-28T16:00:00.000Z',reason:'Matter'});
  assert.deepEqual(holdPayload(draft({scopeType:'date_range',startsAt:'2026-02-01',endsAt:'2026-02-01'}),'Asia/Taipei'),{scopeType:'date_range',startsAt:'2026-01-31T16:00:00.000Z',endsAt:'2026-02-01T16:00:00.000Z',reason:'Matter'});
});

test('hold target and status text are localized without leaking translation keys',()=>{
 const statuses={'zh-TW':['生效中','已解除'],ja:['有効','解除済み']} as const;
 for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale),format=(instant:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Taipei'}).format(new Date(instant));
  const start=format('2026-01-31T16:00:00.000Z'),end=format('2026-02-28T15:59:59.999Z');
  const results=[
   holdTargetText({scopeType:'user',scopeLabel:'Alex'},locale,'Asia/Taipei',t),
   holdTargetText({scopeType:'date_range',startsAt:'2026-01-31T16:00:00.000Z',endsAt:'2026-02-28T16:00:00.000Z'},locale,'Asia/Taipei',t),
   holdTargetText({scopeType:'date_range',startsAt:'2026-01-31T16:00:00.000Z',endsAt:null},locale,'Asia/Taipei',t),
   holdTargetText({scopeType:'date_range',startsAt:null,endsAt:'2026-02-28T16:00:00.000Z'},locale,'Asia/Taipei',t),
   holdTargetText({scopeType:'tenant',scopeLabel:null},locale,'Asia/Taipei',t),
  ];
  assert.deepEqual(results,['Alex',t('admin.legalHolds.range',{start,end}),t('admin.legalHolds.from',{start}),t('admin.legalHolds.through',{end}),'—']);
  assert.ok(results.every(result=>!result.startsWith('admin.')));
  if(locale!=='en')assert.deepEqual([holdStatusText('active',t),holdStatusText('released',t)],statuses[locale]);
 }
});

test('conversation hold targets format their creation date in the workspace zone',()=>{
 const t=createTranslator('en'),hold={scopeType:'conversation',scopeLabel:'Owner',scopeCreatedAt:'2026-02-09T23:00:00.000Z'};
 assert.equal(holdTargetText(hold,'en','Asia/Taipei',t),`Owner · ${new Intl.DateTimeFormat('en',{dateStyle:'medium',timeZone:'Asia/Taipei'}).format(new Date(hold.scopeCreatedAt))}`);
 assert.equal(holdTargetText(hold,'en','UTC',t),`Owner · ${new Intl.DateTimeFormat('en',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(hold.scopeCreatedAt))}`);
 assert.match(holdTargetText(hold,'en','Asia/Taipei',t),/Feb 10, 2026/);
 assert.match(holdTargetText(hold,'en','UTC',t),/Feb 9, 2026/);
});

test('hold paging appends a next page and resets to a replacement first page',()=>{
 const first={items:[{id:'one'}],nextCursor:'next'},second={items:[{id:'two'}],nextCursor:null},replacement={items:[{id:'fresh'}],nextCursor:'fresh-next'};
 const appended=mergeHoldPages(first,second,true);assert.deepEqual(appended,{items:[{id:'one'},{id:'two'}],nextCursor:null});
 assert.deepEqual(mergeHoldPages(appended,replacement,false),replacement);
});

test('hold paging reducer replaces rows with a first page',()=>{
 const state={...initialHoldPagingState,generation:2,page:{items:[{id:'old'}],nextCursor:'old-next'}};
 const page={items:[{id:'fresh'}],nextCursor:'fresh-next'};
 assert.deepEqual(holdPagingReducer(state,{type:'firstPageLoaded',generation:2,page}),{...state,page,loading:false,firstError:null});
});

test('hold paging reducer appends a later page and takes its cursor',()=>{
 const state={...initialHoldPagingState,generation:2,loading:false,loadingMore:true,page:{items:[{id:'one'}],nextCursor:'page-2'}};
 const next=holdPagingReducer(state,{type:'loadMoreLoaded',generation:2,page:{items:[{id:'two'}],nextCursor:'page-3'}});
 assert.deepEqual(next.page,{items:[{id:'one'},{id:'two'}],nextCursor:'page-3'});assert.equal(next.loadingMore,false);
});

test('hold paging reducer keeps rows and cursor after Load more fails and clears the error on retry',()=>{
 const page={items:[{id:'one'}],nextCursor:'page-2'},state={...initialHoldPagingState,generation:2,loading:false,loadingMore:true,page};
 const failed=holdPagingReducer(state,{type:'loadMoreFailed',generation:2,error:new Error('Page failed')});
 assert.strictEqual(failed.page,page);assert.equal(failed.error.message,'Page failed');assert.equal(failed.loadingMore,false);
 const retried=holdPagingReducer(failed,{type:'loadMoreStarted',generation:2});assert.equal(retried.error,null);assert.equal(retried.loadingMore,true);assert.strictEqual(retried.page,page);
});

test('hold paging reducer drops a Load more page from an older generation after reload',()=>{
 const old={...initialHoldPagingState,generation:1,loading:false,page:{items:[{id:'old'}],nextCursor:'page-2'}};
 const reloaded=holdPagingReducer(old,{type:'reload',generation:2}),stale=holdPagingReducer(reloaded,{type:'loadMoreLoaded',generation:1,page:{items:[{id:'stale'}],nextCursor:null}});
 assert.strictEqual(stale,reloaded);assert.deepEqual(stale.page,old.page);
});

test('hold paging reducer drops a first page from an older generation',()=>{
 const current={...initialHoldPagingState,generation:3,page:{items:[{id:'current'}],nextCursor:null}},stale=holdPagingReducer(current,{type:'firstPageLoaded',generation:2,page:{items:[{id:'stale'}],nextCursor:'stale-next'}});
 assert.strictEqual(stale,current);
});

test('hold paging reducer clears stale rows and cursor when the current first page fails',()=>{
 const page={items:[{id:'old'}],nextCursor:'page-2'},loading=holdPagingReducer(initialHoldPagingState,{type:'reload',generation:1}),loaded=holdPagingReducer(loading,{type:'firstPageLoaded',generation:1,page});
 const reloaded=holdPagingReducer(loaded,{type:'reload',generation:2}),error=new Error('First page failed'),failed=holdPagingReducer(reloaded,{type:'firstPageFailed',generation:2,error});
 assert.deepEqual(failed.page,{items:[],nextCursor:null});assert.equal(failed.loading,false);assert.strictEqual(failed.firstError,error);
});

test('hold paging reducer ignores an older generation first-page failure',()=>{
 const page={items:[{id:'current'}],nextCursor:'current-next'},loading=holdPagingReducer(initialHoldPagingState,{type:'reload',generation:3}),current=holdPagingReducer(loading,{type:'firstPageLoaded',generation:3,page}),stale=holdPagingReducer(current,{type:'firstPageFailed',generation:2,error:new Error('Stale failure')});
 assert.strictEqual(stale,current);assert.deepEqual(stale.page,current.page);assert.equal(stale.firstError,null);
});

test('legal holds are read-only without manage permission and expose no disabled management buttons',()=>{
  const source=readFileSync(new URL('./Retention.tsx',import.meta.url),'utf8');
  assert.match(source,/canManage&&<button[^>]*ui-primary[^>]*>[^{]*\{t\('admin\.legalHolds\.place'\)\}/u);
  assert.match(source,/canManage&&hold\.status==='active'&&<div className="ui-cell-actions">/u);
  assert.doesNotMatch(source,/disabled=\{!canManage/u);
});

test('hold form and settings hint use the scoped controls and in-console navigation',()=>{
 const source=readFileSync(new URL('./Retention.tsx',import.meta.url),'utf8'),css=readFileSync(new URL('./admin.css',import.meta.url),'utf8');
 assert.match(source,/<select id=\{field\.id\} aria-describedby=\{field\.describedBy\} name="hold-scope"[\s\S]*?<option key=\{scope\} value=\{scope\}>/u);
 assert.doesNotMatch(source,/<fieldset className="ui-field"><legend>\{t\('admin\.legalHolds\.scope'\)\}/u);
 assert.match(source,/touched\[key\]&&errors\[key\]/u);
 assert.match(source,/canOpenSettings\?<a href="\/admin\/settings" onClick=\{event=>\{event\.preventDefault\(\);onNavigateSettings\(\)\}\}/u);
 assert.doesNotMatch(css,/\.ui-drawer \.ui-admin-form>footer/u);
});
