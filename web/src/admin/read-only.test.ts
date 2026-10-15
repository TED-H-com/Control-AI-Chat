// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider,createTranslator} from '../i18n/index.js';
import {routeDefinitions} from '../../../server/src/routes/catalog.js';
import {canWrite,SCREENS} from './catalog.js';
import {ReadOnlyNotice} from './components.js';

Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/'},configurable:true});
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null},configurable:true});

const READ_ONLY=['detectors','assets'] as const;

test('generic admin pages without UI mutations are explicitly view-only regardless of backend grants',()=>{
  for(const key of READ_ONLY){
    const screen=SCREENS.find(item=>item.key===key)!;
    assert.equal(screen.readOnly,true,key);
    assert.equal(screen.write,undefined,key);
    assert.equal(canWrite(screen,['policy:write','project:write','admin:settings']),false,key);
  }
  const html=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(ReadOnlyNotice)}));
  assert.match(html,/aria-label="View only"/u);
  assert.match(html,/Changes are not available here\./u);
  assert.match(readFileSync(new URL('GenericScreen.tsx',import.meta.url),'utf8'),/screen\.readOnly&&<ReadOnlyNotice\/>/u);
  const forbiddenClaims:Record<string,RegExp>={
    en:/\b(?:create|manage|tune|configure)\b/iu,
    'zh-TW':/(?:請建立|管理|調校|請設定|完成.*設定)/u,
    ja:/(?:作成してください|管理します|調整し|設定してください)/u,
  };
  for(const locale of ['en','zh-TW','ja'] as const){
    const t=createTranslator(locale);
    assert.ok(t('admin.common.readOnlyTitle').length>0);
    assert.ok(t('admin.common.readOnlyBody').length>20);
    const screenCopy=READ_ONLY.flatMap(key=>[t(`admin.screen.${key}.0`),t(`admin.screen.${key}.1`)]).join(' ');
    assert.doesNotMatch(screenCopy,forbiddenClaims[locale]!,`${locale} must not promise unavailable mutations`);
  }
});

test('removing UI write metadata does not remove the real backend mutation contracts',()=>{
  for(const [key,path] of Object.entries({assets:'/admin/projects',retention:'/admin/retention'})){
    assert.deepEqual(routeDefinitions.filter(route=>route.path===path).map(route=>route.method),['GET'],`${key} endpoint is read-only`);
  }
  const retention=SCREENS.find(screen=>screen.key==='retention')!;
  assert.equal(retention.readOnly,undefined);
  assert.equal(retention.write,'legal_hold:manage');
  assert.deepEqual(routeDefinitions.filter(route=>route.path.startsWith('/admin/legal-holds')).map(route=>route.method),['GET','POST','POST']);
  const expected:Record<string,{prefix:string;permission:string;methods:string[]}>= {
    detectors:{prefix:'/admin/detectors',permission:'policy:write',methods:['POST','PATCH','DELETE']},
  };
  for(const [key,{prefix,permission,methods}] of Object.entries(expected)){
    const routes=routeDefinitions.filter(route=>route.method!=='GET'&&(route.path===prefix||route.path.startsWith(`${prefix}/`)));
    assert.deepEqual(routes.map(route=>route.method),methods,key);
    assert.ok(routes.every(route=>route.permission===permission),key);
  }
});

test('screens with real existing UI mutations retain their write capability metadata',()=>{
  for(const key of ['users','groups','models','assistants','providers','policies','custom-terms','violations','audit','budgets','retention','settings']){
    assert.ok(SCREENS.find(item=>item.key===key)?.write,`${key} lost its implemented write capability`);
  }
});
