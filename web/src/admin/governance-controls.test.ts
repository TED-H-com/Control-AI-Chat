import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCREENS } from './catalog.js';
import { screenActionAvailable } from './GenericScreen.js';
import { enabledDetectors, fromRule, POLICY_ACTIONS, POLICY_DIRECTIONS, POLICY_SCOPES, policyRuleDrawerTitle, policyRuleMutationBody } from './PolicyEditor.js';
import { valueText } from './components.js';
import { createTranslator,runtimeTranslation } from '../i18n/runtime.js';
import { detectorWire } from '../../../server/src/app/admin/wire.js';
import { approvalDecisionAvailable, approvalPollNeedsViolationRefresh, approvalReleaseErrorCode, authoritativeViolationAfterApprovalPoll, shouldPollApprovalRelease, validLocalDateTime, violationBulkFilter, violationBulkOperation } from './Violations.js';
import { routeDefinitions } from '@routes/catalog.js';
import type { AdminRecord, DetectorRecord } from './types.js';

test('policy authoring exposes only directions the chat gate implements',()=>{
  assert.deepEqual(POLICY_DIRECTIONS,['outbound','inbound']);
  assert.equal(POLICY_DIRECTIONS.includes('file' as never),false);
});

test('policy editor exposes model scope and loads model targets',()=>{
  assert.deepEqual(POLICY_SCOPES,['tenant','group','user','model']);
  const source=readFileSync(new URL('./PolicyEditor.tsx',import.meta.url),'utf8');
  assert.match(source,/adminGet<AdminPage<ScopeTarget>>\('\/admin\/models'\)/);
  assert.match(source,/draft\.scopeType==='user'\?users:models/);
  for(const locale of ['en','zh-TW','ja'] as const)assert.notEqual(createTranslator(locale)('admin.enums.model'),'admin.enums.model');
});

test('general policy authoring exposes mask and preserves its replacement config',()=>{
  assert.ok(POLICY_ACTIONS.includes('mask'));
  for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale);assert.notEqual(t('admin.enums.mask'),'admin.enums.mask');assert.notEqual(t('admin.compliance.actions.mask'),'admin.compliance.actions.mask');assert.notEqual(t('chat.metadata.verdict.mask'),'chat.metadata.verdict.mask');assert.notEqual(t('admin.audit.actions.gate.content_masked'),'admin.audit.actions.gate.content_masked')}
});

test('policy detector options use the boolean and field names emitted by the detector wire',()=>{
  const wired=detectorWire({id:'detector-1',key:'default-secrets',kind:'secret',enabled:1,builtin:1,config_json:'{"patterns":["token"]}',created_at:0,updated_at:0}) as unknown as DetectorRecord;
  assert.equal(typeof wired.enabled,'boolean');
  const options=enabledDetectors([wired]);
  assert.equal(options.length,1);
  assert.deepEqual({value:options[0].id,label:options[0].name,kind:options[0].detectorKind},
    {value:'detector-1',label:'default-secrets',kind:'secret'});
});

test('policy detector options reuse the table label and the list avoids a duplicate type column',()=>{
  const t=createTranslator('en');
  assert.equal(valueText('default-pii','name','en',t),'Personal information (PII)');
  assert.equal(valueText('default-sensitive-terms','name','en',t),'Sensitive terms');
  const detectorScreen=SCREENS.find(screen=>screen.key==='detectors');
  assert.deepEqual(detectorScreen?.columns.map(column=>column.key),['name','enabled','builtin','updatedAt']);
  assert.equal(detectorScreen?.columns.find(column=>column.key==='builtin')?.format,'boolean');
  assert.ok(detectorScreen?.detailColumns?.some(column=>column.key==='detectorKind'));
});

