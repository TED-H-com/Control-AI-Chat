// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator } from './runtime.js';

test('missing leaves and intermediate catalogue segments fall back to their key in every locale',()=>{
 for(const locale of ['en','zh-TW','ja'] as const){
  const t=createTranslator(locale) as (key:string)=>string;
  assert.equal(t('admin.enums.not-a-real-value'),'admin.enums.not-a-real-value',`${locale} missing leaf`);
  assert.equal(t('admin.not-a-real-branch.value'),'admin.not-a-real-branch.value',`${locale} missing intermediate segment`);
 }
});
