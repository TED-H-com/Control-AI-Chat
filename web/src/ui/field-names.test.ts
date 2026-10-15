// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatNumber } from '../i18n/formatters.js';
import { registerCssImports } from '../test-support/css-imports.js';

await registerCssImports();

const browserLocation={search:'',pathname:'/admin',hash:'',origin:'http://127.0.0.1',assign(){}};
Object.defineProperty(globalThis,'location',{value:browserLocation,configurable:true});
let storedLocale='en';
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>storedLocale,setItem(){},removeItem(){}},configurable:true});

const escapeReg=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const visibleText=html=>decode(html.replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();

function elementById(html,id){
  const at=html.indexOf(`id="${id}"`);
  assert.notEqual(at,-1,`missing described element ${id}`);
  const tagStart=html.lastIndexOf('<',at);
  const tag=/^<([a-zA-Z0-9]+)/.exec(html.slice(tagStart));
  assert.ok(tag,id);
  const openEnd=html.indexOf('>',at);
  const className=/\bclass="([^"]*)"/.exec(html.slice(tagStart,openEnd+1))?.[1]??'';
  const innerEnd=html.indexOf(`</${tag[1]}>`,openEnd);
  assert.notEqual(innerEnd,-1,id);
  return {className,text:visibleText(html.slice(openEnd+1,innerEnd)),index:at};
}

function describedIds(attrs){
  return (/\baria-describedby="([^"]*)"/.exec(attrs)?.[1]??'').split(/\s+/).filter(Boolean);
}

function controlById(html,id){
  const match=new RegExp(`<(input|select|textarea)\\b([^>]*\\bid="${escapeReg(id)}"[^>]*)>`,'i').exec(html);
  assert.ok(match,`missing control ${id}`);
  return {tag:match[1].toLowerCase(),attrs:match[2]};
}

function fieldsNamed(html,name){
  const found=[];
  const labels=/<label\b([^>]*)>([\s\S]*?)<\/label>/g;
  for(let match=labels.exec(html);match;match=labels.exec(html)){
    if(/<(?:input|select|textarea)\b/i.test(match[2]))continue;
    const forId=/\bfor="([^"]*)"/.exec(match[1])?.[1];
    if(!forId)continue;
    const labelText=visibleText(match[2]);
    if(labelText!==name)continue;
    const control=controlById(html,forId);
    const ids=describedIds(control.attrs);
    found.push({labelText,tag:control.tag,ids,parts:ids.map(id=>elementById(html,id))});
  }
  return found;
}

function assertNamed(html,name,descriptions,options={}){
  const {tag,errorBeforeHint=false}=typeof options==='string'?{tag:options,errorBeforeHint:false}:options;
  const found=fieldsNamed(html,name);
  assert.equal(found.length,1,`${name} matched ${found.length} labelled controls`);
  const field=found[0];
  assert.equal(field.labelText,name);
  if(tag)assert.equal(field.tag,tag,name);
  assert.deepEqual(field.parts.map(part=>part.text),descriptions,`${name} description`);
  if(errorBeforeHint){
    const hint=field.parts.find(part=>part.className.includes('ui-field-hint'));
    const error=field.parts.find(part=>part.className.includes('ui-field-error'));
    assert.ok(hint&&error,`${name} hint and error`);
    assert.ok(error.index<hint.index,`${name} shows the error before the hint`);
    assert.ok(field.ids.length>=2&&html.indexOf(`id="${field.ids[0]}"`)>html.indexOf(`id="${field.ids[1]}"`),`${name} description lists the hint before the error`);
  }
  return field;
}

function assertHeading(html,name,headingId,descriptions){
  assert.ok(html.includes(`<h3 id="${headingId}">${name}</h3>`),`${name} heading`);
  const match=new RegExp(`<input\\b([^>]*\\baria-labelledby="${headingId}"[^>]*)>`,'i').exec(html);
  assert.ok(match,`${name} control`);
  const ids=describedIds(match[1]);
  assert.deepEqual(ids.map(id=>elementById(html,id).text),descriptions,`${name} description`);
}

const noop={onClose(){},async onCreated(){},async onReleased(){},async onSaved(){},async onChanged(){},onCredential(){},onCreate(){},onOpen(){},onBack(){},onOpenConversation(){},async onUpdate(){}};
const termState={terms:[],counts:{flag:0,warn:0,redact:0,block:0}};
const project={id:'project-1',name:'Quarterly review',instructions:'',fileCount:0,conversationCount:0,createdAt:'2026-09-28T12:00:00.000Z',updatedAt:'2026-09-28T12:00:00.000Z',version:1};

