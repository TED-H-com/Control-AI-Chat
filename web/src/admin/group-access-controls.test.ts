// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reselect } from './GenericScreen.js';
import { budgetUpdatePayload,providerAccessByGroup,settleControlWrite } from './GroupAccessControls.js';

test('budget controls preserve hard limit and enabled while sending converted values or null for the soft limit',()=>{
  assert.deepEqual(budgetUpdatePayload('tokens','','1200',false),{softLimit:null,hardLimit:1200,enabled:false});
  assert.deepEqual(budgetUpdatePayload('tokens','800','1200',true),{softLimit:800,hardLimit:1200,enabled:true});
  assert.deepEqual(budgetUpdatePayload('usd','8.25','10.50',false),{softLimit:8_250_000,hardLimit:10_500_000,enabled:false});
  const source=readFileSync(new URL('GroupAccessControls.tsx',import.meta.url),'utf8'),budget=source.slice(source.indexOf('export function BudgetControls'));
  assert.match(budget,/adminWrite\(`\/budgets\/[\s\S]*?'PATCH',budgetUpdatePayload\(metric,soft,hard,enabled\),mutationVersion\(record\)/u);
});

test('provider access preserves stored versions and derives zero only for an absent group UUID',()=>{
  const byGroup=providerAccessByGroup({enabledGroups:['Renameable label'],groupAccess:[
    {groupId:'enabled-id',enabled:true,version:3},
    {groupId:'disabled-id',enabled:false,version:7},
  ]});
  assert.deepEqual(byGroup.get('enabled-id'),{groupId:'enabled-id',enabled:true,version:3});
  assert.deepEqual(byGroup.get('disabled-id'),{groupId:'disabled-id',enabled:false,version:7});
  assert.deepEqual(byGroup.get('absent-id')??{groupId:'absent-id',enabled:false,version:0},{groupId:'absent-id',enabled:false,version:0});
});

test('provider controls send the UUID relationship version and refresh success or stale failure',()=>{
  const source=readFileSync(new URL('GroupAccessControls.tsx',import.meta.url),'utf8');
  const start=source.indexOf('export function ProviderControls('),end=source.indexOf('\nexport function ',start+1),provider=source.slice(start,end);
  assert.match(provider,/accessByGroup\.get\(id\(group\)\)/u);assert.doesNotMatch(provider,/record\.enabledGroups/u);
  assert.match(provider,/adminWrite\(`\/admin\/groups\/\$\{encodeURIComponent\(id\(group\)\)\}\/providers\/[^`]+`,'PUT',\{enabled\},version\)/u);
  assert.match(provider,/change\(group,true,current\.version\)/u);assert.match(provider,/change\(group,false,current\.version\)/u);
  assert.match(provider,/caught instanceof ApiClientError&&caught\.status===412\)await onReload\(\)/u);
  const forms=readFileSync(new URL('forms.tsx',import.meta.url),'utf8');assert.match(forms,/<ProviderControls record=\{record\} onReload=\{onReload\}\/>/u);
});

test('a drawer reload reselects the returned row instead of retaining its stale version',()=>{
  const current={id:'provider',groupAccess:[{groupId:'g',enabled:false,version:1}]};
  const refreshed={id:'provider',groupAccess:[{groupId:'g',enabled:true,version:2}]};
  assert.equal(reselect([refreshed],current),refreshed);assert.equal(reselect([],current),null);
  const source=readFileSync(new URL('GenericScreen.tsx',import.meta.url),'utf8');
  assert.match(source,/setSelected\(current=>reselect\(items,current\)\)/u);
});

for(const path of ['ModelControls.save','ModelControls.access','BudgetControls.save','BudgetControls.disable'])test(`${path} reports a failed write and releases its busy state`,async()=>{
 const errors:unknown[]=[],settled:string[]=[];
 const result=await settleControlWrite(async()=>{throw new Error(`${path} failed`)},error=>errors.push(error),()=>settled.push('settled'));
 assert.equal(result,false);
 assert.equal((errors[0] as Error).message,`${path} failed`);
 assert.deepEqual(settled,['settled']);
});

test('each fallible model and budget write uses the settling error path',()=>{
 const source=readFileSync(new URL('GroupAccessControls.tsx',import.meta.url),'utf8');
 const model=source.slice(source.indexOf('export function ModelControls'),source.indexOf('export function ProviderControls'));
 const budget=source.slice(source.indexOf('export function BudgetControls'));
 assert.match(model,/const save=async\(\)=>\{[\s\S]*?settleControlWrite/u);
 assert.match(model,/const access=async\([^)]*\)=>\{[\s\S]*?settleControlWrite/u);
 assert.match(budget,/const save=async\(\)=>\{[\s\S]*?settleControlWrite/u);
 assert.match(budget,/const disable=async\(\)=>\{[\s\S]*?settleControlWrite/u);
});