test('policy rule drawer titles translate built-ins and preserve workspace detector names',()=>{
  for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale);
    for(const key of ['custom-terms','workspace-detector','default-pii']){
      const title=policyRuleDrawerTitle({id:'rule',detectorKey:key},t),name=runtimeTranslation(t,'admin.enums',key);
      assert.ok(title.includes(name),`${locale}:${key}:${title}`);assert.equal(title.includes('admin.enums.'),false);
    }
  }
});

test('editing a scoped policy rule never broadens it to the tenant',()=>{
  const row={
    id:'rule-1',policy_id:'policy-1',policy_name:'Scoped policy',detector_id:'detector-1',detector_key:'secret',detector_kind:'secret' as const,
    scope_type:'group' as const,scope_id:'group-7',direction:'outbound' as const,action:'block' as const,severity:'high' as const,
    config_json:'{"patterns":["token"]}',enabled:1 as const,priority:100,updated_at:7,
  };
  const draft=fromRule(row);
  assert.ok(draft);
  assert.deepEqual({scopeType:draft.scopeType,scopeId:draft.scopeId},{scopeType:'group',scopeId:'group-7'});
  assert.deepEqual(
    (({scopeType,scopeId})=>({scopeType,scopeId}))(policyRuleMutationBody({...draft,action:'redact'})),
    {scopeType:'group',scopeId:'group-7'},
  );
});

test('generic screen actions expose only implemented create drawers in every workspace',()=>{
  for(const screen of SCREENS){
    assert.equal(screenActionAvailable(screen.key),['users','groups','models','assistants','providers','budgets'].includes(screen.key),`${screen.key} exposes an unavailable action`);
  }
});

test('expired approval rows cannot expose reviewer decisions',()=>{
  const now=Date.UTC(2026,0,1);
  const row=(expiresAt:string,status='pending'):AdminRecord=>({approvalId:'approval',approvalVersion:1,approvalStatus:status,approvalExpiresAt:expiresAt});
  assert.equal(approvalDecisionAvailable(row(new Date(now+1).toISOString()),now),true);
  assert.equal(approvalDecisionAvailable(row(new Date(now).toISOString()),now),false);
  assert.equal(approvalDecisionAvailable(row(new Date(now-1).toISOString()),now),false);
  assert.equal(approvalDecisionAvailable(row(new Date(now+1).toISOString(),'expired'),now),false);
});

test('approval release uses the gate decision boundary and polls only durable in-flight states',()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/gate/approvals/:id/decision');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'gate.approvalDecision',permission:'approval:decide',ifMatch:true,idempotency:true});
  assert.equal(routeDefinitions.some(definition=>definition.path==='/admin/violations/:id/decision'),false,
    'violation triage must not assume the fresh-MFA approval worker role');
  for(const status of ['queued','releasing','finalizing','failed'])assert.equal(shouldPollApprovalRelease(status),true,status);
  for(const status of ['pending_review','approved','released','indeterminate','terminal'])assert.equal(shouldPollApprovalRelease(status),false,status);
});

test('unknown approval release errors use the localized generic failure',()=>{
  assert.equal(approvalReleaseErrorCode('provider_timeout'),'provider_timeout');
  assert.equal(approvalReleaseErrorCode('/private/server/path'),'release_failed');
  for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale);assert.notEqual(runtimeTranslation(t,'admin.violations.releaseErrors',approvalReleaseErrorCode('UNKNOWN_RELEASE_CODE')),'UNKNOWN_RELEASE_CODE');}
  const source=readFileSync(new URL('./Violations.tsx',import.meta.url),'utf8');
  assert.match(source,/admin\.violations\.releaseErrors',approvalReleaseErrorCode\(approvalProgress\.releaseErrorCode\)/u);
});

