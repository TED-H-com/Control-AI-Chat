// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogues} from './catalogues.js';

test('legal-hold terminology is consistent in Traditional Chinese and Japanese catalogues',()=>{
 assert.doesNotMatch(JSON.stringify(catalogues['zh-TW']),/保全/u);
 assert.doesNotMatch(JSON.stringify(catalogues.ja),/訴訟ホールド/u);
});