test('field accessible names are the label text, with hints and errors only in the description',async()=>{
  const {I18nProvider,createTranslator}=await import('../i18n/index.js');
  const {HoldForm,ReleaseDialog}=await import('../admin/Retention.js');
  const {Violations}=await import('../admin/Violations.js');
  const {ReasonDialog,TextReasonDialog}=await import('../admin/components.js');
  const {CustomTerms}=await import('../admin/CustomTerms.js');
  const {SettingsForm}=await import('../admin/SettingsForm.js');
  const {ProviderCredential,InviteUser,EditUser,CreateAssistant}=await import('../admin/forms.js');
  const {LoginPage}=await import('../auth/LoginPage.js');
  const {RecoveryPage}=await import('../auth/RecoveryPages.js');
  const {ProjectsPage,ProjectDetailPage}=await import('../chat/Pages.js');
  const wrap=(locale,node)=>{storedLocale=locale;return renderToStaticMarkup(createElement(I18nProvider,null,node));};
  const hold=(locale,draft,touched)=>wrap(locale,createElement(HoldForm,{...noop,timeZone:'UTC',initialDraft:draft,initialTouched:touched}));
  const quiet=console.error;
  for(const locale of ['en','zh-TW','ja']){
    const t=createTranslator(locale);
    const validation=key=>t(`admin.legalHolds.validation.${key}`);
    const base={scopeId:'',startsAt:'',endsAt:'',reason:'A recorded reason'};
    const clean=hold(locale,{...base,scopeType:'tenant'},{});
    assertNamed(clean,t('admin.legalHolds.scope'),[]);
    assertNamed(clean,t('admin.legalHolds.reason'),[t('admin.legalHolds.reasonHint')],'textarea');
    const ranged=hold(locale,{scopeType:'date_range',scopeId:'',startsAt:'2026-02-01',endsAt:'2026-01-15',reason:''},{endsAt:true,reason:true});
    assertNamed(ranged,t('admin.legalHolds.scope'),[t('admin.legalHolds.dateRangeHint')],'select');
    assertNamed(ranged,t('admin.legalHolds.startsAt'),[],'input');
    assertNamed(ranged,t('admin.legalHolds.endsAt'),[t('admin.legalHolds.dateHint',{zone:'UTC'}),validation('end_before_start')],{tag:'input',errorBeforeHint:true});
    assertNamed(ranged,t('admin.legalHolds.reason'),[t('admin.legalHolds.reasonHint'),validation('length')],'textarea');
    const invalidStart=hold(locale,{scopeType:'date_range',scopeId:'',startsAt:'not-a-date',endsAt:'',reason:'A recorded reason'},{startsAt:true});
    assertNamed(invalidStart,t('admin.legalHolds.startsAt'),[validation('invalid_date')],'input');
    const conversation=hold(locale,{...base,scopeType:'conversation',scopeId:''},{scopeId:true});
    assertNamed(conversation,t('admin.legalHolds.target'),[t('admin.legalHolds.conversationHint'),validation('required')],'input');
    const projectTarget=hold(locale,{...base,scopeType:'project',scopeId:''},{scopeId:true});
    assertNamed(projectTarget,t('admin.legalHolds.target'),[t('admin.legalHolds.projectHint'),validation('required')],'input');
    const user=hold(locale,{...base,scopeType:'user',scopeId:''},{scopeId:true});
    assertNamed(user,t('admin.legalHolds.target'),[t('admin.legalHolds.userHint'),validation('required')],'input');
    const release=wrap(locale,createElement(ReleaseDialog,{hold:{id:'hold-1'},...noop}));
    assertNamed(release,t('admin.legalHolds.releaseReason'),[t('admin.legalHolds.reasonHint')],'textarea');

    const violations=(initialState)=>wrap(locale,createElement(Violations,{params:new URLSearchParams(),navigate(){},canDecide:true,timeZone:'UTC',initialState}));
    assertNamed(violations({selectedIds:['violation-1'],bulkAction:'set_due'}),t('admin.violations.dueDate'),[t('admin.violations.dueDateHint',{zone:'UTC'})],'input');
    assertNamed(violations({selectedIds:['violation-1'],bulkAction:'resolve'}),t('admin.violations.reason'),[],'input');
    assertNamed(violations({selectedIds:['violation-1'],bulkAction:'note'}),t('admin.violations.notes'),[],'textarea');
    const drawer=violations({selected:{id:'violation-1',status:'open',dueAt:null,comments:[]}});
    assertHeading(drawer,t('admin.violations.dueDate'),'ui-violation-due',[t('admin.violations.dueDateHint',{zone:'UTC'})]);

    const decision=wrap(locale,createElement(ReasonDialog,{decision:'deny',onCancel(){},onSubmit(){}}));
    assertNamed(decision,t('admin.decision.reason'),[t('admin.decision.reasonHint')],'textarea');
    assertNamed(decision,t('admin.decision.ticket'),[t('admin.decision.ticketHint')],'input');
    const closure=wrap(locale,createElement(TextReasonDialog,{title:'Close',description:'Describe it.',label:t('admin.violations.reason'),hint:t('admin.violations.reasonHint'),submitLabel:'Resolve',onCancel(){},onSubmit(){}}));
    assertNamed(closure,t('admin.violations.reason'),[t('admin.violations.reasonHint')],'textarea');

    const terms=wrap(locale,createElement(CustomTerms,{canWrite:true,initialState:termState}));
    assertNamed(terms,t('admin.customTerms.bulkLabel'),[t('admin.customTerms.bulkHint')],'textarea');
    const settings=wrap(locale,createElement(SettingsForm,{record:{name:'Northstar',slug:'northstar',status:'active',timezone:'UTC'},canWrite:true,...noop}));
    assertNamed(settings,t('admin.fields.timezone'),[t('admin.settings.timeZoneHint')],'select');
    const provider=wrap(locale,createElement(ProviderCredential,{records:[],...noop}));
    assertNamed(provider,t('admin.providerCredential.apiKey'),[t('admin.providerCredential.apiKeyHint')],'input');
    assertNamed(provider,t('admin.providerCredential.baseUrl'),[t('admin.providerCredential.baseUrlHint')],'input');
    const assistant=wrap(locale,createElement(CreateAssistant,{...noop}));
    assertNamed(assistant,t('admin.assistants.sourceUrl'),[t('admin.assistants.sourceHint')],'input');
    const invite=wrap(locale,createElement(InviteUser,{assignableRoles:['admin','member'],...noop}));
    assertNamed(invite,t('admin.invite.role'),[t('admin.invite.roleHelp.member'),t('admin.invite.complianceOwnerOnly')],'select');
    const roleEdit=wrap(locale,createElement(EditUser,{record:{id:'member-1',displayName:'Member',status:'active',locale:'en',roles:['member'],version:1,actions:{changeStatus:true,changeRole:true,deprovision:true,signOut:true,credentialLink:'reset'}},assignableRoles:['admin','member'],...noop}));
    assertNamed(roleEdit,t('admin.people.users.role'),[t('admin.invite.complianceOwnerOnly')],'select');
    const selfEdit=wrap(locale,createElement(EditUser,{record:{id:'self',displayName:'Admin',status:'active',locale:'en',roles:['admin'],version:1,actions:{changeStatus:false,changeRole:false,deprovision:true,signOut:true,credentialLink:null}},assignableRoles:['admin','member'],...noop}));
    assertNamed(selfEdit,t('admin.people.users.role'),[t('admin.people.users.selfEditNote')],'select');

    browserLocation.pathname='/login';browserLocation.search='';browserLocation.hash='';
    const mfa=wrap(locale,createElement(LoginPage,{initialPhase:'mfa'}));
    assertNamed(mfa,t('auth.code'),[t('auth.codeHelp')],'input');
    browserLocation.pathname='/reset-password';browserLocation.hash='#reset-token';
    console.error=(...args)=>{if(String(args[0]??'').includes('useLayoutEffect'))return;quiet(...args);};
    try{const recovery=wrap(locale,createElement(RecoveryPage,{kind:'reset-password'}));assertNamed(recovery,t('auth.recovery.password'),[t('auth.recovery.policy')],'input');}
    finally{console.error=quiet;}

    const count=t('chat.project.characterCount',{current:formatNumber(0,locale),maximum:formatNumber(20000,locale)});
    const projects=renderToStaticMarkup(createElement(ProjectsPage,{projects:[],locale,t,...noop}));
    assertNamed(projects,t('chat.project.customInstructions'),[count],'textarea');
    const detail=renderToStaticMarkup(createElement(ProjectDetailPage,{detail:{project,files:[],conversations:[]},locale,t,...noop}));
    assertNamed(detail,t('chat.project.customInstructions'),[count],'textarea');
  }
});
