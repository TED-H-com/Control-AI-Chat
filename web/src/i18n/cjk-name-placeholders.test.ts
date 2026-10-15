// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogues } from './catalogues.js';

const namePlaceholders=[
  'name','term','title','label','user','group','model','policy','detector','role','project','skill','assistant','provider',
  'language','screen',
] as const;
const cjk=String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`;

function visitTemplates(value:unknown,path:string[],check:(key:string,template:string)=>void){
  if(typeof value==='string'){check(path.join('.'),value);return}
  if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))visitTemplates(child,[...path,key],check);
}

test('CJK name placeholders do not have whitespace between the name and surrounding CJK text',()=>{
  for(const locale of ['zh-TW','ja'] as const)visitTemplates(catalogues[locale],[],(key,template)=>{
    for(const placeholder of namePlaceholders){
      const separated=new RegExp(`(?:${cjk}\\s+\\{${placeholder}\\}|\\{${placeholder}\\}\\s+${cjk})`,'u');
      assert.doesNotMatch(template,separated,`${locale}.${key}`);
    }
  });
});
