// @ts-nocheck -- stylesheet contract test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('Japanese short prose uses phrase-aware wrapping without targeting controls or table cells',()=>{
 for(const path of ['../admin/admin.css','../chat/chat.css']){
  const css=readFileSync(new URL(path,import.meta.url),'utf8'),rule=css.match(/:lang\(ja\) :is\([\s\S]*?\)\s*\{\s*word-break:\s*auto-phrase;\s*\}/u)?.[0]??'';
  assert.ok(rule,path);assert.doesNotMatch(rule,/\b(?:button|input|textarea|select|td|th|code)\b/u,path);
  if(path.endsWith('/chat.css'))assert.match(rule,/\.ui-receipt p/u,path);
 }
});
