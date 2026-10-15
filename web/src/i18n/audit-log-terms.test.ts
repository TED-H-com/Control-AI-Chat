// @ts-nocheck -- catalogue-wide terminology contract.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {catalogues} from './catalogues.js';
import {createTranslator} from './runtime.js';

test('Traditional Chinese names the audit log 稽核紀錄 everywhere',()=>{
 const catalogue=JSON.stringify(catalogues['zh-TW']),audit=readFileSync(new URL('../../scripts/visual-audit.mjs',import.meta.url),'utf8');
 const disallowed=new RegExp('\\u65e5\\u8a8c|\\u7a3d\\u6838\\u8a18\\u9304','u');
 assert.doesNotMatch(catalogue,disallowed);
 assert.doesNotMatch(audit,disallowed);
 assert.match(audit,/audit:'稽核紀錄'/u);
 const t=createTranslator('zh-TW');
 assert.equal(t('admin.violations.approved'),'已核准，理由已寫入稽核紀錄。');
 assert.equal(t('admin.violations.denied'),'已拒絕，理由已寫入稽核紀錄。');
});
