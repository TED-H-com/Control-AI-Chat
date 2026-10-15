import type { BudgetWindow } from './types.js';
import { canonicalTimeZone } from '../timezone.js';

export interface WindowBounds { start:number; end:number }
export interface ZonedParts {year:number;month:number;day:number;hour:number;minute:number;second:number}
// Store a formatter only after its constructor returns, and only when the key is already the resolved zone.
const zonedFormatters=new Map<string,Intl.DateTimeFormat>();
function zonedFormatter(timeZone:string):Intl.DateTimeFormat {
  const cached=zonedFormatters.get(timeZone);
  if(cached)return cached;
  const formatter=new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  if(formatter.resolvedOptions().timeZone===timeZone)zonedFormatters.set(timeZone,formatter);
  return formatter;
}
export function zonedParts(at:number,timeZone:string):ZonedParts { const values:Record<string,number>={}; for(const p of zonedFormatter(timeZone).formatToParts(new Date(at))) if(p.type!=='literal') values[p.type]=Number(p.value); return values as unknown as ZonedParts; }
export function localToUtc(y:number,m:number,d:number,timeZone:string,hour=0,minute=0,second=0):number { let guess=Date.UTC(y,m-1,d,hour,minute,second); for(let i=0;i<6;i++){ const p=zonedParts(guess,timeZone); const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second); const diff=represented-Date.UTC(y,m-1,d,hour,minute,second); if(diff===0)return guess; guess-=diff; } return guess; }
export function budgetWindowBounds(now:number,window:BudgetWindow,timeZone:string):WindowBounds {
  if(!Number.isFinite(now)) throw new RangeError('Invalid timestamp');
  timeZone=canonicalTimeZone(timeZone);
  const p=zonedParts(now,timeZone); let startDate=new Date(Date.UTC(p.year,p.month-1,p.day));
  if(window==='weekly'){ const day=startDate.getUTCDay()||7; startDate.setUTCDate(startDate.getUTCDate()-(day-1)); }
  if(window==='monthly') startDate=new Date(Date.UTC(p.year!,p.month!-1,1));
  const next=new Date(startDate); if(window==='daily')next.setUTCDate(next.getUTCDate()+1); else if(window==='weekly')next.setUTCDate(next.getUTCDate()+7); else next.setUTCMonth(next.getUTCMonth()+1);
  return {start:localToUtc(startDate.getUTCFullYear(),startDate.getUTCMonth()+1,startDate.getUTCDate(),timeZone),end:localToUtc(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),timeZone)};
}
