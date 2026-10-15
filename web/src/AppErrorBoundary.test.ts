// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { AppErrorBoundary, AppFailurePanel, appRecoveryCopy } from './AppErrorBoundary.js';

test('the root recovery panel is localized and offers a real reload action',()=>{
  const html=renderToStaticMarkup(createElement(AppFailurePanel,{locale:'zh-TW',onReload(){}}));
  assert.match(html,/role="alert"/);
  assert.match(html,/這個畫面發生問題/);
  assert.match(html,/type="button"/);
  assert.match(html,/重新載入/);
  assert.equal(appRecoveryCopy('ja').reload,'再読み込み');
});

test('the root boundary switches to recovery state after a descendant error',()=>{
  assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(new Error('render failed')),{failed:true});
  const entry=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(entry,/<AppErrorBoundary><App\/><\/AppErrorBoundary>/);
});
