import { useCallback,useEffect,useId,useReducer,useRef,useState,type FormEvent } from 'react';
import { runtimeTranslation,useI18n,type Locale,type Translate } from '../i18n/index.js';
import { createAdminWrite,getRecords } from './api.js';
import { DataTable,dateColumnHeading,Dialog,Drawer,ErrorPanel,FilterBar,formatAdminDate,InlineError,Loading,PageHead } from './components.js';
import type { ScreenDefinition } from './catalog.js';
import type { AdminPage,AdminRecord } from './types.js';
import type { AdminQueryNavigate } from './filtering.js';
import {nextIsoDate,zonedDayStart} from './zoned-dates.js';
import {errorText} from '../error-message.js';
import {Field} from '../ui/Field.js';

export type HoldScope='tenant'|'user'|'conversation'|'project'|'date_range';
export interface HoldDraft {scopeType:HoldScope;scopeId:string;startsAt:string;endsAt:string;reason:string}
export function validateHoldDraft(draft:HoldDraft):Partial<Record<keyof HoldDraft,string>>{
 const errors:Partial<Record<keyof HoldDraft,string>>={},targeted=['user','conversation','project'].includes(draft.scopeType);
 if(targeted&&!draft.scopeId.trim())errors.scopeId='required';
 if(!targeted&&draft.scopeId.trim())errors.scopeId='absent';
 if(draft.scopeType==='date_range'&&!draft.startsAt&&!draft.endsAt)errors.startsAt='bound_required';
 if(draft.startsAt&&Number.isNaN(Date.parse(`${draft.startsAt}T00:00:00Z`)))errors.startsAt='invalid_date';
 if(draft.endsAt&&Number.isNaN(Date.parse(`${draft.endsAt}T00:00:00Z`)))errors.endsAt='invalid_date';
 if(draft.startsAt&&draft.endsAt&&!errors.startsAt&&!errors.endsAt&&draft.startsAt>draft.endsAt)errors.endsAt='end_before_start';
 const length=draft.reason.trim().length;if(length<1||length>1000)errors.reason='length';
 return errors;
}
export const validateReleaseReason=(reason:string):boolean=>reason.trim().length>=1&&reason.trim().length<=1000;

export function holdPayload(draft:HoldDraft,timeZone:string):Record<string,string>{
 const targeted=['user','conversation','project'].includes(draft.scopeType);
 return {scopeType:draft.scopeType,...(targeted?{scopeId:draft.scopeId}:{}),...(draft.startsAt?{startsAt:new Date(zonedDayStart(draft.startsAt,timeZone)).toISOString()}:{}),...(draft.endsAt?{endsAt:new Date(zonedDayStart(nextIsoDate(draft.endsAt),timeZone)).toISOString()}:{}),reason:draft.reason.trim()};
}

export function holdTargetText(hold:AdminRecord,locale:Locale,timeZone:string,t:Translate):string {
 const label=text(hold.scopeLabel);
 if(hold.scopeType==='conversation'){
  const parsed=typeof hold.scopeCreatedAt==='string'?Date.parse(hold.scopeCreatedAt):NaN,date=Number.isFinite(parsed)?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone}).format(parsed):'';
  return label&&date?`${label} · ${date}`:label||date||'—';
 }
 if(hold.scopeType!=='date_range')return label||'—';
 const format=(value:unknown,subtract=0):string=>{const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone}).format(parsed-subtract):''};
 const start=format(hold.startsAt),end=format(hold.endsAt,1);
 if(start&&end)return t('admin.legalHolds.range',{start,end});
 if(start)return t('admin.legalHolds.from',{start});
 if(end)return t('admin.legalHolds.through',{end});
 return '—';
}

export function holdStatusText(value:unknown,t:Translate):string {
 return runtimeTranslation(t,'admin.legalHolds.status',value);
}

export function mergeHoldPages(current:AdminPage<AdminRecord>,incoming:AdminPage<AdminRecord>,append:boolean):AdminPage<AdminRecord>{
 return {...incoming,items:append?[...current.items,...incoming.items]:incoming.items};
}

export interface HoldPagingState {generation:number;page:AdminPage<AdminRecord>;loading:boolean;loadingMore:boolean;firstError:Error|null;error:Error|null}
export type HoldPagingAction=
 |{type:'reload';generation:number}
 |{type:'firstPageLoaded';generation:number;page:AdminPage<AdminRecord>}
 |{type:'firstPageFailed';generation:number;error:Error}
 |{type:'loadMoreStarted';generation:number}
 |{type:'loadMoreLoaded';generation:number;page:AdminPage<AdminRecord>}
 |{type:'loadMoreFailed';generation:number;error:Error};
