import {useMemo} from 'react';
import {useI18n,type Locale} from '../i18n/index.js';

export interface TimeZoneOption {value:string;label:string}
function browserTimeZone():string {try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch{return 'UTC'}}
function zoneLabel(value:string,locale:Locale):string {
  try {const part=(style:'longGeneric'|'long')=>new Intl.DateTimeFormat(locale,{timeZone:value,timeZoneName:style}).formatToParts(0).find(item=>item.type==='timeZoneName')?.value,generic=part('longGeneric'),name=generic&&/^(?:GMT|UTC)(?:[+-]\d{1,2}(?::?\d{2})?)?$/u.test(generic)?part('long'):generic;return `${value} — ${name??value}`;} catch {return value}
}
export function timeZoneOptions(value:string,locale:Locale,browserZone=browserTimeZone()):{preferred:TimeZoneOption[];all:TimeZoneOption[]} {
  const supported=Intl.supportedValuesOf('timeZone'),preferredNames=[...new Set(['UTC',browserZone,value].filter(Boolean))],preferredSet=new Set(preferredNames);
  return {preferred:preferredNames.map(zone=>({value:zone,label:zoneLabel(zone,locale)})),all:supported.filter(zone=>!preferredSet.has(zone)).map(zone=>({value:zone,label:zoneLabel(zone,locale)}))};
}

export function TimeZoneSelect({value,onChange,disabled=false,id,describedBy}:{value:string;onChange:(value:string)=>void;disabled?:boolean;id?:string;describedBy?:string}) {
  const {locale,t}=useI18n(),options=useMemo(()=>timeZoneOptions(value,locale),[value,locale]);
  return <select id={id} aria-describedby={describedBy} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    <optgroup label={t('admin.timeZoneSelect.preferred')}>{options.preferred.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
    <optgroup label={t('admin.timeZoneSelect.all')}>{options.all.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
  </select>;
}
