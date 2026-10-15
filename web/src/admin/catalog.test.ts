import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Permission } from '@shared/api.js';
import { TENANT_PERMISSIONS } from '@shared/permissions.js';
import { routeDefinitions } from '@routes/catalog.js';
import { catalogues } from '../i18n/catalogues.js';

import { BASE } from './api.js';
import { canAccess, canWrite, SCREENS } from './catalog.js';

// Checked against the server's own route table rather than a list of prefixes kept in step by hand.
// The prefix check passed while the console was completely broken: `/api/admin/*` of a server that
// only answers `/api/v1/*`; paths under mounted groups must still exist in the server catalogue.
const GET_ROUTES=new Map(routeDefinitions.filter(route=>route.method==='GET').map(route=>[route.path,route]));
const MUTATIONS=routeDefinitions.filter(route=>route.method!=='GET');

test('admin catalog has unique canonical routes and complete table contracts',()=>{
 assert.equal(new Set(SCREENS.map(screen=>screen.path)).size,SCREENS.length);
 for(const screen of SCREENS){
  assert.match(screen.path,/^\/admin(?:\/[^/]+)?$/);
  assert.ok(screen.description.length>10);
  assert.ok(screen.empty.length>10);
  if(screen.key!=='overview') assert.ok(screen.columns.length>=4,`${screen.key} must declare its table columns`);
 }
});

test('compliance is a registered protection screen backed by its read endpoint',()=>{
 const compliance=SCREENS.find(screen=>screen.key==='compliance');
 assert.ok(compliance);assert.equal(compliance.group,'protection');assert.equal(compliance.path,'/admin/compliance');assert.equal(compliance.endpoint,'/admin/compliance');assert.equal(compliance.permission,'policy:read');
 const consoleSource=readFileSync(new URL('./AdminConsole.tsx',import.meta.url),'utf8');
 assert.match(consoleSource,/key:'protection',screens:\['policies','custom-terms','compliance','detectors'\]/);
});

