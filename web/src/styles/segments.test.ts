// @ts-nocheck -- stylesheet contract test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const primitives=readFileSync(new URL('components/primitives.css',import.meta.url),'utf8');
const admin=readFileSync(new URL('../admin/admin.css',import.meta.url),'utf8');

test('segmented controls expose pointer, hover, active, disabled and coarse-pointer states',()=>{
 assert.match(primitives,/\.ui-segments label\s*\{[^}]*cursor:\s*pointer/u);
 assert.match(primitives,/\.ui-segments label:hover input:not\(:checked\):not\(:disabled\)\+span\s*\{[^}]*background:\s*var\(--panel-2\)/u);
 assert.match(primitives,/\.ui-segments label:active input:not\(:disabled\)\+span\s*\{[^}]*background:\s*var\(--primary-soft\)/u);
 assert.match(primitives,/\.ui-segments input:disabled\+span\s*\{[^}]*background:\s*var\(--panel-2\)[^}]*color:\s*var\(--muted\)/u);
 assert.match(primitives,/@media \(pointer:coarse\)[\s\S]*?\.ui-segments label\s*\{[^}]*height:\s*44px[^}]*align-items:\s*flex-end/u);
 assert.match(primitives,/@media \(pointer:coarse\)[\s\S]*?\.ui-segments input\s*\{[^}]*inset:\s*0[^}]*height:\s*100%/u);
 assert.match(admin,/@media \(pointer:coarse\)[\s\S]*?\.ui-admin \.ui-segments label\s*\{[^}]*height:\s*44px[^}]*align-items:\s*flex-end/u);
 assert.match(admin,/@media \(pointer:coarse\)[\s\S]*?\.ui-admin \.ui-segments input\s*\{[^}]*inset:\s*0[^}]*height:\s*100%/u);
});