export const initialHoldPagingState:HoldPagingState={generation:0,page:{items:[],nextCursor:null},loading:true,loadingMore:false,firstError:null,error:null};
export function holdPagingReducer(state:HoldPagingState,action:HoldPagingAction):HoldPagingState{
 if(action.type==='reload')return action.generation>state.generation?{...state,generation:action.generation,loading:true,loadingMore:false,firstError:null,error:null}:state;
 if(action.generation!==state.generation)return state;
 if(action.type==='firstPageLoaded')return {...state,page:mergeHoldPages(state.page,action.page,false),loading:false,firstError:null};
 if(action.type==='firstPageFailed')return {...state,page:{items:[],nextCursor:null},loading:false,firstError:action.error};
 if(action.type==='loadMoreStarted')return {...state,loadingMore:true,error:null};
 if(action.type==='loadMoreLoaded')return {...state,page:mergeHoldPages(state.page,action.page,true),loadingMore:false,error:null};
 return {...state,loadingMore:false,error:action.error};
}

const scopes:readonly HoldScope[]=['tenant','user','conversation','project','date_range'];
const holdColumns=['scope','target','reason','placedBy','placedAt','status','actions'] as const;
const text=(value:unknown)=>typeof value==='string'?value:'';
const userName=(row:AdminRecord)=>text(row.displayName)||text(row.email)||text(row.id);
export function HoldLoadFailure({error,retry}:{error:Error;retry:()=>void}){const {t}=useI18n();return <div className="ui-hold-load-error" role="alert"><strong>{t('admin.common.loadError')}</strong><span>{errorText(error,t)}</span><button className="ui-button ui-secondary" onClick={retry}>{t('common.retry')}</button></div>}

