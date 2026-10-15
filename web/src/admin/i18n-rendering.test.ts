// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider,createTranslator } from '../i18n/index.js';
import { SCREENS } from './catalog.js';
import { Compliance } from './Compliance.js';
import { CustomTerms } from './CustomTerms.js';
import { GenericScreen } from './GenericScreen.js';
import { Overview } from './Overview.js';
import { PolicyEditor,PolicyRuleRow } from './PolicyEditor.js';
import { Violations } from './Violations.js';
import {ErrorPanel,valueText} from './components.js';
import {HoldLoadFailure} from './Retention.js';
import {ApiClientError} from '../api.js';

Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/admin'},configurable:true});
let storedLocale='en';
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>storedLocale,setItem(){},removeItem(){}},configurable:true});

const wrap=(locale:string,node:ReturnType<typeof createElement>)=>{storedLocale=locale;return renderToStaticMarkup(createElement(I18nProvider,null,node))};
const rule=(detector_key:string,id:string)=>({id,policy_id:'policy-1',policy_name:'Policy',detector_id:`detector-${id}`,detector_key,detector_kind:'secret',scope_type:'tenant',scope_id:null,direction:'outbound',action:'block',severity:'high',config_json:'{}',enabled:1,priority:100,updated_at:1});

test('admin load failures never render the server message in any locale',()=>{
 const failure=new ApiClientError(422,{error:{code:'VALIDATION_FAILED',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false,details:{reason:'date_order_invalid'}}});
 for(const locale of ['en','zh-TW','ja']){const expected=createTranslator(locale)('errors.reason.date_order_invalid');for(const node of [createElement(ErrorPanel,{error:failure}),createElement(HoldLoadFailure,{error:failure,retry:()=>{}})]){const html=wrap(locale,node);assert.ok(html.includes(expected),locale);assert.doesNotMatch(html,/SERVER-TEXT-SENTINEL/u,locale)}}
});

test('the Users roles column reuses the localized invitation role names',()=>{
 for(const locale of ['en','zh-TW','ja']){const t=createTranslator(locale),rendered=valueText(['owner','compliance','member'],'roles',locale,t);for(const role of ['owner','compliance','member'])assert.ok(rendered.includes(t(`admin.invite.roles.${role}`)),`${locale}: ${role}`)}
});

test('policy rows localize protected terms and preserve workspace detector names in every locale',()=>{
 for(const locale of ['en','zh-TW','ja'] as const){
  const t=createTranslator(locale);
  const protectedHtml=wrap(locale,createElement('table',null,createElement('tbody',null,createElement(PolicyRuleRow,{rule:rule('custom-terms','protected'),prioritiesVary:false,t}))));
  const workspaceHtml=wrap(locale,createElement('table',null,createElement('tbody',null,createElement(PolicyRuleRow,{rule:rule('acme-codenames','workspace'),prioritiesVary:false,t}))));
  assert.ok(protectedHtml.includes(t('admin.enums.custom-terms')),locale);
  assert.ok(workspaceHtml.includes('acme-codenames'),locale);
  assert.doesNotMatch(workspaceHtml,/admin\.enums\.acme-codenames/u,locale);
 }
});

test('every admin screen server-renders its localized h1 without throwing',()=>{
 const noop=()=>{};
 for(const locale of ['en','zh-TW','ja'] as const){
  const t=createTranslator(locale);
  for(const screen of SCREENS){
   const node=screen.key==='overview'?createElement(Overview,{params:new URLSearchParams(),navigate:noop,timeZone:'UTC'}):
    screen.key==='policies'?createElement(PolicyEditor,{permissions:['policy:read','policy:write']}):
    screen.key==='custom-terms'?createElement(CustomTerms,{canWrite:true}):
    screen.key==='compliance'?createElement(Compliance):
    screen.key==='violations'?createElement(Violations,{params:new URLSearchParams(),navigate:noop,canDecide:true,timeZone:'UTC'}):
    createElement(GenericScreen,{screen,params:new URLSearchParams(),navigate:noop,canWrite:true,assignableRoles:['admin','compliance','member'],timeZone:'UTC'});
   const html=wrap(locale,node);
   assert.match(html,new RegExp(`<h1(?: [^>]*)?>${t(`admin.screens.${screen.key}`)}</h1>`,'u'),`${locale} ${screen.key}`);
  }
 }
});

test('translation calls never hide a cast string literal from the type checker',()=>{
 const directory=new URL('../',import.meta.url);
 const files:string[]=[];
 const walk=(url:URL)=>{for(const entry of readdirSync(url,{withFileTypes:true})){const child=new URL(entry.name+(entry.isDirectory()?'/':''),url);if(entry.isDirectory())walk(child);else if(/\.tsx?$/u.test(entry.name)&&!entry.name.endsWith('.test.ts'))files.push(child.pathname)}};
 walk(directory);
 const violations:string[]=[];
 for(const file of files){
  const source=readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t'){
    const first=node.arguments[0];
    if(first&&ts.isAsExpression(first)&&(ts.isStringLiteral(first.expression)||ts.isNoSubstitutionTemplateLiteral(first.expression)))violations.push(`${file}:${tree.getLineAndCharacterOfPosition(first.getStart()).line+1}`);
   }
   ts.forEachChild(node,visit);
  };
  visit(tree);
 }
 assert.deepEqual(violations,[]);
});
