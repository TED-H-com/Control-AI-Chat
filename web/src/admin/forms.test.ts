// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {I18nProvider} from '../i18n/I18nProvider.js';
import {createTranslator} from '../i18n/index.js';
import { assistantModelChoices, draftRequestBody,EditUser,ScreenCreateDrawer,ScreenRecordActions } from './forms.js';
import {timeZoneOptions} from './TimeZoneSelect.js';

test('assistant draft request contains only the URL and model contract fields',()=>{
 const body=draftRequestBody('  https://example.test/public  ','model-1');
 assert.deepEqual(Object.keys(body),['url','modelCatalogId']);
 assert.deepEqual(body,{url:'https://example.test/public',modelCatalogId:'model-1'});
 assert.equal('name' in body,false);
 assert.equal('description' in body,false);
 assert.equal('systemPrompt' in body,false);
});

test('time zone choices put UTC and the browser zone first while preserving the stored value',()=>{
 const options=timeZoneOptions('Asia/Calcutta','en','Asia/Taipei');
 assert.deepEqual(options.preferred.map(option=>option.value),['UTC','Asia/Taipei','Asia/Calcutta']);
});

test('UTC time zone choices use localized long names while ordinary zones keep generic names',()=>{
 const expected={en:{utc:'Coordinated Universal Time',taipei:'Taiwan Standard Time'},'zh-TW':{utc:'世界標準時間',taipei:'台北標準時間'},ja:{utc:'協定世界時',taipei:'台湾標準時'}} as const;
 for(const locale of ['en','zh-TW','ja'] as const){
  const options=timeZoneOptions('Etc/UTC',locale,'Asia/Taipei'),all=[...options.preferred,...options.all];
  assert.equal(all.find(option=>option.value==='UTC')?.label,`UTC — ${expected[locale].utc}`);
  assert.equal(all.find(option=>option.value==='Etc/UTC')?.label,`Etc/UTC — ${expected[locale].utc}`);
  assert.equal(all.find(option=>option.value==='Asia/Taipei')?.label,`Asia/Taipei — ${expected[locale].taipei}`);
 }
});

test('budget drawer options submit stable keys and show the monthly state in every locale',()=>{
 for(const locale of ['en','zh-TW','ja']){
  Object.defineProperty(globalThis,'location',{value:{pathname:'/admin/budgets',search:''},configurable:true});Object.defineProperty(globalThis,'navigator',{value:{languages:[locale],language:locale},configurable:true});Object.defineProperty(globalThis,'localStorage',{value:{getItem(){return locale},setItem(){}},configurable:true});
  const html=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(ScreenCreateDrawer,{action:'create-budget',records:[],timeZone:'Asia/Taipei',onClose(){},async onCreated(){}})}));
  const scope=[...html.matchAll(/<option value="(tenant|group|user)"/g)].map(match=>match[1]);assert.deepEqual(scope,['tenant','group','user']);
  const periods=[...html.matchAll(/<option value="(daily|weekly|monthly)"([^>]*)>/g)];assert.deepEqual(periods.map(match=>match[1]),['daily','weekly','monthly']);assert.match(periods[2]![2],/selected/u);
 }
});

test('user controls render exactly the account actions advertised by the server',()=>{
 Object.defineProperty(globalThis,'navigator',{value:{languages:['en'],language:'en'},configurable:true});Object.defineProperty(globalThis,'localStorage',{value:{getItem(){return'en'},setItem(){}},configurable:true});
 const render=(actions)=>renderToStaticMarkup(createElement(I18nProvider,null,createElement(ScreenRecordActions,{screenKey:'users',record:{id:'target',displayName:'Target',status:'active',roles:['member'],actions,version:1},assignableRoles:['admin','member'],async onChanged(){},async onReload(){},onCredential(){}})));
 const withheld=render({changeStatus:false,changeRole:false,deprovision:false,signOut:false,credentialLink:null});
 assert.match(withheld,/Edit user/u);assert.doesNotMatch(withheld,/Force logout|Deprovision|Create reset link|Create setup link/u);
 const allowed=render({changeStatus:true,changeRole:true,deprovision:true,signOut:true,credentialLink:'reset'});
 for(const label of ['Edit user','Create reset link','Force logout','Deprovision'])assert.ok(allowed.includes(label),label);
 assert.doesNotMatch(allowed,/Create setup link/u);
});

test('user role choices and withheld-action notes come from server capabilities in every locale',()=>{
 for(const locale of ['en','zh-TW','ja']){
  Object.defineProperty(globalThis,'location',{value:{pathname:'/admin/users',search:''},configurable:true});Object.defineProperty(globalThis,'navigator',{value:{languages:[locale],language:locale},configurable:true});Object.defineProperty(globalThis,'localStorage',{value:{getItem(){return locale},setItem(){}},configurable:true});const t=createTranslator(locale);
  const invite=renderToStaticMarkup(createElement(I18nProvider,null,createElement(ScreenCreateDrawer,{action:'invite-user',records:[],assignableRoles:['admin','member'],onClose(){},async onCreated(){},onCredential(){}})));
  assert.deepEqual([...invite.matchAll(/<option value="(admin|compliance|member)"/gu)].map(match=>match[1]),['admin','member'],locale);assert.ok(invite.includes(t('admin.invite.complianceOwnerOnly')),locale);
  const protectedEdit=renderToStaticMarkup(createElement(I18nProvider,null,createElement(EditUser,{record:{id:'reviewer',displayName:'Reviewer',status:'active',locale,roles:['compliance'],actions:{changeStatus:false,changeRole:false,deprovision:false,signOut:false,credentialLink:null},version:1},assignableRoles:['admin','member'],onClose(){},async onChanged(){}})));
  assert.ok(protectedEdit.includes(t('admin.people.users.ownerOnlyAccountActions')),locale);assert.ok(!protectedEdit.includes(t('admin.invite.complianceOwnerOnly')),locale);
 }
});

test('editable user role choices preserve exactly the server ordering and explain withheld compliance access',()=>{
 Object.defineProperty(globalThis,'location',{value:{pathname:'/admin/users',search:''},configurable:true});Object.defineProperty(globalThis,'navigator',{value:{languages:['en'],language:'en'},configurable:true});Object.defineProperty(globalThis,'localStorage',{value:{getItem(){return'en'},setItem(){}},configurable:true});const t=createTranslator('en');
 const render=(role,assignableRoles)=>renderToStaticMarkup(createElement(I18nProvider,null,createElement(EditUser,{record:{id:'target',displayName:'Target',status:'active',locale:'en',roles:[role],actions:{changeStatus:true,changeRole:true,deprovision:true,signOut:true,credentialLink:'reset'},version:1},assignableRoles,onClose(){},async onChanged(){}})));
 const options=html=>[...html.matchAll(/<option value="(owner|admin|compliance|member)"/gu)].map(match=>match[1]);
 const limited=render('member',['admin','member']);
 assert.deepEqual(options(limited),['admin','member']);assert.ok(limited.includes(t('admin.invite.complianceOwnerOnly')));
 const complete=render('member',['admin','compliance','member']);
 assert.deepEqual(options(complete),['admin','compliance','member']);assert.ok(!complete.includes(t('admin.invite.complianceOwnerOnly')));
 const owner=render('owner',['admin','compliance','member']);
 assert.deepEqual(options(owner),['owner','admin','compliance','member']);
});