test('grouped navigation exposes every screen without a duplicate subnav',()=>{
 const source=readFileSync(new URL('./AdminConsole.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/ui-subnav|breadcrumb/i);
 assert.match(source,/<nav aria-label=\{t\('admin\.shell\.navigation'\)\}/);
 for(const group of ['protection','review','records','organization','models','settings'])
  assert.match(source,new RegExp(`key:'${group}'`));
 for(const screen of SCREENS)
  assert.match(source,new RegExp(`'${screen.key}'`));
});

test('every screen addresses a route the server actually serves',()=>{
 assert.equal(BASE,'/api/v1');
 for(const screen of SCREENS){
  assert.match(screen.endpoint,/^\/[a-z]/,`${screen.key} endpoint must be an absolute path`);
  assert.ok(GET_ROUTES.has(screen.endpoint),`${screen.key} points at GET ${screen.endpoint}, which server/src/routes/catalog.ts does not route`);
 }
});

test('every screen asks for the permission its route enforces',()=>{
 for(const screen of SCREENS){
  // Widened to the server's vocabulary deliberately so route and screen permissions are compared
  // from the same source of truth.
  const required:readonly Permission[]=Array.isArray(screen.permission)?screen.permission:[screen.permission];
  const enforced=GET_ROUTES.get(screen.endpoint)!.permission;
  // A screen that hides itself from a caller the server would have served is a feature nobody can
  // find; one that shows itself to a caller the server refuses is a 403 on click.
  if(enforced) assert.ok(required.includes(enforced),`${screen.key} requires ${required.join(' or ')} but ${screen.endpoint} enforces ${enforced}`);
  if(screen.write===undefined) continue;
  const writes=MUTATIONS.filter(route=>route.path===screen.endpoint||route.path===`${screen.endpoint}/:id`);
  if(writes.length) assert.ok(writes.some(route=>route.permission===screen.write),
   `${screen.key} writes with ${screen.write} but ${screen.endpoint} mutations enforce ${[...new Set(writes.map(route=>route.permission))].join(', ')}`);
 }
});

// `screen.endpoint` is only the table's read route. The screens also call adminGet/adminMutate with
// paths written by hand, and those are the ones that rot: the policy editor shipped Publish, Roll
// back and a version-history fetch against /gate/rules/:id/{publish,rollback,versions}, and the
// generic screen's primary action posted to /admin/models/refresh. The server routes none of the
// four, so every one of those controls answered 404.
const SCREEN_SOURCES=readdirSync(fileURLToPath(new URL('.',import.meta.url)))
 .filter(name=>/\.tsx?$/.test(name)&&!name.endsWith('.test.ts'))
 .map(name=>[name,readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8')] as const);
const wildcard=(path:string)=>path.replace(/\$\{[^}]*\}/g,':id').replace(/\/:[A-Za-z]+/g,'/:id');
const ROUTED=new Set(routeDefinitions.map(route=>wildcard(route.path)));

test('every path the console calls by hand is one the server routes',()=>{
 const called=SCREEN_SOURCES.flatMap(([file,source])=>
  [...source.matchAll(/admin(?:Get|Mutate)[^(]*\(\s*(['"`])(\/[^'"`]+)\1/g)].map(match=>[file,match[2]!] as const));
 assert.ok(called.length>=6,'the source scan found no API calls, so this test would pass vacuously');
 for(const [file,path] of called)
  assert.ok(ROUTED.has(wildcard(path)),`${file} calls ${path}, which server/src/routes/catalog.ts does not route`);
});

// Structural completeness type-checks while shipping English to Japanese readers, and the repo's own
// i18n gate only flags a run of four or more Latin letters -- which "Yes", "No" and "Not set" slipped
// straight through, so those three rendered untranslated in all three non-English consoles.
test('every admin string is translated in every locale',()=>{
 const flatten=(node:object,prefix=''):Array<[string,string]>=>Object.entries(node).flatMap(([key,value])=>
  typeof value==='string'?[[`${prefix}${key}`,value] as [string,string]]:flatten(value as object,`${prefix}${key}.`));
 const english=new Map(flatten(catalogues.en.admin));
 // An em dash is the same glyph in every language; it is the one admin string that may match English.
 const SHARED=new Set([
  'common.dash',
 ]);
 for(const locale of ['zh-TW','ja'] as const){
  const translated=new Map(flatten(catalogues[locale].admin));
  for(const [key,text] of english){
   const value=translated.get(key);
   assert.ok(value!==undefined,`${locale} is missing admin.${key}`);
   if(!SHARED.has(key)&&/[A-Za-z]/.test(text))
    assert.notEqual(value,text,`${locale} leaves admin.${key} in English -- "${text}"`);
  }
 }
});

test('every screen names a permission a tenant role can actually hold',()=>{
 const real=new Set<string>(TENANT_PERMISSIONS);
 for(const screen of SCREENS)
  for(const permission of [...(Array.isArray(screen.permission)?screen.permission:[screen.permission]),...(screen.write?[screen.write]:[])])
   assert.ok(real.has(permission),`${screen.key} requires ${permission}, which no tenant role can be granted`);
});

test('capability checks use real permissions and support either-of asset access',()=>{
 const users=SCREENS.find(screen=>screen.key==='users')!;
 const providers=SCREENS.find(screen=>screen.key==='providers')!;
 const assets=SCREENS.find(screen=>screen.key==='assets')!;
 const analytics=SCREENS.find(screen=>screen.key==='analytics')!;
 assert.equal(canAccess(users,['admin:users']),true);
 assert.equal(canAccess(users,['admin:groups']),false);
 assert.equal(canAccess(assets,['skill:read']),true);
 assert.equal(canAccess(assets,[]),false);
 assert.equal(canWrite(users,['admin:users']),true);
 assert.equal(canWrite(users,['audit:read']),false);
 assert.equal(canWrite(providers,['admin:settings']),false);
 assert.equal(canWrite(providers,['model:write']),true);
 // Reporting screens mutate nothing, so no grant may reveal a write control on them.
 assert.equal(analytics.write,undefined);
 assert.equal(canWrite(analytics,['audit:read','admin:settings']),false);
});

test('provider credentials use the tenant settings boundary and never render stored secrets',()=>{
 const source=readFileSync(new URL('forms.tsx',import.meta.url),'utf8');
 for(const method of ['PUT','DELETE']){
  const route=routeDefinitions.find(definition=>definition.method===method&&definition.path==='/admin/providers/:providerId/credential');
  assert.equal(route?.permission,'admin:settings',`${method} credential route must require tenant settings access`);
  assert.equal(route?.idempotency,true,`${method} credential route must require a retry key`);
 }
 assert.match(source,/type="password"/);
 assert.match(source,/autoComplete="new-password"/);
 assert.doesNotMatch(source,/maskedSuffix|masked_suffix/);
});
