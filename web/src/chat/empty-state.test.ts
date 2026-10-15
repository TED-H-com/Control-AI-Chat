// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../i18n/runtime.js';
import { canConfigureProviders } from './access.js';
import { NoModelsChat } from './Pages.js';

test('provider setup is offered only when both provider-screen permissions are present',()=>{
  assert.equal(canConfigureProviders(null),false);
  assert.equal(canConfigureProviders({permissions:[]}),false);
  assert.equal(canConfigureProviders({permissions:['admin:users']}),false);
  assert.equal(canConfigureProviders({permissions:['model:read']}),false);
  assert.equal(canConfigureProviders({permissions:['model:write']}),false);
  assert.equal(canConfigureProviders({permissions:['model:read','model:write']}),true);
});

test('no-model admin state links to provider setup without rendering unusable prompts',()=>{
  const t=createTranslator('en');
  const html=renderToStaticMarkup(createElement(NoModelsChat,{t,canConfigure:true,support:null}));
  assert.match(html,/No AI models are ready/);
  assert.match(html,/Configure AI providers/);
  assert.match(html,/href="\/admin\/providers"/);
  assert.doesNotMatch(html,/ui-prompts/);
});

test('no-model member state never exposes the admin route and shows configured support',()=>{
  const t=createTranslator('en');
  const html=renderToStaticMarkup(createElement(NoModelsChat,{
    t,
    canConfigure:false,
    support:{vendorName:'Workspace Help',email:'help@example.test',phone:'+1 555 0100',url:'https://support.example.test',notes:'Include your workspace name.'},
  }));
  assert.match(html,/Contact your workspace administrator/);
  assert.match(html,/Workspace Help/);
  assert.match(html,/mailto:help@example\.test/);
  assert.match(html,/https:\/\/support\.example\.test/);
  assert.doesNotMatch(html,/\/admin\/providers/);
  assert.doesNotMatch(html,/ui-prompts/);
});

test('no-model guidance is present in every supported locale',()=>{
  for(const locale of ['en','zh-TW','ja'] as const){
    const t=createTranslator(locale);
    const admin=renderToStaticMarkup(createElement(NoModelsChat,{t,canConfigure:true,support:null}));
    const member=renderToStaticMarkup(createElement(NoModelsChat,{t,canConfigure:false,support:null}));
    assert.match(admin,new RegExp(t('chat.empty.noModelsTitle')));
    assert.match(admin,new RegExp(t('chat.empty.noModelsAdminBody')));
    assert.match(member,new RegExp(t('chat.empty.noModelsMemberBody')));
    assert.doesNotMatch(member,/\/admin\/providers/);
  }
});

test('chat shell replaces empty suggestions and composer when no enabled model exists',()=>{
  const source=readFileSync(new URL('./ChatApp.tsx',import.meta.url),'utf8');
  assert.match(source,/availableModels=useMemo\(\(\)=>data\.models\.filter\(model=>model\.enabled\)/);
  assert.match(source,/availableModels\.length===0\s*\? <NoModelsChat/);
  assert.match(source,/current\.view === 'chat' && availableModels\.length>0 && <Composer/);
  assert.match(source,/models=\{availableModels\}/);
});
