// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveAdminScreen } from './admin/routes.js';
import { SCREENS } from './admin/catalog.js';
import { parseChatRoute } from './chat/routes.js';
import { formatDocumentTitle } from './documentTitle.js';
import { createTranslator } from './i18n/runtime.js';
import { NotFoundContent } from './NotFoundPage.js';
import { resolveAppRoute } from './routing.js';
import { PRODUCT_NAME } from '@shared/brand.js';

test('the app resolver recognizes every supported shell route and rejects unknown app routes',()=>{
  for(const path of ['/', '/chat', '/chat/conversation%201', '/projects', '/projects/project%201', '/skills', '/search', '/archived', '/settings', '/settings/general']){
    assert.deepEqual(resolveAppRoute(path),{kind:'chat'},path);
  }
  assert.deepEqual(resolveAppRoute('/login/extra'),{kind:'not-found',area:'app'});
  assert.deepEqual(resolveAppRoute('/login'),{kind:'login'});
  assert.deepEqual(resolveAppRoute('/setup'),{kind:'setup'});
  assert.deepEqual(resolveAppRoute('/reset-password'),{kind:'reset-password'});
  assert.deepEqual(resolveAppRoute('/forgot-password'),{kind:'forgot-password'});
  assert.deepEqual(resolveAppRoute('/admin/users'),{kind:'admin'});
  for(const path of ['/unknown', '/chat/a/b', '/projects/a/files', '/skills/unused', '/settings/security', '/chat/%E0%A4%A']){
    assert.deepEqual(resolveAppRoute(path),{kind:'not-found',area:'app'},path);
    assert.equal(parseChatRoute(path),null,path);
  }
});

test('admin routing is exact for every catalogued screen and nested unknown paths are 404s',()=>{
  for(const screen of SCREENS){
    assert.equal(resolveAdminScreen(screen.path,SCREENS),screen);
    assert.equal(resolveAdminScreen(`${screen.path}/`,SCREENS),screen);
  }
  assert.equal(resolveAdminScreen('/admin/not-a-screen',SCREENS),null);
  assert.equal(resolveAdminScreen('/admin/users/record-id',SCREENS),null);
  assert.equal(resolveAdminScreen('/administer',SCREENS),null);
});

test('route titles keep the deployment brand without duplicating or dropping it',()=>{
  assert.equal(formatDocumentTitle('New chat','Acme AI'),'New chat · Acme AI');
  assert.equal(formatDocumentTitle('  Users  ','  Acme AI  '),'Users · Acme AI');
  assert.equal(formatDocumentTitle('Acme AI','Acme AI'),'Acme AI');
  assert.equal(formatDocumentTitle('',null),PRODUCT_NAME);
  const t=createTranslator('en');
  for(const screen of SCREENS)assert.equal(formatDocumentTitle(t(`admin.screens.${screen.key}`),'Acme AI').endsWith(' · Acme AI'),true);
});

test('the recoverable 404 is localized and points back to the correct safe root',()=>{
  const chatHtml=renderToStaticMarkup(createElement(NotFoundContent,{area:'app',t:createTranslator('zh-TW')}));
  const adminHtml=renderToStaticMarkup(createElement(NotFoundContent,{area:'admin',t:createTranslator('ja')}));
  assert.match(chatHtml,/aria-labelledby="ui-not-found-title"/);
  assert.match(chatHtml,/找不到頁面/);
  assert.match(chatHtml,/href="\/chat"/);
  assert.match(adminHtml,/ページが見つかりません/);
  assert.match(adminHtml,/href="\/admin"/);
});

test('unknown app routes render the 404 branch instead of mounting the conversation shell',()=>{
  const app=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
  assert.match(app,/route\.kind==='chat'\) return <DeploymentProvider authenticated><I18nProvider account=\{account\}>\{content\(<ChatApp \/>,true\)\}/);
  assert.match(app,/return <DeploymentProvider><I18nProvider>\{content\(<NotFoundPage area="app"\/>\)\}<\/I18nProvider>/);
  assert.match(app,/route\.kind==='admin'.*?<AdminConsole \/>/s);
});

test('login, chat, and admin own their route title while deployment only supplies the brand',()=>{
  const deployment=readFileSync(new URL('./deployment.tsx',import.meta.url),'utf8');
  const login=readFileSync(new URL('./auth/LoginPage.tsx',import.meta.url),'utf8');
  const chat=readFileSync(new URL('./chat/ChatApp.tsx',import.meta.url),'utf8');
  const admin=readFileSync(new URL('./admin/AdminConsole.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(deployment,/document\.title/);
  assert.match(login,/useDocumentTitle\(phase==='mfa'\?t\('auth\.mfaTitle'\):t\('auth\.title'\)\)/);
  assert.match(login,/deployment\.canEmail&&<a[^>]+href="\/forgot-password"/u);
  assert.match(chat,/useDocumentTitle\(headerTitle\)/);
  assert.match(admin,/useDocumentTitle\(screen\?label\(screen\.key\):t\('common\.notFound\.title'\)\)/);
});
