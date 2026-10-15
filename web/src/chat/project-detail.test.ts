// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRoute } from './routes.js';
import { createTranslator } from '../i18n/runtime.js';

test('project routes preserve a decoded detail id and reject unknown nested routes',()=>{
  assert.deepEqual(parseChatRoute('/projects'),{view:'projects',id:null});
  assert.deepEqual(parseChatRoute('/projects/vendor%20risk'),{view:'projects',id:'vendor risk'});
  assert.equal(parseChatRoute('/projects/%E0%A4%A'),null);
  assert.equal(parseChatRoute('/skills/unused'),null);
});

test('project file and conversation counts pluralize independently without changing CJK order',()=>{
  const en=createTranslator('en');
  assert.equal(en('chat.project.fileCount',{count:1,formattedCount:'1'}),'1 file');
  assert.equal(en('chat.project.fileCount',{count:2,formattedCount:'2'}),'2 files');
  assert.equal(en('chat.project.conversationCount',{count:1,formattedCount:'1'}),'1 conversation');
  assert.equal(en('chat.project.conversationCount',{count:8,formattedCount:'8'}),'8 conversations');
  assert.equal(createTranslator('zh-TW')('chat.project.fileCount',{count:1,formattedCount:'1'}),'1 個檔案');
  assert.equal(createTranslator('ja')('chat.project.fileCount',{count:1,formattedCount:'1'}),'ファイル 1 件');
});
