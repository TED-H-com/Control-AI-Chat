// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const normalizeCss=(source:string)=>source.replace(/\s+/g,' ').replace(/\s*([{}:;,>])\s*/g,'$1');
const css=normalizeCss(readFileSync(new URL('../admin/admin.css',import.meta.url),'utf8'));const recovery=normalizeCss(readFileSync(new URL('./components/recovery.css',import.meta.url),'utf8'));
test('pre-console admin states inherit global modes and expose one tokenized recovery action',()=>{assert.doesNotMatch(css,/--admin-|prefers-color-scheme/);assert.match(recovery,/\.ui-app-failure,\.ui-boot\{[^}]*background:var\(--bg\)[^}]*color:var\(--text\)/);assert.match(recovery,/\.ui-app-failure__panel button,\.ui-boot button\{[^}]*background:var\(--primary\)[^}]*color:var\(--on-primary\)/);});
