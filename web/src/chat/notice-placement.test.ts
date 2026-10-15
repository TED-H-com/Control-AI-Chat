// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the chat notice stack stays in normal flow',()=>{
  const css=readFileSync(new URL('./chat.css',import.meta.url),'utf8');
  const blocks=css.match(/\.ui-notice-stack\s*\{[^}]*\}/g);
  assert.ok(blocks&&blocks.length>=2,'desktop and narrow notice stacks are both styled');
  for(const block of blocks)assert.doesNotMatch(block,/position:\s*(?:fixed|absolute)/u,block);
});