export function HoldForm({onClose,onCreated,timeZone,initialDraft,initialTouched}:{onClose:()=>void;onCreated:()=>Promise<void>;timeZone:string;initialDraft?:HoldDraft;initialTouched?:Partial<Record<keyof HoldDraft,boolean>>}){
 const {t}=useI18n(),[write]=useState(createAdminWrite),[draft,setDraft]=useState<HoldDraft>(initialDraft??{scopeType:'tenant',scopeId:'',startsAt:'',endsAt:'',reason:''}),[touched,setTouched]=useState<Partial<Record<keyof HoldDraft,boolean>>>(initialTouched??{}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[search,setSearch]=useState(''),[users,setUsers]=useState<AdminRecord[]>([]),[searched,setSearched]=useState(false);
 const errors=validateHoldDraft(draft),valid=Object.keys(errors).length===0;
 const find=async()=>{if(!search.trim())return;setError('');try{setUsers((await getRecords('/admin/legal-hold-users',new URLSearchParams({search:search.trim()}))).items);setSearched(true)}catch(caught){setError(errorText(caught,t))}};
 const submit=async(event:FormEvent)=>{event.preventDefault();if(!valid||busy)return;setBusy(true);setError('');try{await write('/admin/legal-holds','POST',holdPayload(draft,timeZone));await onCreated();onClose()}catch(caught){setError(errorText(caught,t))}finally{setBusy(false)}};
 const change=(key:keyof HoldDraft,value:string)=>{setTouched(current=>({...current,[key]:true}));setDraft(current=>({...current,[key]:value}))};
 const fieldError=(key:keyof HoldDraft)=>touched[key]&&errors[key]?runtimeTranslation(t,'admin.legalHolds.validation',errors[key]):'';
 return <Drawer title={t('admin.legalHolds.place')} onClose={onClose} busy={busy}><form className="ui-admin-form ui-hold-form" onSubmit={event=>void submit(event)}>
  {error&&<InlineError message={error}/>}<Field label={<span>{t('admin.legalHolds.scope')}</span>} hint={draft.scopeType==='date_range'?<span className="ui-field-hint">{t('admin.legalHolds.dateRangeHint')}</span>:undefined}>{field=><select id={field.id} aria-describedby={field.describedBy} name="hold-scope" value={draft.scopeType} disabled={busy} onChange={event=>{const scopeType=event.target.value as HoldScope;setDraft(current=>({...current,scopeType,scopeId:'',startsAt:'',endsAt:''}));setTouched(current=>({...current,scopeId:false,startsAt:false,endsAt:false}))}}>{scopes.map(scope=><option key={scope} value={scope}>{runtimeTranslation(t,'admin.legalHolds.scopeOptions',scope)}</option>)}</select>}</Field>
  {draft.scopeType==='user'&&<Field label={<span>{t('admin.legalHolds.target')}</span>} hint={<span className="ui-field-hint">{t('admin.legalHolds.userHint')}</span>} error={fieldError('scopeId')?<span className="ui-field-error">{fieldError('scopeId')}</span>:undefined}>{field=><><div className="ui-source-row"><input id={field.id} aria-describedby={field.describedBy} type="search" value={search} maxLength={200} disabled={busy} onChange={event=>setSearch(event.target.value)}/><button type="button" className="ui-button ui-secondary" disabled={!search.trim()} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)void find()}}>{t('admin.people.members.find')}</button></div>{searched&&<div className="ui-hold-user-results">{users.map(user=><label key={text(user.id)}><input type="radio" name="hold-user" checked={draft.scopeId===user.id} onChange={()=>change('scopeId',text(user.id))}/><span><strong>{userName(user)}</strong><small>{text(user.email)}</small></span></label>)}</div>}</>}</Field>}
  {(draft.scopeType==='conversation'||draft.scopeType==='project')&&<Field label={<span>{t('admin.legalHolds.target')}</span>} hint={<span className="ui-field-hint">{draft.scopeType==='conversation'?t('admin.legalHolds.conversationHint'):t('admin.legalHolds.projectHint')}</span>} error={fieldError('scopeId')?<span className="ui-field-error">{fieldError('scopeId')}</span>:undefined}>{field=><input id={field.id} aria-describedby={field.describedBy} value={draft.scopeId} disabled={busy} onChange={event=>change('scopeId',event.target.value)}/>}</Field>}
  {draft.scopeType==='date_range'&&<><Field label={<span>{t('admin.legalHolds.startsAt')}</span>} error={fieldError('startsAt')?<span className="ui-field-error">{fieldError('startsAt')}</span>:undefined}>{field=><input id={field.id} aria-describedby={field.describedBy} type="date" value={draft.startsAt} disabled={busy} onChange={event=>change('startsAt',event.target.value)}/>}</Field><Field label={<span>{t('admin.legalHolds.endsAt')}</span>} errorFirst error={fieldError('endsAt')?<span className="ui-field-error">{fieldError('endsAt')}</span>:undefined} hint={<span className="ui-field-hint">{t('admin.legalHolds.dateHint',{zone:timeZone})}</span>}>{field=><input id={field.id} aria-describedby={field.describedBy} type="date" value={draft.endsAt} disabled={busy} onChange={event=>change('endsAt',event.target.value)}/>}</Field></>}
  <Field label={<span>{t('admin.legalHolds.reason')}</span>} hint={<span className="ui-field-hint">{t('admin.legalHolds.reasonHint')}</span>} error={fieldError('reason')?<span className="ui-field-error">{fieldError('reason')}</span>:undefined}>{field=><textarea id={field.id} aria-describedby={field.describedBy} rows={6} maxLength={1000} value={draft.reason} disabled={busy} onChange={event=>change('reason',event.target.value)}/>}</Field>
  <footer><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)onClose()}}>{t('common.cancel')}</button><button className="ui-button ui-primary" disabled={!valid} aria-disabled={busy?'true':undefined}>{t('admin.legalHolds.place')}</button></footer>
 </form></Drawer>;
}

export function ReleaseDialog({hold,onClose,onReleased}:{hold:AdminRecord;onClose:()=>void;onReleased:()=>Promise<void>}){const {t}=useI18n(),[write]=useState(createAdminWrite),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),valid=validateReleaseReason(reason);const submit=async(event:FormEvent)=>{event.preventDefault();if(!valid||busy)return;setBusy(true);setError('');try{await write(`/admin/legal-holds/${encodeURIComponent(text(hold.id))}/release`,'POST',{reason:reason.trim()});await onReleased()}catch(caught){setError(errorText(caught,t))}finally{setBusy(false)}};return <Dialog title={t('admin.legalHolds.release')} onClose={onClose} busy={busy}><form className="ui-admin-form" onSubmit={event=>void submit(event)}><p>{t('admin.legalHolds.releaseDescription')}</p>{error&&<InlineError message={error}/>}<Field label={<span>{t('admin.legalHolds.releaseReason')}</span>} hint={<span className="ui-field-hint">{t('admin.legalHolds.reasonHint')}</span>}>{field=><textarea id={field.id} aria-describedby={field.describedBy} autoFocus rows={5} maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/>}</Field><footer><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)onClose()}}>{t('common.cancel')}</button><button className="ui-button ui-danger ui-danger--filled" disabled={!valid} aria-disabled={busy?'true':undefined}>{t('admin.legalHolds.release')}</button></footer></form></Dialog>}

