import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../i18n/runtime.js';
import { MarkdownContent, safeMarkdownUrl } from './MarkdownContent.js';

test('chat markdown renders block and inline elements without interpreting HTML',()=>{
  const text='# Heading\n\n**bold** and *italic* and `code` [safe](https://example.com) [bad](javascript:alert)\n\n- one\n- two\n\n> quote\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>';
  const html=renderToStaticMarkup(createElement(MarkdownContent,{text,t:createTranslator('en')}));
  for(const tag of ['h1','strong','em','code','ul','li','blockquote','hr','table','thead','tbody','pre'])assert.match(html,new RegExp(`<${tag}`));
  assert.match(html,/href="https:\/\/example\.com" rel="noopener noreferrer"/);
  assert.doesNotMatch(html,/javascript:/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unterminated streaming fences render safely as the current code block',()=>{
  const html=renderToStaticMarkup(createElement(MarkdownContent,{text:'```js\nconst partial =',t:createTranslator('en')}));
  assert.match(html,/class="ui-code"/);assert.match(html,/const partial =/);
});

test('markdown links reject active and unknown protocols',()=>{
  assert.equal(safeMarkdownUrl('javascript:alert(1)'),undefined);
  assert.equal(safeMarkdownUrl('data:text/html,bad'),undefined);
  assert.equal(safeMarkdownUrl('https://example.com'),'https://example.com');
  assert.equal(safeMarkdownUrl('/relative'),'/relative');
});

test('nested ordered and unordered lists render inside their parent items',()=>{
  const text='- Top item\n    - Nested one\n    - Nested two\n- Second top\n    1. First ordered\n    2. Second ordered';
  const html=renderToStaticMarkup(createElement(MarkdownContent,{text,t:createTranslator('en')}));
  assert.equal(html,'<ul><li>Top item<ul><li>Nested one</li><li>Nested two</li></ul></li><li>Second top<ol><li>First ordered</li><li>Second ordered</li></ol></li></ul>');
});

test('underscores inside snake_case identifiers do not create emphasis',()=>{
  const html=renderToStaticMarkup(createElement(MarkdownContent,{text:'Use the my_var_name and other_thing here. Also _emphasis_.',t:createTranslator('en')}));
  assert.equal(html,'<p>Use the my_var_name and other_thing here. Also <em>emphasis</em>.</p>');
});

test('links consume one level of balanced parentheses even when rejected',()=>{
  const text='[click](javascript:alert(1)) and [wiki](https://en.wikipedia.org/wiki/Foo_(bar))';
  const html=renderToStaticMarkup(createElement(MarkdownContent,{text,t:createTranslator('en')}));
  assert.equal(html,'<p>click and <a href="https://en.wikipedia.org/wiki/Foo_(bar)" rel="noopener noreferrer">wiki</a></p>');
});

test('protocol-relative URLs are rejected while same-origin paths remain safe',()=>{
  assert.equal(safeMarkdownUrl('//evil.com'),undefined);
  assert.equal(safeMarkdownUrl('/\\evil.com'),undefined);
  assert.equal(safeMarkdownUrl('/admin/users'),'/admin/users');
});