test('terminal approval polling refreshes the authoritative violation workflow state',async()=>{
  for(const status of ['released','indeterminate','terminal'])assert.equal(approvalPollNeedsViolationRefresh(status),true,status);
  for(const status of ['pending_review','queued','releasing','finalizing','failed'])assert.equal(approvalPollNeedsViolationRefresh(status),false,status);
  const calls:string[]=[],item={id:'violation/7',status:'approved',version:8,assignee:null,assigneeId:null,dueAt:null,resolutionReason:null,resolvedBy:null,resolvedById:null,resolvedAt:null,updatedAt:new Date().toISOString(),allowedTransitions:['resolved' as const],comments:[]};
  const refreshed=await authoritativeViolationAfterApprovalPoll('released',item.id,async path=>{calls.push(path);return{item};});
  assert.deepEqual(calls,['/admin/violations/violation%2F7']);
  assert.deepEqual(refreshed&&{status:refreshed.status,version:refreshed.version},{status:'approved',version:8});
  assert.equal(await authoritativeViolationAfterApprovalPoll('releasing',item.id,async()=>{throw new Error('must not fetch')}),null);
});

test('all-matching violation bulk scope contains filters but never pagination state',()=>{
  const params=new URLSearchParams({status:'open,triaged',assignee:'Reviewer',date:'2026-08-09',cursor:'opaque',sort:'occurredAt',order:'asc',limit:'25',ignored:'value'});
  assert.deepEqual(violationBulkFilter(params),{status:'open,triaged',assignee:'Reviewer',date:'2026-08-09'});
});

test('bulk violation controls expose notes and due-date changes as real server commands',()=>{
  assert.deepEqual(violationBulkOperation('note',{note:'Reviewer evidence'}),{command:'note',parameters:{note:'Reviewer evidence'}});
  assert.deepEqual(violationBulkOperation('set_due',{due:'2026-08-09T12:30:00Z'}),{command:'due',parameters:{dueAt:'2026-08-09T12:30:00.000Z'}});
  assert.deepEqual(violationBulkOperation('clear_due',{}),{command:'due',parameters:{dueAt:null}});
});

test('bulk violation due dates use the workspace time zone',()=>{
  assert.deepEqual(violationBulkOperation('set_due',{due:'2026-10-01T09:00'},'Asia/Kathmandu'),
    {command:'due',parameters:{dueAt:'2026-10-01T03:15:00.000Z'}});
});

test('drawer and bulk due-date fields name the workspace time zone in every locale',()=>{
  const source=readFileSync(new URL('Violations.tsx',import.meta.url),'utf8');
  assert.equal(source.match(/admin\.violations\.dueDateHint',\{zone:timeZone\}/gu)?.length,2);
  const expected={en:'Dates are in Asia/Taipei.','zh-TW':'日期以 Asia/Taipei 為準。',ja:'日時は Asia/Taipei 基準です。'} as const;
  for(const locale of ['en','zh-TW','ja'] as const)assert.equal(createTranslator(locale)('admin.violations.dueDateHint',{zone:'Asia/Taipei'}),expected[locale]);
});

test('due-date field validation checks only the input shape and calendar date',()=>{
  const Original=Intl.DateTimeFormat;
  Intl.DateTimeFormat=function(){throw new Error('time-zone conversion must not run during render validation')} as unknown as typeof Intl.DateTimeFormat;
  try {
    assert.equal(validLocalDateTime('2026-09-29T23:59'),true);
    for(const invalid of ['', '2026-02-29T12:00','2026-09-29 23:59','2026-09-29T24:00'])assert.equal(validLocalDateTime(invalid),false,invalid);
  } finally {Intl.DateTimeFormat=Original}
});

test('violation selection and decision dialogs keep one keyboard-safe interaction layer',()=>{
  const violations=readFileSync(new URL('Violations.tsx',import.meta.url),'utf8');
  const components=readFileSync(new URL('components.tsx',import.meta.url),'utf8');
  assert.equal(violations.match(/<ReasonDialog\b/gu)?.length,1,'only one approval reason dialog may be mounted');
  assert.match(components,/\.indeterminate=selectedCount>0&&!allSelected/);
  assert.ok((components.match(/onKeyDown=\{event=>event\.stopPropagation\(\)\}/gu)?.length??0)>=2,
    'header and row checkboxes must not bubble Space into a row action');
});
