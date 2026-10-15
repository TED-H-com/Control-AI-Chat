// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { AUDIT_EXPORT_FIELDS, AuditExportDialog, auditExportErrorCode, exportDownloadHref, shouldPollExport } from './AuditExport.js';
import { SCREENS } from './catalog.js';

test('only audit opts into export and the header gate requires canWrite',()=>{
  assert.equal(SCREENS.find(screen=>screen.key==='audit')?.exportEndpoint,'/audit/exports');
  assert.equal(SCREENS.filter(screen=>screen.exportEndpoint).length,1);
  const source=readFileSync(new URL('GenericScreen.tsx',import.meta.url),'utf8');
  assert.match(source,/screen\.exportEndpoint&&canWrite&&<button/);
  assert.match(source,/exportOpen&&screen\.exportEndpoint&&canWrite&&<AuditExportDialog/);
});

test('field picker renders all 17 localized labels and defaults them selected',()=>{
  globalThis.location={search:'',pathname:'/admin/audit'};globalThis.localStorage={getItem(){return null},setItem(){}};
  const html=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(AuditExportDialog,{endpoint:'/audit/exports',filters:{category:'gate'},onClose(){}})}));
  assert.equal(AUDIT_EXPORT_FIELDS.length,17);assert.equal((html.match(/type="checkbox"/g)??[]).length,17);assert.equal((html.match(/checked=""/g)??[]).length,17);
  for(const label of ['Event ID','Workspace ID','Chain epoch','Sequence','Occurred at','Recorded at','Action','Category','Outcome','Severity','Actor ID','Target type','Target ID','Metadata','Transcript ID','Previous hash','Event hash'])assert.match(html,new RegExp(label));
  assert.match(html,/current audit filters will be applied/i);
});

test('polling stops at terminal states and download uses the binary endpoint',()=>{
  assert.equal(shouldPollExport('pending'),true);assert.equal(shouldPollExport('completed'),false);assert.equal(shouldPollExport('failed'),false);
  assert.equal(exportDownloadHref('export/one'),'/api/v1/audit/exports/export%2Fone/download');
  assert.equal(auditExportErrorCode('EXPORT_TOO_LARGE'),'EXPORT_TOO_LARGE');assert.equal(auditExportErrorCode('/private/server/path'),'EXPORT_FAILED');assert.equal(auditExportErrorCode(null),'EXPORT_FAILED');
});

test('submit contract posts format, fields, and current filters with a stable key',()=>{
  const source=readFileSync(new URL('AuditExport.tsx',import.meta.url),'utf8');
  assert.match(source,/mutate<\{id:string\}>\(endpoint,'POST',\{format,fields:\[\.\.\.fields\],filters\},undefined,key\.current\.current\(\)\)/);
  assert.match(source,/key\.current\.rotate\(\)/);
  assert.match(source,/href=\{exportDownloadHref\(view\.id\)\} download/);
});
