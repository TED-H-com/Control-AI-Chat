import { canonicalTimeZone } from '../../lib/timezone.js';
import { localToUtc, zonedParts } from '../../lib/governance/windows.js';

export type BucketGranularity='hour'|'day'|'week'|'month';
export interface TimeBucket {key:string;startMs:number;endMs:number}
const HOUR=3_600_000;

const pad=(value:number)=>String(value).padStart(2,'0');
const dateKey=(date:Date)=>`${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}`;
function offsetText(at:number,timeZone:string):string {
  const p=zonedParts(at,timeZone),represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second),minutes=Math.round((represented-Math.floor(at/1000)*1000)/60_000);
  const sign=minutes>=0?'+':'-',absolute=Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute/60))}:${pad(absolute%60)}`;
}
function hourStart(at:number,timeZone:string):number {
  const p=zonedParts(at,timeZone);
  return at-p.minute*60_000-p.second*1_000-(at%1_000+1_000)%1_000;
}
function calendarStart(at:number,timeZone:string,granularity:Exclude<BucketGranularity,'hour'>):Date {
  const p=zonedParts(at,timeZone),date=new Date(Date.UTC(p.year,p.month-1,p.day));
  if(granularity==='week'){const day=date.getUTCDay()||7;date.setUTCDate(date.getUTCDate()-(day-1));}
  if(granularity==='month')date.setUTCDate(1);
  return date;
}
function nextDate(date:Date,granularity:Exclude<BucketGranularity,'hour'>):Date {
  const next=new Date(date);
  if(granularity==='day')next.setUTCDate(next.getUTCDate()+1);
  else if(granularity==='week')next.setUTCDate(next.getUTCDate()+7);
  else next.setUTCMonth(next.getUTCMonth()+1);
  return next;
}
export function timeBuckets(fromMs:number,toMs:number,granularity:BucketGranularity,timeZone:string):TimeBucket[] {
  if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||toMs<=fromMs)throw new RangeError('range must have finite increasing bounds');
  timeZone=canonicalTimeZone(timeZone);
  const result:TimeBucket[]=[];
  if(granularity==='hour'){
    for(let start=hourStart(fromMs,timeZone);start<toMs;start+=HOUR){
      const p=zonedParts(start,timeZone),key=`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:00${offsetText(start,timeZone)}`;
      result.push({key,startMs:start,endMs:start+HOUR});
      if(result.length>5_000)throw new RangeError('granularity would produce more than 5000 buckets');
    }
    return result;
  }
  for(let date=calendarStart(fromMs,timeZone,granularity);;date=nextDate(date,granularity)){
    const next=nextDate(date,granularity),startMs=localToUtc(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),timeZone),endMs=localToUtc(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),timeZone);
    if(startMs>=toMs)break;
    result.push({key:granularity==='month'?dateKey(date).slice(0,7):dateKey(date),startMs,endMs});
    if(result.length>5_000)throw new RangeError('granularity would produce more than 5000 buckets');
  }
  return result;
}

export function zonedMonthStart(at:number,timeZone:string):number {
  const date=calendarStart(at,canonicalTimeZone(timeZone),'month');
  return localToUtc(date.getUTCFullYear(),date.getUTCMonth()+1,1,timeZone);
}