export function Retention({screen,params,navigate,canManage,canOpenSettings,onNavigateSettings,timeZone}:{screen:ScreenDefinition;params:URLSearchParams;navigate:AdminQueryNavigate;canManage:boolean;canOpenSettings:boolean;onNavigateSettings:()=>void;timeZone:string}){
 const {locale,t}=useI18n(),[retention,setRetention]=useState<AdminRecord[]>([]),[retentionLoaded,setRetentionLoaded]=useState(false),[retentionLoading,setRetentionLoading]=useState(true),[retentionError,setRetentionError]=useState<Error|null>(null),[paging,dispatchPaging]=useReducer(holdPagingReducer,initialHoldPagingState),generation=useRef(0),retentionGeneration=useRef(0),[status,setStatus]=useState<'active'|'released'|'all'>('active'),[placing,setPlacing]=useState(false),[releasing,setReleasing]=useState<AdminRecord|null>(null),pageHeadingId=useId(),retentionRegion=useRef<HTMLElement>(null),holdsHeading=useRef<HTMLHeadingElement>(null),holdsHeadingId=useId(),tableWrap=useRef<HTMLDivElement>(null),loadMoreButton=useRef<HTMLButtonElement>(null),acceptedPageFocus=useRef<{generation:number;firstAdded:number}|null>(null),releaseFocusPending=useRef(false);
 const loadRetention=useCallback(async()=>{const requestGeneration=++retentionGeneration.current;setRetentionLoading(true);setRetentionError(null);try{const periods=await getRecords(screen.endpoint,params);if(requestGeneration===retentionGeneration.current){setRetention(periods.items);setRetentionLoaded(true);setRetentionLoading(false)}}catch(caught){if(requestGeneration===retentionGeneration.current){setRetentionLoading(false);setRetentionError(caught instanceof Error?caught:new Error(String(caught)))}}},[screen.endpoint,params.toString()]);
 const loadHolds=useCallback(async()=>{const requestGeneration=++generation.current;dispatchPaging({type:'reload',generation:requestGeneration});try{const legal=await getRecords('/admin/legal-holds',new URLSearchParams({status}));dispatchPaging({type:'firstPageLoaded',generation:requestGeneration,page:legal})}catch(caught){dispatchPaging({type:'firstPageFailed',generation:requestGeneration,error:caught instanceof Error?caught:new Error(String(caught))})}},[status]);
 const loadAll=useCallback(async()=>{await Promise.all([loadRetention(),loadHolds()])},[loadRetention,loadHolds]);
 useEffect(()=>{void loadRetention()},[loadRetention]);useEffect(()=>{void loadHolds()},[loadHolds]);
 useEffect(()=>{if(!releasing&&releaseFocusPending.current){releaseFocusPending.current=false;holdsHeading.current?.focus()}},[releasing]);
 useEffect(()=>{const pending=acceptedPageFocus.current;if(!pending||pending.generation!==paging.generation)return;acceptedPageFocus.current=null;const rows=tableWrap.current?.querySelectorAll<HTMLElement>('tbody tr[data-hold-row]');(rows?.[pending.firstAdded]??tableWrap.current)?.focus()},[paging.page,paging.generation]);
 const loadMore=async()=>{if(!paging.page.nextCursor||paging.loadingMore)return;const requestGeneration=paging.generation,cursor=paging.page.nextCursor,firstAdded=paging.page.items.length;dispatchPaging({type:'loadMoreStarted',generation:requestGeneration});try{const next=await getRecords('/admin/legal-holds',new URLSearchParams({status,cursor}));if(requestGeneration===generation.current&&document.activeElement===loadMoreButton.current)acceptedPageFocus.current={generation:requestGeneration,firstAdded};dispatchPaging({type:'loadMoreLoaded',generation:requestGeneration,page:next})}catch(caught){dispatchPaging({type:'loadMoreFailed',generation:requestGeneration,error:caught instanceof Error?caught:new Error(String(caught))})}};
 const holdReleased=async()=>{await loadAll();releaseFocusPending.current=true;setReleasing(null)};
 const date=(value:unknown)=>formatAdminDate(value,locale,timeZone,false);
 const settingsText=t('admin.legalHolds.workspaceSettings');
 return <><PageHead headingId={pageHeadingId} title={runtimeTranslation(t,'admin.screens','retention')} description={runtimeTranslation(t,'admin.screen.retention',0)}/><FilterBar screen={screen} params={params} onChange={navigate}/><section ref={retentionRegion} role="region" aria-labelledby={pageHeadingId} tabIndex={0} aria-busy={retentionLoading}>{retentionError&&<ErrorPanel error={retentionError} retry={()=>{retentionRegion.current?.focus();void loadRetention()}}/>}{!retentionLoaded&&retentionLoading?<Loading/>:retentionLoaded?<DataTable rows={retention} screen={screen} sort="" direction="desc" onSort={()=>{}} timeZone={timeZone}/>:null}</section><p className="ui-field-hint">{t('admin.legalHolds.retentionHintBefore')}{canOpenSettings?<a href="/admin/settings" onClick={event=>{event.preventDefault();onNavigateSettings()}}>{settingsText}</a>:settingsText}{t('admin.legalHolds.retentionHintAfter')}</p><section className="ui-holds"><header><div><h2 id={holdsHeadingId} ref={holdsHeading} tabIndex={-1}>{t('admin.legalHolds.title')}</h2><p>{t('admin.legalHolds.description')}</p></div>{canManage&&<button className="ui-button ui-primary" onClick={()=>setPlacing(true)}>{t('admin.legalHolds.place')}</button>}</header><div className="ui-segments" aria-label={t('admin.legalHolds.filter')}>{(['active','released','all'] as const).map(value=><label key={value}><input type="radio" name="hold-status" checked={status===value} onChange={()=>setStatus(value)}/><span>{holdStatusText(value,t)}</span></label>)}</div><div ref={tableWrap} className="ui-table-wrap" role="region" aria-labelledby={holdsHeadingId} tabIndex={0} aria-busy={paging.loading}><table><thead><tr>{holdColumns.map(key=>{const label=runtimeTranslation(t,'admin.legalHolds.columns',key);return <th key={key}>{key==='placedAt'?dateColumnHeading(label,locale,timeZone,t):label}</th>})}</tr></thead><tbody>{paging.firstError?<tr><td colSpan={holdColumns.length}><HoldLoadFailure error={paging.firstError} retry={()=>{tableWrap.current?.focus();void loadHolds()}}/></td></tr>:paging.loading?<tr><td colSpan={holdColumns.length}>{t('admin.common.loading')}</td></tr>:paging.page.items.map(hold=><tr key={text(hold.id)} data-hold-row tabIndex={-1}><td>{runtimeTranslation(t,'admin.legalHolds.scopeOptions',hold.scopeType)}</td><td>{holdTargetText(hold,locale,timeZone,t)}</td><td>{text(hold.reason)}</td><td>{text(hold.placedBy)||'—'}</td><td>{date(hold.placedAt)}</td><td><span className="ui-status" data-status={String(hold.status)}>{holdStatusText(hold.status,t)}</span></td><td>{canManage&&hold.status==='active'&&<div className="ui-cell-actions"><button className="ui-button ui-ghost" onClick={()=>setReleasing(hold)}>{t('admin.legalHolds.release')}</button></div>}</td></tr>)}</tbody></table></div>{!paging.loading&&!paging.firstError&&paging.page.items.length===0&&<p className="ui-muted">{t('admin.legalHolds.empty')}</p>}{paging.error&&<InlineError message={errorText(paging.error,t)}/>}<footer className="ui-pagination">{!paging.loading&&!paging.firstError&&<span>{t('admin.values.shown',{count:paging.page.items.length})}</span>}<button ref={loadMoreButton} className="ui-button ui-secondary" disabled={paging.loading||Boolean(paging.firstError)||!paging.page.nextCursor} aria-disabled={paging.loadingMore?'true':undefined} onClick={()=>{if(!paging.loadingMore)void loadMore()}}>{t('admin.legalHolds.loadMore')}</button></footer></section>{placing&&<HoldForm timeZone={timeZone} onClose={()=>setPlacing(false)} onCreated={loadAll}/>} {releasing&&<ReleaseDialog hold={releasing} onClose={()=>setReleasing(null)} onReleased={holdReleased}/>}</>;
}
