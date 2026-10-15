import { catalogues, en, type EnglishCatalogue } from './catalogues.js';
import type { Locale, Message, MessageKey, TranslationArgs } from './types.js';

export type TranslationKey = MessageKey<EnglishCatalogue>;
export type Translate = <K extends TranslationKey>(key: K, ...args: TranslationArgs<EnglishCatalogue,K>) => string;

const reportedMissingKeys=new Set<string>();
function lookup(root: object, path: string): Message|undefined {
 let value:unknown=root;
 for(const part of path.split('.')){
  if(value===null||typeof value!=='object'||!(part in value))return undefined;
  value=(value as Record<string,unknown>)[part];
 }
 return typeof value==='string'||(value!==null&&typeof value==='object'&&'other' in value)?value as Message:undefined;
}
function interpolate(message:string, values:Readonly<Record<string,string|number|Date>>):string { return message.replace(/\{([^}]+)\}/g,(_, key:string)=>String(values[key] ?? `{${key}}`)); }
export function createTranslator(locale:Locale):Translate {
 return ((key:string,values:Readonly<Record<string,string|number|Date>>={})=>{
  const entry=lookup(catalogues[locale],key);
  if(entry===undefined){
   const reportKey=`${locale}:${key}`;
   if(import.meta.env?.DEV&&!reportedMissingKeys.has(reportKey)){
    reportedMissingKeys.add(reportKey);
    console.error(`Missing translation: ${key} (${locale})`);
   }
   return key;
  }
  const message=typeof entry==='string'?entry:(values.count===0&&entry.zero)||((new Intl.PluralRules(locale).select(Number(values.count??0))==='one'&&entry.one)||entry.other);
  return interpolate(message,values);
 }) as Translate;
}
export function runtimeTranslation(t:(key:any,args?:any)=>string,prefix:string,value:unknown,args?:Readonly<Record<string,string|number|Date>>):string {
  const raw=String(value??'');
  const key=prefix?`${prefix}.${raw}`:raw;
  return lookup(en,key)===undefined?raw:t(key as TranslationKey,args);
}
export function catalogueKeys(root:object=en,prefix=''):string[]{return Object.entries(root).flatMap(([key,value])=>{const path=prefix?`${prefix}.${key}`:key;return typeof value==='string'||('other' in (value as object))?[path]:catalogueKeys(value as object,path)}).sort();}
