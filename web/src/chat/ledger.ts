import type {GateAction} from '@shared/types';
import type {GateSummary,Message} from './types.js';

export interface LedgerEntry {
  readonly number:number;
  readonly prompt:Message|null;
  readonly responses:readonly Message[];
  readonly startedAt:string;
  readonly dateRule:boolean;
}

export interface LedgerOptions { readonly timeZone?:string }

function browserTimeZone():string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function calendarDate(value:string,timeZone:string):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const valueOf=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value??'';
  return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')}`;
}

export function buildLedger(messages:readonly Message[],options:LedgerOptions={}):LedgerEntry[] {
  const timeZone=options.timeZone??browserTimeZone();
  const grouped:Array<{prompt:Message|null;responses:Message[]}>=[];
  const prompts=new Map<string,number>();
  for(const message of messages){
    if(message.role==='user'){
      prompts.set(message.id,grouped.length);
      grouped.push({prompt:message,responses:[]});
      continue;
    }
    if(message.role==='assistant'){
      const matching=message.parentMessageId?prompts.get(message.parentMessageId):undefined;
      if(matching===undefined)grouped.push({prompt:null,responses:[message]});
      else grouped[matching]!.responses.push(message);
    }
  }
  let previousDate:string|null=null;
  return grouped.map((entry,index)=>{
    const startedAt=(entry.prompt??entry.responses[0])!.createdAt;
    const date=calendarDate(startedAt,timeZone);
    const result:LedgerEntry={...entry,number:index+1,startedAt,dateRule:previousDate===null||previousDate!==date};
    previousDate=date;
    return result;
  });
}

export function entryNumber(number:number):string {
  return String(number).padStart(2,'0');
}

export type StampKind=GateAction|'cleared'|'withheld'|'checking';
export type StampInk='text-2'|'primary'|'amber'|'crimson'|'muted';
export interface Stamp { readonly kind:StampKind;readonly count:number|null;readonly ink:StampInk;readonly toggles:boolean;readonly receiptOpen:boolean }
export interface StampInput {
  readonly gate:Pick<GateSummary,'action'|'protectedItemCount'>|null;
  readonly row:'prompt'|'response';
  readonly liveStatus?:'gating'|'warning'|'approval'|'streaming'|'stopping'|'idle'|'error';
}

export function stampFor({gate,row,liveStatus}:StampInput):Stamp|null {
  if(!gate){
    if(row==='prompt'&&liveStatus==='gating')return {kind:'checking',count:null,ink:'muted',toggles:false,receiptOpen:false};
    if(row==='prompt'&&(liveStatus==='streaming'||liveStatus==='stopping'))return {kind:'cleared',count:null,ink:'text-2',toggles:false,receiptOpen:false};
    return null;
  }
  const {action,protectedItemCount:count}=gate;
  if(row==='response'&&(action==='allow'||action==='flag'))return null;
  if(row==='response'&&(action==='warn'||action==='require_approval'||action==='block'))
    return {kind:'withheld',count:null,ink:'crimson',toggles:false,receiptOpen:true};
  if(action==='allow'||action==='flag')return {kind:'cleared',count:null,ink:'text-2',toggles:false,receiptOpen:false};
  if(action==='redact'||action==='mask')return {kind:action,count,ink:'primary',toggles:true,receiptOpen:false};
  if(action==='warn')return {kind:'warn',count:null,ink:'amber',toggles:true,receiptOpen:false};
  if(action==='require_approval')return {kind:action,count:null,ink:'amber',toggles:false,receiptOpen:true};
  return {kind:'block',count:null,ink:'crimson',toggles:false,receiptOpen:true};
}
