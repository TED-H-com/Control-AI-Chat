// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../i18n/runtime.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { chatApi } from './api.js';
import { ArchivedConversationsPage, ConversationDialog } from './ConversationManagement.js';
import { Sidebar } from './Sidebar.js';

const conversation = {
  id:'owned/one?tab=#history', projectId:null, title:'Quarterly review', status:'active', pinned:false,
  createdAt:'2026-08-09T12:00:00.000Z', updatedAt:'2026-08-09T13:00:00.000Z', deletedAt:null,
  messageCount:3, version:17,
};

test('conversation mutations URL-encode ownership ids and send a fresh idempotency key with the record version', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input,init={}) => {
    calls.push({url:String(input),init});
    if (init.method === 'DELETE') return new Response(null,{status:204});
    return new Response(JSON.stringify({...conversation,version:conversation.version+calls.length}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    await chatApi.updateConversation(conversation.id,{title:'Renamed'},17);
    await chatApi.updateConversation(conversation.id,{pinned:true},18);
    await chatApi.updateConversation(conversation.id,{status:'archived'},19);
    await chatApi.updateConversation(conversation.id,{status:'active'},20);
    await chatApi.deleteConversation(conversation.id,21);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length,5);
  const keys = new Set();
  for (const [index,call] of calls.entries()) {
    assert.equal(call.url,'/api/v1/conversations/owned%2Fone%3Ftab%3D%23history');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('If-Match'),`"${17+index}"`);
    const key = headers.get('Idempotency-Key');
    assert.match(key,/^[0-9a-f-]{36}$/i);
    keys.add(key);
  }
  assert.equal(keys.size,calls.length,'retries and distinct actions must not accidentally share a key');
  assert.deepEqual(calls.slice(0,4).map(call=>JSON.parse(call.init.body)),[
    {title:'Renamed'},{pinned:true},{status:'archived'},{status:'active'},
  ]);
  assert.equal(calls[4].init.method,'DELETE');
});

test('conversation controls stay compact while archived conversations expose an explicit restore command', () => {
  const t = createTranslator('en');
  Object.defineProperty(globalThis,'location',{value:{pathname:'/chat'},configurable:true});
  Object.defineProperty(globalThis,'navigator',{value:{languages:['en'],language:'en'},configurable:true});
  const sidebar = renderToStaticMarkup(createElement(I18nProvider,null,createElement(Sidebar,{
    open:true,conversations:[conversation],projects:[],activeId:conversation.id,archivedActive:false,
    busyId:null,locale:'en',t,onNavigate:()=>{},onAction:()=>{},onClose:()=>{},
  })));
  assert.match(sidebar,/aria-haspopup="menu"/);
  assert.match(sidebar,/aria-label="Actions for Quarterly review"/);
  assert.doesNotMatch(sidebar,/>Rename</,'closed rows expose one icon, not a permanent action toolbar');

  const archived = renderToStaticMarkup(createElement(ArchivedConversationsPage,{
    conversations:[{...conversation,status:'archived'}],locale:'en',busyId:null,t,onRestore:()=>{},onAction:()=>{},
  }));
  assert.match(archived,/Archived conversations/);
  assert.match(archived,/>Restore</);
  assert.match(archived,/aria-haspopup="menu"/);
});

test('menus and dialogs include keyboard, focus, dismissal, and bounded rename behavior', () => {
  const source = readFileSync(new URL('ConversationManagement.tsx',import.meta.url),'utf8');
  for (const behavior of ['ArrowDown','ArrowUp','Home','End','Escape','pointerdown','data-dialog-initial','maxLength={500}','aria-modal="true"']) assert.match(source,new RegExp(behavior.replace(/[{}]/g,'\\$&')));
  const css = readFileSync(new URL('chat.css',import.meta.url),'utf8').replace(/\s+/g,' ').replace(/\s*([{}:;,>])\s*/g,'$1');
  assert.match(css,/\.ui-settings-actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:/s);
  assert.match(css,/@media \(max-width:767px\)[\s\S]*\.ui-archive-list>li\{[^}]*grid-template-columns:1fr/);
});

test('delete confirmation and uncertain failures do not overstate what happened', () => {
  const t = createTranslator('en');
  const html = renderToStaticMarkup(createElement(ConversationDialog,{
    state:{kind:'delete',conversation},busy:false,error:null,t,onClose:()=>{},onRename:()=>{},onDelete:()=>{},
  }));
  assert.match(html,/role="dialog"/);
  assert.match(html,/retention policy determines when its content is purged/);
  assert.match(html,/>Delete</);
  assert.match(t('chat.conversation.error.uncertain'),/could not be confirmed/);
  assert.doesNotMatch(t('chat.conversation.error.uncertain'),/was not changed/);
});
