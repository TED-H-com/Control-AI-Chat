import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Inbox, SlidersHorizontal, X } from 'lucide-react';
import type { AdminRecord } from './types.js';
import type { ColumnFormat, ScreenDefinition } from './catalog.js';
import { runtimeTranslation,useI18n,formatBytes,formatCurrency,formatNumber,type Translate,type Locale } from '../i18n/index.js';
import { createDebouncedCommit, FILTER_NAVIGATION_OPTIONS, isDebouncedTextFilter, paramsWithTextFilterDrafts, textFilterDrafts, textFilterDraftSignature, type AdminQueryNavigate, type DebouncedCommit } from './filtering.js';
import {PROVIDER_NAMES} from '../providerNames.js';
import {errorText} from '../error-message.js';
import {Field} from '../ui/Field.js';
import {AUDIT_ACTIONS,AUDIT_CATEGORIES} from '@shared/audit-actions';

const FIELD_ALIASES:Readonly<Record<string,readonly string[]>>={
 provider:['provider_key'],name:['key'],detectorKind:['kind'],scope:['scope_type'],capabilities:['capabilities_json'],
 contextWindowTokens:['context_window'],inputPriceMicroUsdPerMillion:['input_microusd_per_million'],outputPriceMicroUsdPerMillion:['output_microusd_per_million'],
 isTenantDefault:['is_default'],urlHost:['url_host'],credentialSource:['credential_source'],maskedSuffix:['masked_suffix'],
};
const snake=(key:string):string=>key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`);
export {PROVIDER_NAMES};

export function recordValue(record:AdminRecord,key:string):unknown {
 const candidates=[key,snake(key),...(FIELD_ALIASES[key]??[])];
 for(const candidate of candidates){
  if(!(candidate in record))continue;
  const value=record[candidate];
  if(candidate.endsWith('_json')&&typeof value==='string'){try{return JSON.parse(value) as unknown}catch{return value}}
  return value;
 }
 return undefined;
}

export function parseAdminInstant(value:unknown):Date|null {
 let milliseconds:unknown=value;
 if(typeof value==='string'&&/^\d+$/.test(value.trim()))milliseconds=Number(value);
 if(typeof milliseconds==='number'){
  if(!Number.isFinite(milliseconds))return null;
  if(Math.abs(milliseconds)<100_000_000_000)milliseconds*=1000;
 }else if(typeof value==='string'){
  const parsed=Date.parse(value);
  if(Number.isNaN(parsed))return null;
  milliseconds=parsed;
 }else return null;
 const date=new Date(milliseconds as number);
 return Number.isNaN(date.getTime())?null:date;
}

export function formatAdminDate(value:unknown,locale:Locale='en',timeZone='UTC',includeZone=true):string {
 const date=parseAdminInstant(value);
 if(!date)return '—';
 const options:Intl.DateTimeFormatOptions={year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...(includeZone?{timeZoneName:'short' as const}:{}),timeZone};
 try{return new Intl.DateTimeFormat(locale,options).format(date)}catch{return new Intl.DateTimeFormat(locale,{...options,timeZone:'UTC'}).format(date)}
}
export function adminZoneName(locale:Locale,timeZone:string):string {
 if(timeZone==='UTC')return 'UTC';
 try { return new Intl.DateTimeFormat(locale,{timeZone,timeZoneName:'shortGeneric'}).formatToParts(0).find(part=>part.type==='timeZoneName')?.value??timeZone; }
 catch { return 'UTC'; }
}
export function dateColumnHeading(label:string,locale:Locale,timeZone:string,t:Translate):string {return t('admin.dateColumnHeader',{label,zone:adminZoneName(locale,timeZone)})}

export function valueText(value:unknown,key='',locale:Locale='en',translate?:Translate,format:ColumnFormat='text',timeZone='UTC'):string {
 if(value===null||value===undefined||value==='') return '—';
 if(format==='date')return formatAdminDate(value,locale,timeZone);
 if(format==='boolean'){const truthy=value===true||value===1||value==='1';return translate?.(truthy?'admin.values.yes':'admin.values.no')??String(truthy)}
 if(format==='percent'&&typeof value==='number')return formatNumber(value>1?value/100:value,locale,{style:'percent',maximumFractionDigits:1});
 if(format==='currency'&&typeof value==='number')return formatCurrency(value/1_000_000,'USD',locale,{maximumFractionDigits:/price/i.test(key)?4:2});
 if(format==='bytes'&&typeof value==='number')return formatBytes(value,locale);
 if(format==='number'&&typeof value==='number')return formatNumber(value,locale);
 if(format==='enum')return translate?runtimeTranslation(translate,'admin.enums',value):String(value);
 if(typeof value==='boolean') return translate?.(value?'admin.values.yes':'admin.values.no')??String(value);
 if(typeof value==='number')return formatNumber(value,locale);
 if(Array.isArray(value)) return value.map(v=>typeof v==='object'&&v&&'name' in v?String(v.name):translate?runtimeTranslation(translate,key==='roles'?'admin.invite.roles':'admin.enums',v):String(v)).join(', ')||'—';
 if(typeof value==='object') return 'name' in value ? String(value.name) : JSON.stringify(value);
 const providerName=PROVIDER_NAMES[String(value)];
 if(providerName)return providerName;
 return translate?runtimeTranslation(translate,'admin.enums',value):String(value);
}
const METRIC_DEPENDENT_BUDGET_FIELDS=new Set(['softLimit','hardLimit','currentUsage','forecast']);
export function rowValueFormat(record:AdminRecord,key:string,format:ColumnFormat):ColumnFormat {
 if(METRIC_DEPENDENT_BUDGET_FIELDS.has(key)&&String(recordValue(record,'metric')).toLowerCase()==='usd')return 'currency';
 return format;
}
export function statusText(value:unknown,outcome:boolean,locale:Locale,t:Translate):string {return outcome?runtimeTranslation(t,'admin.outcomes',value):valueText(value,'',locale,t,'status')}
export function Status({value,outcome=false}:{value:unknown;outcome?:boolean}){const {locale,t}=useI18n();return <span className="ui-status" data-status={String(value)}>{statusText(value,outcome,locale,t)}</span>}
export function auditActionText(value:unknown,t:Translate):string {
 const action=String(value??'').trim();
 if(!action)return '—';
 return (AUDIT_ACTIONS as readonly string[]).includes(action)?runtimeTranslation(t,'admin.audit.actions',action):t('admin.values.unavailable');
}
const auditCategoryText=(value:unknown,t:Translate):string=>{const category=String(value??'');return(AUDIT_CATEGORIES as readonly string[]).includes(category)?runtimeTranslation(t,'admin.audit.categories',category):t('admin.values.unavailable')};
function auditCell(row:AdminRecord,key:string,value:unknown,format:ColumnFormat,locale:Locale,t:Translate,timeZone:string,includeZone=true):ReactNode {
 if(format==='optionalStatus')return value===null||value===undefined||value===''?<span className="ui-muted">—</span>:<Status value={value} outcome/>;
 if(format==='outcome')return <Status value={value} outcome/>;
 if(format==='auditAction')return auditActionText(value,t);
 if(format==='auditCategory')return auditCategoryText(value,t);
 if(format==='auditActor'&&(recordValue(row,'actorType')==='service'||value==='service'))return t('admin.audit.systemActor');
 if(key==='subject'&&typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value))return '—';
 return format==='date'?formatAdminDate(value,locale,timeZone,includeZone):valueText(value,key,locale,t,format,timeZone);
}
export function PageHead({title,description,actions,headingId}:{title:string;description:string;actions?:ReactNode;headingId?:string}){return <header className="ui-page-head"><div><h1 id={headingId}>{title}</h1><p>{description}</p></div>{actions&&<div className="ui-page-actions">{actions}</div>}</header>}
export function Empty({children,title,body,action,onAction}:{children?:ReactNode;title?:string;body?:string;action?:string;onAction?:()=>void}){const {t}=useI18n();return <div className="ui-empty"><Inbox size={28} aria-hidden="true"/><strong>{title??t('admin.common.nothing')}</strong><p>{body??children}</p>{action&&<button className="ui-button ui-secondary" onClick={onAction}>{action}</button>}</div>}
export function ErrorPanel({error,retry}:{error:Error;retry?:()=>void}){const {t}=useI18n();return <div role="alert" className="ui-error"><strong>{t('admin.common.loadError')}</strong><p>{errorText(error,t)}</p>{retry&&<button className="ui-button ui-secondary" onClick={retry}>{t('common.retry')}</button>}</div>}
export class LoadFailure extends Error {}

export function InlineError({message}:{message:string}) {
 const node=useRef<HTMLParagraphElement>(null);
 // `nearest` scrolls the smallest distance that puts the sentence on screen, and does nothing when
 // it already is.
 useEffect(()=>{if(message)node.current?.scrollIntoView({block:'nearest'})},[message]);
 return message?<p ref={node} className="ui-inline-error" role="alert">{message}</p>:null;
}
export function Loading(){const {t}=useI18n();return <div className="ui-loading" role="status"><span/>{t('admin.common.loading')}</div>}
export function ReadOnlyNotice(){const {t}=useI18n();return <section className="ui-notice" aria-label={t('admin.common.readOnlyTitle')}><strong>{t('admin.common.readOnlyTitle')}</strong><div>{t('admin.common.readOnlyBody')}</div></section>}

export function FilterBar({screen,params,onChange}:{screen:ScreenDefinition;params:URLSearchParams;onChange:AdminQueryNavigate}) {
 const {t}=useI18n();
 const initialDrafts=()=>textFilterDrafts(screen,params),[drafts,setDrafts]=useState(initialDrafts),draftsRef=useRef(drafts),paramsRef=useRef(params),screenRef=useRef(screen),onChangeRef=useRef(onChange),pendingText=useRef(false),syncedScreen=useRef(screen.key),committedText=useRef(textFilterDraftSignature(screen,drafts));
 paramsRef.current=params;screenRef.current=screen;onChangeRef.current=onChange;
 const committer=useRef<DebouncedCommit<()=>void>|null>(null);
 if(committer.current===null)committer.current=createDebouncedCommit(commit=>commit());
 const send=(next:URLSearchParams,nextDrafts:Readonly<Record<string,string>>)=>{next.delete('cursor');committedText.current=textFilterDraftSignature(screenRef.current,nextDrafts);onChangeRef.current(next,FILTER_NAVIGATION_OPTIONS)};
 const updateText=(key:string,value:string)=>{const nextDrafts={...draftsRef.current,[key]:value},scheduledScreen=screen.key,baseTextSignature=committedText.current;draftsRef.current=nextDrafts;setDrafts(nextDrafts);pendingText.current=true;committer.current!.schedule(()=>{const currentScreen=screenRef.current,currentParamsDrafts=textFilterDrafts(currentScreen,paramsRef.current);if(currentScreen.key!==scheduledScreen||textFilterDraftSignature(currentScreen,currentParamsDrafts)!==baseTextSignature)return;pendingText.current=false;send(paramsWithTextFilterDrafts(currentScreen,paramsRef.current,nextDrafts),nextDrafts)})};
 const updateImmediate=(key:string,value:string)=>{const nextDrafts=draftsRef.current;pendingText.current=false;committer.current!.immediate(()=>{const next=paramsWithTextFilterDrafts(screenRef.current,paramsRef.current,nextDrafts);value?next.set(key,value):next.delete(key);send(next,nextDrafts)})};
 const reset=()=>{const nextDrafts=Object.fromEntries(screen.filters.filter(isDebouncedTextFilter).map(filter=>[filter.key,'']));draftsRef.current=nextDrafts;setDrafts(nextDrafts);pendingText.current=false;committer.current!.immediate(()=>send(new URLSearchParams(),nextDrafts))};
 const query=params.toString();
 useEffect(()=>{
  const nextDrafts=textFilterDrafts(screen,params),nextSignature=textFilterDraftSignature(screen,nextDrafts),screenChanged=syncedScreen.current!==screen.key;
  if(screenChanged||!pendingText.current||nextSignature!==committedText.current){committer.current?.cancel();pendingText.current=false;committedText.current=nextSignature;draftsRef.current=nextDrafts;if(textFilterDraftSignature(screen,drafts)!==nextSignature)setDrafts(nextDrafts)}
  syncedScreen.current=screen.key;
 },[screen.key,query]);
 useEffect(()=>()=>committer.current?.cancel(),[]);
 if(screen.filters.length===0)return null;
 const active=[...params.keys()].filter(key=>!['cursor','sort','order'].includes(key)).length,hasDraftedText=Object.values(drafts).some(Boolean);
 return <details className="ui-filter-panel" open={active>0||undefined}><summary><SlidersHorizontal size={17} aria-hidden="true"/><span>{t('admin.common.filters')}</span>{active>0&&<strong aria-label={String(active)}>{active}</strong>}</summary><form className="ui-filters" onSubmit={e=>e.preventDefault()} aria-label={t('admin.common.filters')}>
  {screen.filters.map(f=><label key={f.key}><span>{t(f.labelKey)}</span>{f.options?<select value={params.get(f.key)??''} onChange={e=>updateImmediate(f.key,e.target.value)}><option value="">{t('admin.common.all')}</option>{f.options.map(x=><option key={x} value={x}>{f.localizedOptions?runtimeTranslation(t,screen.key==='audit'&&f.key==='action'?'admin.audit.actions':screen.key==='audit'&&f.key==='category'?'admin.audit.categories':'admin.enums',x):x}</option>)}</select>:<input aria-label={t(f.labelKey)} type={isDebouncedTextFilter(f)?'search':'date'} value={isDebouncedTextFilter(f)?drafts[f.key]??'':params.get(f.key)??''} maxLength={200} onChange={e=>{const value=e.target.value.normalize('NFC').slice(0,200);isDebouncedTextFilter(f)?updateText(f.key,value):updateImmediate(f.key,value)}}/>}</label>)}
  {(params.size>0||hasDraftedText)&&<button type="button" className="ui-button ui-ghost" onClick={reset}>{t('admin.common.resetFilters')}</button>}
 </form></details>
}

export function DataTable({rows,screen,sort,direction,onSort,onRow,selection,timeZone='UTC'}:{rows:AdminRecord[];screen:ScreenDefinition;sort:string;direction:string;onSort:(key:string)=>void;onRow?:(row:AdminRecord)=>void;selection?:{ids:ReadonlySet<string>;label:string;onChange:(id:string,checked:boolean)=>void;onAll:(ids:string[],checked:boolean)=>void};timeZone?:string}) {
 const {locale,t}=useI18n(),selectAllRef=useRef<HTMLInputElement>(null),rowIds=rows.flatMap(row=>typeof row.id==='string'?[row.id]:[]),selectedCount=rowIds.filter(id=>selection?.ids.has(id)).length,allSelected=rowIds.length>0&&selectedCount===rowIds.length;
 useEffect(()=>{if(selectAllRef.current)selectAllRef.current.indeterminate=selectedCount>0&&!allSelected;},[selectedCount,allSelected]);
 return <div className="ui-table-wrap" tabIndex={0}><table><thead><tr>
  {selection&&<th className="ui-select-cell"><input ref={selectAllRef} type="checkbox" aria-label={selection.label} checked={allSelected} onKeyDown={event=>event.stopPropagation()} onChange={event=>selection.onAll(rowIds,event.target.checked)}/></th>}
  {screen.columns.map(c=>{const sortable=screen.sortable?.includes(c.key)??false,numeric=['number','currency','percent','bytes'].includes(c.format),label=c.format==='date'?dateColumnHeading(t(c.labelKey),locale,timeZone,t):t(c.labelKey);return <th key={c.key} data-column={c.key} data-format={c.format} className={numeric?'ui-numeric':undefined} aria-sort={sortable?(sort===c.key?(direction==='asc'?'ascending':'descending'):'none'):undefined}>{sortable?<button className="ui-button ui-ghost" onClick={()=>onSort(c.key)}>{label}<span aria-hidden="true">{sort===c.key?(direction==='asc'?' ↑':' ↓'):' ↕'}</span></button>:<span>{label}</span>}</th>})}
 </tr></thead><tbody>{rows.map((row,i)=>{const id=typeof row.id==='string'?row.id:null;return <tr key={id??i} data-record-id={id??undefined} tabIndex={0} onClick={()=>onRow?.(row)} onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&onRow){event.preventDefault();onRow(row)}}}>
  {selection&&<td className="ui-select-cell"><input type="checkbox" aria-label={`${selection.label} ${id??i+1}`} checked={id!==null&&selection.ids.has(id)} disabled={id===null} onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onChange={event=>id&&selection.onChange(id,event.target.checked)}/></td>}
  {screen.columns.map(c=>{const value=recordValue(row,c.key),format=rowValueFormat(row,c.key,c.format),numeric=['number','currency','percent','bytes'].includes(format);return <td key={c.key} data-column={c.key} data-format={format} className={numeric?'ui-numeric':undefined}>{format==='status'?<Status value={value}/>:format==='outcome'?<Status value={value} outcome/>:auditCell(row,c.key,value,format,locale,t,timeZone,false)}</td>})}
 </tr>})}</tbody></table></div>
}

// Focusable descendants in DOM order. The dialog root carries tabindex="-1" of its own so it can
// still hold focus while it contains nothing focusable.
const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
// Violations opens a ReasonDialog on top of an already-open Drawer, so both are mounted at once.
// Without this stack one Escape would close both, and the two traps would pull Tab in opposite
// directions; only the dialog on top reacts.
const openDialogs:HTMLElement[]=[];
/**
 * Owns keyboard focus for one dialog: moves it in on open, keeps Tab inside, closes on Escape, and
 * hands focus back to whatever opened it when focus would otherwise be lost. The opener is captured
 * during the first render, before a child can claim focus with `autoFocus`. Cleanup restores it only
 * after the dialog has detached, so StrictMode's setup/cleanup/setup probe cannot pull focus out of a
 * still-connected dialog or one dialog out of the dialog that replaced it. The effect deliberately
 * has no dependencies: `close` keeps inline handlers current without re-running it.
 */
function useDialogFocus(ref:RefObject<HTMLElement>,onClose:()=>void,returnFocus?:HTMLElement|null):void {
 const [opener]=useState(()=>returnFocus??(typeof document!=='undefined'&&document.activeElement instanceof HTMLElement?document.activeElement:null)),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{
 const dialog=ref.current;if(!dialog)return;
  const focusable=()=>[...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  // Claim autofocus here as part of the focus trap.
  const focusDialog=(allowRoot=true)=>{const preferred=dialog.querySelector<HTMLElement>('[data-dialog-autofocus]');if(preferred)preferred.focus();else if(allowRoot&&!dialog.contains(document.activeElement))dialog.focus()};
  focusDialog();
  openDialogs.push(dialog);
  const onKeyDown=(event:KeyboardEvent)=>{
   if(openDialogs[openDialogs.length-1]!==dialog)return;
   if(event.key==='Escape'){event.preventDefault();close.current();return}
   if(event.key!=='Tab')return;
   const items=focusable(),active=document.activeElement;
   if(items.length===0){event.preventDefault();dialog.focus();return}
   const first=items[0]!,last=items[items.length-1]!;
   const leaving=event.shiftKey?active===first||active===dialog:active===last;
   if(leaving||!dialog.contains(active)){event.preventDefault();(event.shiftKey?last:first).focus()}
  };
  document.addEventListener('keydown',onKeyDown);
  return()=>{
   document.removeEventListener('keydown',onKeyDown);
   const index=openDialogs.indexOf(dialog);if(index>=0)openDialogs.splice(index,1);
   queueMicrotask(()=>{if(!dialog.isConnected&&opener?.isConnected&&(document.activeElement===null||document.activeElement===document.body))opener.focus()});
  };
 },[]);
}
export function Drawer({title,onClose,busy=false,children}:{title:string;onClose:()=>void;busy?:boolean;children:ReactNode}) { const ref=useRef<HTMLDivElement>(null);const {t}=useI18n();const dismiss=()=>{if(!busy)onClose()};useDialogFocus(ref,dismiss); return <div className="ui-backdrop" onMouseDown={e=>e.target===e.currentTarget&&dismiss()}><div className="ui-drawer" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} tabIndex={-1} ref={ref}><header><h2>{title}</h2><button type="button" className="ui-icon-button" title={t('admin.common.close')} aria-label={t('admin.common.close')} aria-disabled={busy?'true':undefined} onClick={dismiss}><X size={18}/></button></header>{children}</div></div> }
export function Dialog({title,onClose,busy=false,returnFocus,children}:{title:string;onClose:()=>void;busy?:boolean;returnFocus?:HTMLElement|null;children:ReactNode}) { const ref=useRef<HTMLDivElement>(null);const dismiss=()=>{if(!busy)onClose()};useDialogFocus(ref,dismiss,returnFocus);return <div className="ui-backdrop" onMouseDown={event=>event.target===event.currentTarget&&dismiss()}><div className="ui-dialog" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} tabIndex={-1} ref={ref}><h2>{title}</h2>{children}</div></div> }
export function RecordDetail({record,screen,timeZone='UTC',actions,extraDetails}:{record:AdminRecord;screen:ScreenDefinition;timeZone?:string;actions?:ReactNode;extraDetails?:ReactNode}) { const {locale,t}=useI18n();const columns=screen.detailColumns??screen.columns;return <><dl className="ui-details">{columns.flatMap(column=>{const value=recordValue(record,column.key),format=rowValueFormat(record,column.key,column.format),numeric=['number','currency','percent','bytes'].includes(format);return value===undefined?[]:[<div key={column.key}><dt>{t(column.labelKey)}</dt><dd className={numeric?'ui-numeric':undefined}>{format==='status'?<Status value={value}/>:format==='outcome'?<Status value={value} outcome/>:auditCell(record,column.key,value,format,locale,t,timeZone)}</dd></div>]})}{extraDetails}</dl>{actions&&<footer className="ui-detail-actions">{actions}</footer>}</> }

export function ReasonDialog({decision,onCancel,onSubmit,busy=false}:{decision:'approve'|'deny';onCancel:()=>void;onSubmit:(reason:string,ticketUrl?:string)=>void;busy?:boolean}) { const [reason,setReason]=useState('');const [ticket,setTicket]=useState('');const id=useId();const {t}=useI18n();const ref=useRef<HTMLFormElement>(null);useDialogFocus(ref,()=>{if(!busy)onCancel()});const valid=reason.trim().length>=10&&reason.trim().length<=1000&&(!ticket||ticket.startsWith('https://'));return <div className="ui-backdrop"><form className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy} tabIndex={-1} ref={ref} onSubmit={e=>{e.preventDefault();if(valid&&!busy)onSubmit(reason.trim(),ticket||undefined)}}><h2 id={id}>{decision==='approve'?t('admin.decision.approveTitle'):t('admin.decision.denyTitle')}</h2><p>{t('admin.decision.permanence')}</p><Field label={<span>{t('admin.decision.reason')}</span>} hint={<span className="ui-field-hint">{t('admin.decision.reasonHint')}</span>}>{field=><textarea id={field.id} aria-describedby={field.describedBy} autoFocus required minLength={10} maxLength={1000} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/>}</Field><Field label={<span>{t('admin.decision.ticket')}</span>} hint={<span className="ui-field-hint">{t('admin.decision.ticketHint')}</span>}>{field=><input id={field.id} aria-describedby={field.describedBy} type="url" pattern="https://.*" value={ticket} disabled={busy} onChange={e=>setTicket(e.target.value)}/>}</Field><footer><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)onCancel()}}>{t('common.cancel')}</button><button className={decision==='deny'?'ui-button ui-danger ui-danger--filled':'ui-button ui-primary'} disabled={!valid} aria-disabled={busy?'true':undefined}>{busy?t('admin.decision.saving'):decision==='approve'?t('admin.decision.approve'):t('admin.decision.deny')}</button></footer></form></div> }

export function TextReasonDialog({title,description,label,hint,submitLabel,onCancel,onSubmit,busy=false}:{title:string;description:string;label:string;hint:string;submitLabel:string;onCancel:()=>void;onSubmit:(reason:string)=>void;busy?:boolean}) { const [reason,setReason]=useState(''),id=useId();const {t}=useI18n();const ref=useRef<HTMLFormElement>(null);useDialogFocus(ref,()=>{if(!busy)onCancel()});const valid=reason.trim().length>=10&&reason.trim().length<=1000;return <div className="ui-backdrop"><form className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy} tabIndex={-1} ref={ref} onSubmit={event=>{event.preventDefault();if(valid&&!busy)onSubmit(reason.trim())}}><h2 id={id}>{title}</h2><p>{description}</p><Field label={<span>{label}</span>} hint={<span className="ui-field-hint">{hint}</span>}>{field=><textarea id={field.id} aria-describedby={field.describedBy} autoFocus required minLength={10} maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/>}</Field><footer><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)onCancel()}}>{t('common.cancel')}</button><button className="ui-button ui-primary" disabled={!valid} aria-disabled={busy?'true':undefined}>{busy?t('admin.decision.saving'):submitLabel}</button></footer></form></div> }
