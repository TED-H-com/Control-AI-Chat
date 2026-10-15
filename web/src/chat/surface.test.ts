// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../i18n/runtime.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { applyComposerSelection, Composer, shouldSendComposerKey } from './Composer.js';
import { MessageList, isFollowingBottom, PIN_SLACK } from './MessageList.js';
import { RunWarningDialog } from './Dialogs.js';
import { availableProviders, initialModel, preferredModel, reasoningEffort, supportsEffortForSelection } from './routing.js';
import { EmptyChat, SearchResult, SEARCH_DEBOUNCE_MS, searchableConversationQuery } from './Pages.js';
import { collectConversationSearch, conversationListPath } from './api.js';
import { hasAdminAccess, Sidebar } from './Sidebar.js';

const css = readFileSync(new URL('chat.css', import.meta.url), 'utf8');
const compactCss = css.replace(/\s+/g,' ').replace(/\s*([{}:;,>])\s*/g,'$1');
const topbarCss = readFileSync(new URL('../styles/components/topbar.css', import.meta.url), 'utf8').replace(/\s+/g,' ').replace(/\s*([{}:;,>])\s*/g,'$1');
const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const chatApp = readFileSync(new URL('ChatApp.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('Composer.tsx', import.meta.url), 'utf8');
const chatApiSource = readFileSync(new URL('api.ts', import.meta.url), 'utf8');
const pages = readFileSync(new URL('Pages.tsx', import.meta.url), 'utf8');
const livePrompt={id:'live-user',conversationId:'c',parentMessageId:null,role:'user',content:'Test',modelId:null,provider:null,createdAt:'2026-09-28T12:00:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};
Object.defineProperty(globalThis,'location',{value:{pathname:'/chat'},configurable:true});
Object.defineProperty(globalThis,'navigator',{value:{languages:['en'],language:'en'},configurable:true});
const withI18n=(child:ReturnType<typeof createElement>)=>createElement(I18nProvider,null,child);

test('conversation search builds a scoped title query and debounces only searchable input', () => {
  assert.equal(conversationListPath({status:'archived',q:'vendor risk',cursor:'next/value',limit:50}),'/api/v1/conversations?limit=50&status=archived&q=vendor+risk&cursor=next%2Fvalue');
  assert.equal(searchableConversationQuery(' a '),null);
  assert.equal(searchableConversationQuery(' 搜尋 '),'搜尋');
  assert.equal(SEARCH_DEBOUNCE_MS,250);
});

test('conversation search reads the flat wire envelope and returns an archived title match', async () => {
  const calls=[];
  const archived={id:'330fcf3e-0000-0000-0000-000000000000',title:'Threat model file ingestion',status:'archived',updatedAt:'2026-07-21T00:00:00.000Z'};
  const results=await collectConversationSearch('Threat',async options=>{
    calls.push(options);
    if(options.status==='active')return{data:[],hasMore:false,nextCursor:null};
    return{data:[archived],hasMore:false,nextCursor:null};
  });
  assert.deepEqual(calls,[
    {status:'active',q:'Threat',cursor:null,limit:200},
    {status:'archived',q:'Threat',cursor:null,limit:200},
  ]);
  assert.deepEqual(results,[archived]);

  const pagedCalls=[];
  const item=(id,updatedAt)=>({id,title:id,updatedAt});
  const pagedResults=await collectConversationSearch('billing',async options=>{
    pagedCalls.push(options);
    if(options.status==='active'&&!options.cursor)return{data:[item('active-old','2025-01-01T00:00:00.000Z')],hasMore:true,nextCursor:'active-next'};
    if(options.status==='active')return{data:[item('active-new','2025-03-01T00:00:00.000Z')],hasMore:false,nextCursor:null};
    return{data:[],hasMore:false,nextCursor:null};
  });
  assert.deepEqual(pagedCalls,[
    {status:'active',q:'billing',cursor:null,limit:200},
    {status:'archived',q:'billing',cursor:null,limit:200},
    {status:'active',q:'billing',cursor:'active-next',limit:200},
  ]);
  assert.deepEqual(pagedResults.map(item=>item.id),['active-new','active-old']);
});

test('conversation search quietly marks archived results in every locale',()=>{
  const conversation={id:'archived-1',title:'Threat model file ingestion',status:'archived',updatedAt:'2026-07-21T00:00:00.000Z'};
  for(const [locale,label] of [['en','Archived'],['zh-TW','已封存'],['ja','アーカイブ済み']]){
    const html=renderToStaticMarkup(createElement(SearchResult,{conversation,locale,t:createTranslator(locale),onOpen:()=>{}}));
    assert.match(html,new RegExp(`class="ui-search-badge">${label}<`));
  }
  const active=renderToStaticMarkup(createElement(SearchResult,{conversation:{...conversation,status:'active'},locale:'en',t:createTranslator('en'),onOpen:()=>{}}));
  assert.doesNotMatch(active,/ui-search-badge/);
});

test('message actions reveal on desktop focus and remain visible to touch users', () => {
  assert.match(compactCss,/\.ui-message-actions\{[^}]*opacity:0/);
  assert.match(css,/\.ui-message-row:hover\s+\.ui-message-actions,\s*\.ui-message-row:focus-within\s+\.ui-message-actions\s*\{\s*opacity:\s*1/);
  assert.match(css,/@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.ui-message-actions\s*\{[^}]*opacity:\s*1/,'a coarse pointer needs an opacity-one rule of its own');
  assert.match(css,/@media\s+print\s*\{[\s\S]*?\.ui-message-actions,\s*\.ui-jump\s*\{[^}]*display:\s*none\s*!important/,'print must omit controls while retaining ledger evidence');
});

test('the checking checkpoint appears only during the real gating phase in every locale', () => {
  const noise = console.error; console.error = () => {};
  try {
    for (const locale of ['en','zh-TW','ja']) {
      const t = createTranslator(locale);
      const props = {messages:[livePrompt],showMetadata:false,locale,t,onEdit:()=>{},onRegenerate:()=>{}};
      const gating = renderToStaticMarkup(createElement(MessageList,{...props,streamPhase:'gating'}));
      assert.match(gating,/class="ui-live-gate" role="status" aria-live="polite"/);
      assert.ok(gating.includes(t('chat.stamp.checking')),`${locale} must render its checking checkpoint`);
      const streaming = renderToStaticMarkup(createElement(MessageList,{...props,streamPhase:'streaming',streamStatus:t('chat.message.responding')}));
      assert.doesNotMatch(streaming,new RegExp(t('chat.stamp.checking').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
      assert.ok(streaming.includes(t('chat.stamp.cleared')),`${locale} must show a cleared checkpoint after streaming starts without a notice`);
    }
  } finally { console.error = noise; }
});

test('checkpoint accessible names use each catalogue separator and retain the visible stamp text',()=>{
  const message={...livePrompt,gate:{decisionId:'decision',action:'redact',direction:'outbound',detectorCount:1,protectedItemCount:2,approvalId:null,userNotice:null}};
  const noise=console.error;console.error=()=>{};
  try{for(const [locale,expected] of [['en','Checkpoint: '],['zh-TW','檢查結果：'],['ja','確認結果：']] as const){const t=createTranslator(locale),html=renderToStaticMarkup(createElement(MessageList,{messages:[message],showMetadata:false,locale,t,onEdit:()=>{},onRegenerate:()=>{}}));assert.ok(html.includes(`<span class="ui-sr">${expected}</span>${t('chat.stamp.redact',{count:2})}`),`${locale} accessible prefix must come entirely from its catalogue`);}}
  finally{console.error=noise;}
});

test('the transcript follows the stream only while the reader is at the bottom', () => {
  const viewport = { scrollHeight: 4000, clientHeight: 800 };
  assert.equal(isFollowingBottom({ ...viewport, scrollTop: 3200 }), true, 'pinned to the bottom');
  assert.equal(isFollowingBottom({ ...viewport, scrollTop: 3199.5 }), true, 'fractional scrollTop under browser zoom is still the bottom');
  assert.equal(isFollowingBottom({ ...viewport, scrollTop: 3200 - PIN_SLACK - 1 }), false, 'scrolled up to re-read');
  assert.equal(isFollowingBottom({ ...viewport, scrollTop: 0 }), false, 'reading from the top of a long answer');
});

test('response headers use neutral model and provider names with a safe fallback', () => {
  const t=createTranslator('en');
  const knownModel=model('model-1','anthropic',{displayName:'Claude Opus 4.5'});
  const assistant={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'Answer',modelId:'model-1',provider:'anthropic',createdAt:new Date().toISOString(),inputTokens:1,outputTokens:1,costUsd:0.01,gate:null,attachments:[],version:1};
  const render=message=>renderToStaticMarkup(createElement(MessageList,{messages:[message],models:[knownModel],showMetadata:false,locale:'en',t,onEdit:()=>{},onRegenerate:()=>{}}));
  const noise=console.error;console.error=()=>{};
  try {
    const completed=render(assistant);
    assert.match(completed,/Claude Opus 4\.5/);
    assert.match(completed,/>Anthropic</);
    assert.match(render({...assistant,modelId:'missing'}),/<strong>Model<\/strong><span>Anthropic<\/span>/);
    assert.match(render({...assistant,modelId:'missing',provider:null}),/<strong>Model<\/strong><\/header>/);
    const streaming=renderToStaticMarkup(createElement(MessageList,{messages:[livePrompt],models:[knownModel],streamText:'A',streamStatus:'Responding',streamModelId:'model-1',streamProvider:'anthropic',streamPhase:'streaming',showMetadata:false,locale:'en',t,onEdit:()=>{},onRegenerate:()=>{}}));
    assert.match(streaming,/<strong>Claude Opus 4\.5<\/strong><span>Anthropic<\/span>/);
  } finally {console.error=noise;}
});

test('message.created attributes only the owning streaming run', () => {
  assert.match(chatApp,/case 'message\.created':\s*setRun\(old => applyMessageCreated\(old,event,ownerKey\)\)/s);
  assert.match(chatApp,/run\.ownerKey === ownerKey \? \{\.\.\.run,assistantMessageId:event\.data\.message\.id,modelId:event\.data\.message\.modelId,provider:event\.data\.message\.provider\} : run/);
  assert.doesNotMatch(chatApp,/message\.created[\s\S]{0,300}modelId\)/,'stream attribution must not come from the composer selection');
});

test('a pending approval promises automatic delivery without claiming local dismissal is cancellation', () => {
  const t = createTranslator('en');
  // The server renderer is only a harness here; its standing complaint about useLayoutEffect is
  // about hydration, which this app never does, and it drowns the rest of the run.
  const noise = console.error; console.error = () => {};
  const html = renderToStaticMarkup(createElement(MessageList, {
    messages: [livePrompt], streamPhase:'approval', liveGate:{decisionId:'decision',action:'require_approval',direction:'outbound',detectorCount:1,protectedItemCount:0,approvalId:'approval',userNotice:'SERVER-TEXT-SENTINEL'}, showMetadata: false, locale: 'en', t, onEdit: () => {}, onRegenerate: () => {},
    onDismissApproval: () => {},
  }));
  console.error = noise;
  assert.match(html, /class="ui-receipt ui-receipt--amber"/, 'awaiting approval is a first-class receipt, not a line of text');
  assert.match(html, /Review required/);
  assert.match(html, /recorded for review and has not been sent to a model/, 'the user has to be told what was durably recorded');
  assert.match(html, /automatically appear in this conversation/, 'the requester should know the released result will arrive without resubmitting');
  assert.match(html, /Close notice/);
  assert.doesNotMatch(html, /Cancel approval request/, 'closing a local notice must not claim to cancel a durable request');
  assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/u);
});

test('live block and approval receipts ignore server notice text in every locale', () => {
  const noise = console.error; console.error = () => {};
  for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale);
    for(const [action,phase,key] of [['block','error','chat.gate.blocked.policy'],['require_approval','approval','chat.gate.approval.policy']] as const){const html=renderToStaticMarkup(createElement(MessageList,{messages:[livePrompt],streamPhase:phase,liveGate:{decisionId:`decision-${action}`,action,direction:'outbound',detectorCount:1,protectedItemCount:0,approvalId:action==='require_approval'?'approval':null,userNotice:'SERVER-TEXT-SENTINEL'},showMetadata:false,locale,t,onEdit:()=>{},onRegenerate:()=>{}}));assert.match(html,new RegExp(t(key).replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')),locale);assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/u,locale);}
  }
  console.error = noise;
  assert.doesNotMatch(chatApp, /event\.data\.action === 'block' \? 'idle'/, 'a block notice must not hide the live ledger entry before run.failed arrives');
});

test('the warning dialog ignores the live server notice in every locale',()=>{
  const run={runId:'run-1',conversationId:'conversation-1',assistantMessageId:null,text:'',status:'warning',gate:{decisionId:'decision-1',action:'warn',direction:'outbound',detectorCount:1,protectedItemCount:0,approvalId:null,userNotice:'SERVER-TEXT-SENTINEL'},responseGate:null,warningToken:'token',failure:null,ownerKey:'owner',request:null};
  for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale),html=renderToStaticMarkup(createElement(RunWarningDialog,{visible:true,run,t,onBack:()=>{},onConfirm:()=>{}}));assert.ok(html.includes(t('chat.gate.warning.body')),locale);assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/u,locale);}
  assert.doesNotMatch(chatApp,/<RunWarningDialog[^>]*\bdetail=/u);
});

test('a withheld live response keeps the prompt cleared and exposes no response content or actions',()=>{
  const t=createTranslator('en'),noise=console.error;console.error=()=>{};
  const html=renderToStaticMarkup(createElement(MessageList,{messages:[livePrompt],streamPhase:'error',streamText:'restricted response',streamStatus:'The request was blocked',liveResponseGate:{decisionId:'inbound-decision',action:'warn',direction:'inbound',detectorCount:1,protectedItemCount:0,approvalId:null,userNotice:null},showMetadata:false,locale:'en',t,onEdit:()=>{},onRegenerate:()=>{}}));
  console.error=noise;
  assert.match(html,/data-stamp-kind="cleared"/);
  assert.match(html,/data-stamp-kind="withheld"/);
  assert.match(html,/data-receipt-kind="withheld"[^>]*data-receipt-row="response"/);
  assert.doesNotMatch(html,/restricted response|The request was blocked/);
  assert.match(chatApp,/runAfterFailure\(old,event\.data\)/,'the terminal gate failure decides the withheld state in tested run-state code');
});

const model = (id, provider, overrides = {}) => ({
  id, provider, providerModelId:`provider-${id}`, displayName:`Internal ${id}`, capabilities:['text','reasoning'],
  enabled:true, inputUsdPerMillion:1, outputUsdPerMillion:2, contextTokens:1000,
  maxOutputTokens:100, version:1, isDefault:false, recommendedForProvider:false,
  groupRestriction:null, ...overrides,
});

test('the four-provider picker is a projection of the enforced model allowlist', () => {
  const models = [
    model('openai-legacy', 'openai', { isDefault:true }),
    model('openai-recommended', 'openai', { recommendedForProvider:true }),
    model('anthropic', 'anthropic'),
    model('anthropic-no-effort', 'anthropic', { capabilities:['text'], recommendedForProvider:true }),
    model('google-disabled', 'google', { enabled:false }),
    model('xai', 'xai'),
    model('router', 'openrouter'),
  ];
  assert.deepEqual(availableProviders(models), ['openai', 'anthropic', 'xai']);
  assert.equal(preferredModel(models, 'openai')?.id, 'openai-recommended', 'the server recommendation wins within an allowed provider');
  assert.equal(preferredModel(models, 'openai', 'openai-legacy')?.id, 'openai-legacy', 'the current allowed choice remains stable');
  assert.equal(preferredModel(models, 'google'), null, 'a disabled provider is never invented in the picker');
  assert.equal(initialModel(models, undefined, 'anthropic')?.id, 'anthropic-no-effort', 'the saved layout restores its allowed provider and keeps the server recommendation');
  assert.equal(preferredModel([models[3]], 'anthropic')?.id, 'anthropic-no-effort', 'an allowed model remains usable when effort is unavailable');
});

test('provider routing and persisted appearance are independent choices', () => {
  const routing = readFileSync(new URL('routing.ts', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../appearance/AppearanceSettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(routing, /density|colorMode/);
  assert.doesNotMatch(chatApp, /\bsetDensity\b|\bsetMode\b/);
  assert.match(picker, /name="color-mode"/);
  assert.match(picker, /name="density"/);
});

test('composer exposes mode, effort, preset role, and preset tone selectors', () => {
  const t = createTranslator('en');
  const noise = console.error; console.error = () => {};
  const html = renderToStaticMarkup(createElement(Composer, {
    text:'', onText:()=>{}, models:[model('o','openai'),model('a','anthropic'),model('g','google'),model('x','xai')],
    modelId:'o', onModel:()=>{}, effort:'standard', onEffort:()=>{}, role:'default',onRole:()=>{},tone:'default',onTone:()=>{},streaming:false, disabled:false,
    uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{}, onStop:()=>{}, t,
  }));
  console.error = noise;
  assert.equal((html.match(/<select/g) ?? []).length, 4);
  assert.match(html, /class="ui-provider-select"/);
  assert.match(html, /class="ui-effort-select"/);
  assert.match(html, />Auto</);
  assert.match(html, />Multi-model</);
  for (const provider of ['OpenAI','Anthropic','Google','xAI']) assert.match(html, new RegExp(`>${provider}<`));
  for (const effort of ['Light','Standard','Deep']) assert.match(html, new RegExp(`>${effort}<`));
  for(const label of ['To','Effort','Role','Tone'])assert.match(html,new RegExp(`<label for="[^"]+">${label}</label>`));
  assert.doesNotMatch(html, /Internal [oagx]/, 'internal model modules are not exposed');
  assert.doesNotMatch(css, /:has\(\.ui-effort-select\)/, 'desktop selector specificity must not defeat the mobile grid width');
  assert.equal((composerSource.match(/<ChevronDown size=\{14\}/g) ?? []).length,5,'every composer chevron uses the design-system size');
  assert.doesNotMatch(composerSource,/<ChevronDown size=\{15\}/);
});

test('composer sends on plain Enter but preserves Shift+Enter and IME composition',()=>{
  assert.equal(shouldSendComposerKey('Enter',false,false),true);
  assert.equal(shouldSendComposerKey('Enter',true,false),false);
  assert.equal(shouldSendComposerKey('Enter',false,true),false);
  assert.equal(shouldSendComposerKey('a',false,false),false);
});

test('composer folds governed assistants into the provider picker and clears the binding for auto',()=>{
  const t=createTranslator('en');
  const assistantModel=model('assistant-model','openai');
  const assistant={id:'assistant-1',name:'Policy analyst',description:'Reviews policy',modelId:assistantModel.id,model:assistantModel};
  const noise=console.error;console.error=()=>{};
  try{
    const markup=renderToStaticMarkup(createElement(Composer,{text:'Review',onText:()=>{},models:[assistantModel],modelId:'',onModel:()=>{},assistants:[assistant],assistantId:'assistant-1',onAssistant:()=>{},mode:'single',onMode:()=>{},effort:'standard',onEffort:()=>{},tone:'default',onTone:()=>{},role:'default',onRole:()=>{},streaming:false,disabled:false,uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t}));
    assert.match(markup,/<optgroup label="Assistants">/);
    assert.match(markup,/<option value="assistant:assistant-1" selected="">Policy analyst<\/option>/);
    assert.doesNotMatch(markup,/system.?prompt/i);

    const assistantChanges=[];const modes=[];
    applyComposerSelection('assistant:assistant-1',null,id=>assistantChanges.push(id),mode=>modes.push(mode),()=>{});
    assert.deepEqual(assistantChanges,['assistant-1']);
    applyComposerSelection('auto','assistant-1',id=>assistantChanges.push(id),mode=>modes.push(mode),()=>{});
    assert.deepEqual(assistantChanges,['assistant-1',null]);
    assert.deepEqual(modes,['auto']);

    const emptyMarkup=renderToStaticMarkup(createElement(Composer,{text:'',onText:()=>{},models:[assistantModel],modelId:assistantModel.id,onModel:()=>{},assistants:[],assistantId:null,onAssistant:()=>{},mode:'auto',onMode:()=>{},effort:'standard',onEffort:()=>{},tone:'default',onTone:()=>{},role:'default',onRole:()=>{},streaming:false,disabled:false,uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t}));
    assert.doesNotMatch(emptyMarkup,/<optgroup/);
    assert.doesNotMatch(emptyMarkup,/ui-provider-select"[^>]*disabled/);
  }finally{console.error=noise;}
});

test('an approved plain-chat model remains selectable without advertising effort support', () => {
  const t = createTranslator('en');
  const noise = console.error; console.error = () => {};
  const html = renderToStaticMarkup(createElement(Composer, {
    text:'', onText:()=>{}, models:[model('legacy','openai',{capabilities:['text']})],
    modelId:'legacy', onModel:()=>{}, effort:'standard', onEffort:()=>{}, streaming:false, disabled:false,
    uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{}, onStop:()=>{}, t,
  }));
  console.error = noise;
  assert.match(html, /class="ui-effort-select"[^>]*disabled/);
  assert.match(html, /Effort is not available for this mode/);
});

test('effort availability follows the response mode instead of a stale remembered model', () => {
  const t = createTranslator('en');
  const models = [
    model('plain-openai','openai',{capabilities:['text']}),
    model('reasoning-anthropic','anthropic'),
  ];
  const render = (mode) => renderToStaticMarkup(createElement(Composer, {
    text:'', onText:()=>{}, models, modelId:'plain-openai', onModel:()=>{}, mode, onMode:()=>{},
    effort:'standard', onEffort:()=>{}, streaming:false, disabled:false,
    uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t,
  }));
  const noise = console.error; console.error = () => {};
  try {
    assert.equal(supportsEffortForSelection(models,'auto','plain-openai'),true);
    assert.doesNotMatch(render('auto'),/class="ui-effort-select"[^>]*disabled/,'Auto can route away from the remembered plain-chat model');
    assert.equal(supportsEffortForSelection(models,'single','plain-openai'),false);
    assert.match(render('single'),/class="ui-effort-select"[^>]*disabled/,'a provider with no reasoning candidate must not advertise effort');
    assert.equal(supportsEffortForSelection(models,'multi_model','reasoning-anthropic'),false);
    assert.match(render('multi_model'),/class="ui-effort-select"[^>]*disabled/,'Multi-model has a fixed fast effort');
  } finally { console.error = noise; }
});

test('the no-provider state gives its translated status the space an unused effort control would take', () => {
  const noise = console.error; console.error = () => {};
  try {
    for (const locale of ['en','zh-TW','ja']) {
      const t = createTranslator(locale);
      const html = renderToStaticMarkup(createElement(Composer, {
        text:'', onText:()=>{}, models:[], modelId:'', onModel:()=>{}, effort:'standard', onEffort:()=>{},
        streaming:false, disabled:false, uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{}, onStop:()=>{}, t,
      }));
      assert.match(html, /ui-composer-actions is-empty/);
      assert.equal((html.match(/<select/g) ?? []).length, 1, `${locale} must show only the unavailable provider status when there is no AI to receive persona settings`);
      assert.doesNotMatch(html,/ui-(?:role|tone)-select/,`${locale} must not squeeze unusable persona controls into the mobile composer`);
      assert.ok(html.includes(`>${t('chat.composer.noProvider')}</option>`), `${locale} must show its no-provider status`);
    }
  } finally { console.error = noise; }
  assert.match(compactCss,/\.ui-composer select\{[^}]*width:auto/,'desktop selects keep their natural width');
  assert.match(compactCss,/padding-right:calc\(var\(--space-6\) \+ var\(--space-1\)\)/,'selects reserve room for the chevron');
});

test('upload resets always clear the upload problem with the upload list', () => {
  const reset = chatApp.match(/const resetUploads = \(\):void => \{\s*setUploads\(\[\]\);\s*setUploadProblem\(null\);\s*\};/);
  assert.ok(reset, 'the upload list and notice share one reset function');
  assert.doesNotMatch(chatApp.replace(reset[0], ''), /setUploads\(\[\]\)/, 'no reset site may clear only the upload list');
  assert.equal((chatApp.match(/resetUploads\(\);/g) ?? []).length, 4, 'navigation, settings close, popstate, and send all reset upload state');
});

test('chat exposes the governed attachment affordance and file-only sending', () => {
  const t = createTranslator('en');
  const noise = console.error; console.error = () => {};
  const composer = renderToStaticMarkup(createElement(Composer, {
    text:'Review this note', onText:()=>{}, models:[model('o','openai')], modelId:'o', onModel:()=>{},
    effort:'standard', onEffort:()=>{}, streaming:false, disabled:false, uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{}, onStop:()=>{}, t,
  }));
  const ready = renderToStaticMarkup(createElement(Composer, {
    text:'',onText:()=>{},models:[model('o','openai')],modelId:'o',onModel:()=>{},effort:'standard',onEffort:()=>{},streaming:false,disabled:false,
    uploads:[{localId:'f',file:null,remote:{id:'f',projectId:'p',name:'review.pdf',mimeType:'application/pdf',sizeBytes:10,status:'ready',sha256:'a'.repeat(64),createdAt:new Date().toISOString(),extractedChars:20,gate:null,failureCode:null,version:1},status:'ready',error:null}],
    onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t,
  }));
  const failed = renderToStaticMarkup(createElement(Composer, {
    text:'Review',onText:()=>{},models:[model('o','openai')],modelId:'o',onModel:()=>{},effort:'standard',onEffort:()=>{},streaming:false,disabled:false,
    uploads:[{localId:'bad',file:{name:'bad.pdf'},remote:null,status:'failed',error:'failed'}],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t,
  }));
  const validationProblem = renderToStaticMarkup(createElement(Composer, {
    text:'',onText:()=>{},models:[model('o','openai')],modelId:'o',onModel:()=>{},effort:'standard',onEffort:()=>{},streaming:false,disabled:false,
    uploads:[],uploadProblem:'type_denied',onFiles:()=>{},onDismissUploadProblem:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t,
  }));
  const empty = renderToStaticMarkup(createElement(EmptyChat, { t, onPrompt:()=>{} }));
  console.error = noise;
  assert.match(composer, /<textarea/);
  assert.match(composer, /type="file"[^>]*aria-label="Attach files"/);
  assert.match(composer, /aria-label="Attach files"/);
  assert.match(ready, /<ul class="ui-upload-list" aria-label="Attachments">/);assert.match(ready, /<li class="ui-upload-row is-ready">/);assert.match(ready, /review\.pdf/);
  assert.doesNotMatch(ready, /aria-label="Send message"[^>]*disabled/,'a ready attachment can be sent without typed text');
  assert.match(failed,/Failed/);assert.match(failed,/role="alert">failed/);assert.match(failed,/Remove bad\.pdf/);assert.match(failed,/aria-label="Send message"[^>]*disabled/);
  assert.match(validationProblem,/class="ui-upload-notice" role="alert"/);assert.match(validationProblem,/This file type is not allowed\./);assert.match(validationProblem,/class="ui-icon-button"[^>]*aria-label="Close"/);
  assert.doesNotMatch(empty, /attach|upload/i);
  assert.match(chatApp, /chatApi\.uploadFile/);assert.doesNotMatch(chatApp,/chatApi\.removeFile/);assert.doesNotMatch(chatApiSource,/\/api\/v1\/files\/\$\{[^}]+\}[^\n]+DELETE/);assert.match(chatApp,/\bfileIds\b/);
  assert.match(compactCss,/\.ui-upload-row\.is-rejected>svg,\.ui-upload-row\.is-failed>svg\{align-self:start/,'the file icon aligns with the file-name line when a reason is shown');
  assert.match(compactCss,/\.ui-conversation-feedback\{[^}]*align-items:center/,'conversation feedback aligns its message with the close button');
});

test('effort choices have a stable provider request mapping', () => {
  assert.equal(reasoningEffort('fast'), 'low');
  assert.equal(reasoningEffort('standard'), 'medium');
  assert.equal(reasoningEffort('deep'), 'high');
});

test('administrators can discover the correctly labelled console from chat',()=>{
  const t=createTranslator('en');
  const render=(adminAccess:boolean)=>renderToStaticMarkup(withI18n(createElement(Sidebar,{
    open:false,conversations:[],projects:[],activeId:null,archivedActive:false,busyId:null,adminAccess,locale:'en',t,
    workspace:{name:'Example'},onNavigate:()=>{},onAction:()=>{},onClose:()=>{},
  })));
  assert.equal(hasAdminAccess({permissions:['admin:users']}),true);
  assert.equal(hasAdminAccess({permissions:['chat:use']}),false);
  assert.match(render(true),/<a[^>]+href="\/admin\/users"[^>]*>.*Admin console.*<\/a>/s);
  assert.match(render(true,false),/<a[^>]+href="\/admin\/users"[^>]*>.*Admin console.*<\/a>/s);
  assert.doesNotMatch(render(false,false),/\/admin\/users/);
});

test('chat actions keep their server semantics through the UI wiring',()=>{
  assert.match(chatApp,/chatApi\.editRequest\(editing\.id,content,chatSelection,requestEffort,tone,role,assistantId\?\?null,fileIds\)/,'edit and resend must preserve selection, effort, role, tone, assistant binding, and attachment ids');
  assert.match(chatApp,/tone=\{tone\} onTone=\{setTone\}/,'the conversation-scoped tone must reach the composer');
  assert.match(chatApp,/role=\{role\} onRole=\{setRole\}/,'the conversation-scoped role must reach the composer');
  for(const locale of ['en','zh-TW','ja'] as const){const t=createTranslator(locale);const markup=renderToStaticMarkup(createElement(Composer,{text:'',onText:()=>{},models:[model('o','openai')],modelId:'o',onModel:()=>{},mode:'auto',onMode:()=>{},effort:'standard',onEffort:()=>{},tone:'default',onTone:()=>{},role:'default',onRole:()=>{},streaming:false,disabled:false,uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t}));assert.match(markup,/class="ui-tone-select"/);assert.match(markup,/class="ui-role-select"/);assert.match(markup,new RegExp(t('chat.composer.tone.option.friendly')));assert.match(markup,new RegExp(t('chat.composer.role.option.support')));}
  assert.match(chatApp,/retryForFailure\(run\.failure,run\.request,regenerate\)/,'retry must be derived from the failure, original request, and current selection');
  assert.match(chatApp,/onRegenerate=\{message => \{ if \(busy \|\| current\.id !== message\.conversationId\)return;const request=regenerate\(message\.id\)/,'the row action and failed-run retry share the guarded regenerate builder');
});

test('the live status line never falls back to failure text',()=>{
  assert.match(chatApp,/const status = run\.status === 'streaming' \? t\('chat\.message\.responding'\) : run\.status === 'stopping' \? t\('chat\.message\.stopping'\) : null/);
});

test('the bottom pin follows new gate, receipt, and failure surfaces',()=>{
  const messageList=readFileSync(new URL('MessageList.tsx',import.meta.url),'utf8');
  assert.match(messageList,/streamPhase,liveGate\?\.decisionId,liveResponseGate\?\.decisionId,failure\]/);
});

test('settings exposes no enabled command without an implementation',()=>{
  assert.match(pages,/onClick=\{onArchived\}/);
  assert.doesNotMatch(pages,/chat\.settings\.export/);
});

test('settings has an accessible close control that restores its history origin',()=>{
  assert.match(pages,/className="ui-settings-close(?: ui-icon-button)?"/);
  assert.match(pages,/aria-label=\{t\('common\.close'\)\}/);
  assert.match(pages,/onClick=\{onClose\}/);
  assert.match(chatApp,/history\.pushState\(opensSettings \? \{ \[settingsHistoryKey\]: true \} : \{\}/);
  assert.match(chatApp,/if \(history\.state\?\.\[settingsHistoryKey\] === true\) \{\s*history\.back\(\)/s);
  assert.match(chatApp,/history\.replaceState\(\{\}, '', '\/chat'\)/,'a directly opened settings route needs an in-app fallback');
  assert.match(chatApp,/onClose=\{closeSettings\}/);
});

test('chat surfaces use one production layout without vendor-specific marks or layout attributes', () => {
  const t=createTranslator('en');
  const turn={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'Answer',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:1,outputTokens:1,costUsd:0.01,gate:null,attachments:[],version:1};
  const user={...turn,id:'u',role:'user',modelId:null,provider:null,inputTokens:null,outputTokens:null,costUsd:null,content:'Question'};
  const noise=console.error;console.error=()=>{};
  try {
    const messages=renderToStaticMarkup(createElement(MessageList,{messages:[user,turn],showMetadata:false,locale:'en',t,onEdit:()=>{},onRegenerate:()=>{}}));
    const composer=renderToStaticMarkup(createElement(Composer,{text:'',onText:()=>{},models:[model('o','openai')],modelId:'o',onModel:()=>{},mode:'auto',onMode:()=>{},effort:'standard',onEffort:()=>{},streaming:false,disabled:false,uploads:[],onFiles:()=>{},onRemoveFile:()=>{},onSend:()=>{},onStop:()=>{},t}));
    const sidebar=renderToStaticMarkup(withI18n(createElement(Sidebar,{open:false,conversations:[],projects:[],activeId:null,archivedActive:false,busyId:null,adminAccess:false,workspace:null,locale:'en',t,onNavigate:()=>{},onAction:()=>{},onClose:()=>{}})));
    const markup=`${messages}\n${composer}\n${sidebar}`;
    assert.doesNotMatch(markup,/data-(?:chat|turn|timeline|composer|sidebar)-layout|ui-turn-mark|ui-composer-(?:leading|trailing|modes|inline)/);
  } finally {console.error=noise;}
});

test('long conversation titles cannot widen the mobile workspace past its viewport', () => {
  assert.match(compactCss,/\.ui-workspace\{[^}]*min-width:0/,'the workspace grid item must be allowed to shrink');
  assert.match(topbarCss,/\.ui-topbar__title\{[^}]*min-width:0[^}]*text-overflow:ellipsis/,'long titles need a bounded item so ellipsis can take effect');
});

test('mobile and coarse-pointer controls keep a 44px touch target without breaking the composer grid', () => {
  assert.match(css,/@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?width:\s*44px;\s*height:\s*44px/,'coarse pointers need an extended 44px hit area');
});

test('the mobile navigation overlay supports conventional dismissal without affecting desktop', () => {
  assert.match(chatApp,/useMobileDrawer\(\{open:sidebar,onClose:\(\)=>setSidebar\(false\),mediaQuery:'\(max-width: 1023px\)'/,'the chat sidebar must use the mobile drawer keyboard lifecycle at the register breakpoint');
  assert.match(chatApp,/sidebarActive && <div className="ui-sidebar-backdrop"[^>]+onClick=\{\(\) => setSidebar\(false\)\}/,'the active mobile sidebar needs a clickable outside backdrop');
  assert.match(compactCss,/\.ui-sidebar-backdrop\{display:none/,'the backdrop must not exist visually beside the permanent desktop sidebar');
  assert.match(css,/@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.ui-sidebar-backdrop\s*\{[^}]*z-index:\s*19[^}]*display:\s*block/s,'the mobile backdrop must sit below the z-index 20 sidebar');
});
