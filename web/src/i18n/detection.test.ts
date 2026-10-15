// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchLocale } from './detection.js';

test('browser language detection maps every Chinese tag to Traditional Chinese',()=>{
  for(const tag of ['zh-CN','zh-Hans','zh-SG','zh-HK','zh-MO','zh'])assert.equal(matchLocale([tag]),'zh-TW',tag);
});

test('browser language detection maps Japanese and defaults all other languages to English',()=>{
  for(const tag of ['ja','ja-JP'])assert.equal(matchLocale([tag]),'ja',tag);
  for(const tag of ['en','en-GB','fr','de-DE'])assert.equal(matchLocale([tag]),'en',tag);
});

test('browser language detection respects supported preference order',()=>{
  assert.equal(matchLocale(['en-US','zh-TW']),'en');
  assert.equal(matchLocale(['fr','ja-JP']),'ja');
  assert.equal(matchLocale(['fr','zh-CN','en']),'zh-TW');
  assert.equal(matchLocale(['fr']),'en');
});
