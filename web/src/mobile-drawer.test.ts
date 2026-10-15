// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from './i18n/runtime.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { ConversationHeader } from './chat/ConversationHeader.js';
import { Sidebar } from './chat/Sidebar.js';

const hook=readFileSync(new URL('./accessibility/mobileDrawer.ts',import.meta.url),'utf8');
const chatApp=readFileSync(new URL('./chat/ChatApp.tsx',import.meta.url),'utf8');
const normalizeCss=(source:string)=>source.replace(/\s+/g,' ').replace(/\s*([{}:;,>])\s*/g,'$1');
const chatCss=normalizeCss(readFileSync(new URL('./chat/chat.css',import.meta.url),'utf8'));
const admin=readFileSync(new URL('./admin/AdminConsole.tsx',import.meta.url),'utf8');
const topBar=readFileSync(new URL('./ui/TopBar.tsx',import.meta.url),'utf8');
const adminCss=normalizeCss(readFileSync(new URL('./admin/admin.css',import.meta.url),'utf8'));

test('chat navigation trigger and open drawer expose a connected disclosure contract',()=>{
  const t=createTranslator('en');
  Object.defineProperty(globalThis,'location',{value:{pathname:'/chat'},configurable:true});
  Object.defineProperty(globalThis,'navigator',{value:{languages:['en'],language:'en'},configurable:true});
  const header=renderToStaticMarkup(createElement(I18nProvider,null,createElement(ConversationHeader,{title:'New chat',t,navigationOpen:true,onOpenNavigation(){}})));
  const drawer=renderToStaticMarkup(createElement(I18nProvider,null,createElement(Sidebar,{open:true,conversations:[],projects:[],activeId:null,archivedActive:false,busyId:null,adminAccess:false,workspace:null,locale:'en',t,onNavigate(){},onAction(){},onClose(){}})));
  assert.match(header,/aria-expanded="true"/);
  assert.match(header,/aria-controls="ui-chat-navigation"/);
  assert.match(drawer,/id="ui-chat-navigation"/);
  assert.match(drawer,/role="dialog"/);
  assert.match(drawer,/aria-modal="true"/);
  assert.match(drawer,/tabindex="-1"/);
});

test('shared mobile drawer lifecycle focuses in, traps Tab, closes on Escape, restores focus, and isolates content',()=>{
  assert.match(hook,/background\.inert=true/);
  assert.match(hook,/background\.setAttribute\('aria-hidden','true'\)/);
  assert.match(hook,/const first=focusable\(\)\[0\];\(first\?\?drawer\)\.focus\(\)/);
  assert.match(hook,/event\.key==='Escape'/);
  assert.match(hook,/event\.key!=='Tab'/);
  assert.match(hook,/last\.focus\(\)/);
  assert.match(hook,/first\.focus\(\)/);
  assert.match(hook,/if\(trigger\?\.isConnected\)trigger\.focus\(\)/);
  assert.match(hook,/background\.inert=priorInert/);
});

test('chat and admin wire the shared lifecycle to their exact responsive breakpoint and backdrop',()=>{
  assert.match(chatApp,/mediaQuery:'\(max-width: 1023px\)'/);
  assert.match(chatApp,/ref=\{workspaceRef\}/);
  assert.match(chatApp,/sidebarActive && <div className="ui-sidebar-backdrop"/);
  assert.match(admin,/navigationOpen=\{menuActive\}/);
  assert.match(admin,/navigationControls="ui-admin-navigation"/);
  assert.match(admin,/navigationTriggerRef=\{menuTriggerRef\}/);
  assert.match(topBar,/aria-expanded=\{navigationOpen\}/);
  assert.match(topBar,/aria-controls=\{navigationControls\}/);
  assert.match(admin,/id="ui-admin-navigation" ref=\{menuRef\}/);
  assert.match(admin,/mediaQuery:'\(max-width: 1023px\)'/);
  assert.match(admin,/menuActive&&<div className="ui-admin-nav-backdrop"[^>]+onClick=\{\(\)=>setMenu\(false\)\}/);
  assert.match(admin,/main ref=\{mainRef\}/);
});

test('closed off-canvas navigation is not clickable or keyboard-visible at mobile sizes',()=>{
  assert.match(chatCss,/@media \(max-width:1023px\)[\s\S]*?\.ui-sidebar\{[^}]*visibility:hidden[^}]*pointer-events:none/s);
  assert.match(chatCss,/\.ui-sidebar\.is-open\{[^}]*visibility:visible[^}]*pointer-events:auto/s);
  assert.match(adminCss,/@media \(max-width:1023px\)\{[\s\S]*?\.ui-admin aside\{[^}]*visibility:hidden[^}]*pointer-events:none/s);
  assert.match(adminCss,/@media \(max-width:1023px\)\{[\s\S]*?\.ui-admin-nav-backdrop\{[^}]*display:block/s);
  assert.match(adminCss,/\.ui-admin aside\.open\{[^}]*visibility:visible[^}]*pointer-events:auto/s);
});
