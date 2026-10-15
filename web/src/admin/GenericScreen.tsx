import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { formatBytes, formatNumber, runtimeTranslation, useI18n, type Locale, type Translate, type TranslationKey } from '../i18n/index.js';
import { adminGet, getRecords } from './api.js';
import { DataTable, Drawer, Empty, ErrorPanel, FilterBar, formatAdminDate, Loading, PageHead, ReadOnlyNotice, RecordDetail, recordValue, valueText } from './components.js';
import { primaryActionForScreen } from './form-logic.js';
import { CredentialLinkDialog, credentialDialogReducer, primaryActionLabel, ScreenCreateDrawer, ScreenRecordActions } from './forms.js';
import { SettingsForm } from './SettingsForm.js';
import type { ScreenDefinition } from './catalog.js';
import type { AdminPage, AdminRecord } from './types.js';
import { AuditExportDialog } from './AuditExport.js';
import { type AdminQueryNavigate } from './filtering.js';
import { createLatestRequestRunner } from './latest-request.js';
import type {DeliveredCredentialLink,Role} from '@shared/api';

function normalizePage(value:unknown):AdminPage<AdminRecord>{
 if(value&&typeof value==='object'){
  if('items'in value&&Array.isArray(value.items))return value as AdminPage<AdminRecord>;
  if('data'in value&&Array.isArray(value.data)){const page='page'in value&&value.page&&typeof value.page==='object'?value.page as Record<string,unknown>:{};return {items:value.data as AdminRecord[],nextCursor:typeof page.nextCursor==='string'?page.nextCursor:null};}
  return {items:Object.entries(value as Record<string,unknown>).map(([setting,effectiveValue])=>({setting,effectiveValue,source:'effective',editable:true})),nextCursor:null};
 }
 return {items:[],nextCursor:null};
}

type FlexibleTranslate=(key:TranslationKey,args?:Record<string,string|number>)=>string;
const SETTING_KEYS=['name','status','default_locale','timezone','conversation_retention_days','retain_full_transcripts','requests_per_minute','concurrent_streams','accepted_upload_mime_types','max_upload_bytes'] as const;
const MIME_KEYS:Readonly<Record<string,string>>={
 'application/pdf':'pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'word','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'excel','application/vnd.openxmlformats-officedocument.presentationml.presentation':'powerPoint','text/plain':'plainText','text/csv':'csv','text/markdown':'markdown',
};
export function adaptSettings(value:unknown,locale:Locale,timeZone:string,t:Translate):{page:AdminPage<AdminRecord>;lastUpdated:string|null}{
 const source=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const formatValue=(key:typeof SETTING_KEYS[number],raw:unknown):string=>{
  if(raw===null||raw===undefined||raw==='')return '—';
  if(key==='retain_full_transcripts')return t(raw===true||raw===1||raw==='1'?'admin.values.yes':'admin.values.no');
  if(key==='max_upload_bytes'&&typeof raw==='number')return formatBytes(raw,locale);
  if(key==='default_locale')return runtimeTranslation(t,'language',raw);
  if(key==='status')return runtimeTranslation(t,'admin.enums',raw);
  if(key==='conversation_retention_days')return t('admin.settings.days',{count:typeof raw==='number'?formatNumber(raw,locale):String(raw)});
  if(key==='accepted_upload_mime_types'){
   return Array.isArray(raw)?raw.map(type=>runtimeTranslation(t,'admin.settings.fileTypes',MIME_KEYS[String(type)]??String(type))).join(', '):'—';
  }
  return typeof raw==='number'?formatNumber(raw,locale):String(raw);
 };
 const items=SETTING_KEYS.flatMap(key=>key in source?[{setting:key==='timezone'?t('admin.fields.timezone'):runtimeTranslation(t,'admin.settings.labels',key),effectiveValue:formatValue(key,source[key])}]:[]);
 const updated=source.updated_at===undefined?null:formatAdminDate(source.updated_at,locale,timeZone);
 return {page:{items,nextCursor:null},lastUpdated:updated?t('admin.settings.lastUpdated',{date:updated}):null};
}

export const screenActionAvailable=(screenKey:ScreenDefinition['key']):boolean=>primaryActionForScreen(screenKey)!==null;
interface AuditEventDetailRecord extends AdminRecord {detail?:{policiesApplied?:Array<{ruleId:string;ruleName:string;detector:string|null;action:string|null}>;matchCount?:number;ruleCount?:number;cleansedPrompt?:{text:string;transformed:boolean}|null}}
export function AuditEventDetail({record,t}:{record:AuditEventDetailRecord;t:FlexibleTranslate}){
 const detail=record.detail,policies=detail?.policiesApplied??[],prompt=detail?.cleansedPrompt??null;
 return <div className="ui-triage-controls"><section><h3>{t('admin.audit.policiesApplied')}</h3>{policies.length?<><div className="ui-policy-tally">{policies.map(policy=><p key={policy.ruleId}><strong>{policy.ruleName}</strong><span> · {policy.detector?runtimeTranslation(t as Translate,'admin.enums',policy.detector):'—'} · </span><span className={`ui-action ui-action--${policy.action??'notcovered'}`}>{policy.action?runtimeTranslation(t as Translate,'admin.enums',policy.action):'—'}</span></p>)}</div><p className="ui-muted">{t('admin.audit.tally',{matchCount:detail?.matchCount??0,ruleCount:detail?.ruleCount??0})}</p></>:<p className="ui-muted">{t('admin.audit.noPolicies')}</p>}</section><section><h3>{t('admin.audit.cleansedPrompt')}</h3>{prompt?<><pre className="ui-cleansed-prompt">{prompt.text}</pre>{prompt.transformed&&<p className="ui-muted">{t('admin.audit.cleansedPromptCaption')}</p>}</>:<p className="ui-muted">{t('admin.audit.noPrompt')}</p>}</section></div>;
}
export function loadScreenDetail(screen:ScreenDefinition,record:AdminRecord,get:<T>(path:string)=>Promise<T>=adminGet):Promise<AdminRecord|null>{
 if(!screen.detailEndpoint||record.id===undefined||record.id===null)return Promise.resolve(null);
 return get<AdminRecord>(screen.detailEndpoint.replace(':id',encodeURIComponent(String(record.id))));
}
export function reselect(items:readonly AdminRecord[],current:AdminRecord|null):AdminRecord|null{
 if(current===null||current.id===undefined||current.id===null)return current;
 return items.find(row=>row.id===current.id)??null;
}
export function GenericScreen({screen,params,navigate,canWrite,assignableRoles,timeZone}:{screen:ScreenDefinition;params:URLSearchParams;navigate:AdminQueryNavigate;canWrite:boolean;assignableRoles:readonly Exclude<Role,'owner'>[];timeZone:string}){
 const {locale,t}=useI18n();const tt=(key:string,args?:Record<string,string|number>)=>runtimeTranslation(t,'',key,args);const screenText=(index:0|1)=>runtimeTranslation(t,`admin.screen.${screen.key}`,index),actionKind=primaryActionForScreen(screen.key),actionKey=primaryActionLabel(screen.key),action=actionKey?runtimeTranslation(t,'',actionKey):undefined,query=params.toString();
 const [page,setPage]=useState<AdminPage<AdminRecord>>({items:[],nextCursor:null}),[settingsRecord,setSettingsRecord]=useState<AdminRecord|null>(null),[loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState<Error|null>(null),[selected,setSelected]=useState<AdminRecord|null>(null),[createOpen,setCreateOpen]=useState(false),[exportOpen,setExportOpen]=useState(false),[mutationMessage,setMutationMessage]=useState('');
 const [settingsUpdated,setSettingsUpdated]=useState<string|null>(null);
 const [detailRecord,setDetailRecord]=useState<AdminRecord|null>(null),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState<Error|null>(null);
 const [credentialLink,dispatchCredential]=useReducer(credentialDialogReducer,null);
 const headingId=useId(),region=useRef<HTMLElement>(null),nextButton=useRef<HTMLButtonElement>(null),returnFocusId=useRef<string|null|undefined>(undefined);
 const inviteOpener=useRef<HTMLElement|null>(null),credentialOpener=useRef<HTMLElement|null>(null);
 const requests=useRef(createLatestRequestRunner());
 const load=useCallback(async():Promise<AdminRecord[]|null>=>{let loaded:AdminRecord[]|null=null;setLoading(true);setError(null);await requests.current.run(()=>getRecords(screen.endpoint,params),{
  success:response=>{if(screen.key==='settings'){setSettingsRecord(response as unknown as AdminRecord);const adapted=adaptSettings(response,locale,timeZone,t);setPage(adapted.page);setSettingsUpdated(adapted.lastUpdated);loaded=adapted.page.items}else{const next=normalizePage(response);if(document.activeElement===nextButton.current&&!next.nextCursor)region.current?.focus();setPage(next);setSettingsUpdated(null);loaded=next.items}setLoaded(true)},
  error:caught=>setError(caught instanceof Error?caught:new Error('Unknown response')),
  settled:()=>setLoading(false),
 });return loaded},[screen.endpoint,screen.key,query,locale,timeZone,t]);
 useEffect(()=>setLoaded(false),[screen.key]);
 useEffect(()=>{void load();return()=>requests.current.invalidate()},[load]);
 useEffect(()=>setMutationMessage(''),[screen.key,query]);
 useEffect(()=>{if(!mutationMessage)return;const timer=window.setTimeout(()=>setMutationMessage(''),4_000);return()=>window.clearTimeout(timer)},[mutationMessage]);
 useEffect(()=>{if(selected||returnFocusId.current===undefined)return;const id=returnFocusId.current;returnFocusId.current=undefined;queueMicrotask(()=>{const target=id===null?null:[...(region.current?.querySelectorAll<HTMLElement>('[data-record-id]')??[])].find(row=>row.dataset.recordId===id);(target??region.current)?.focus()})},[selected,page.items]);
 useEffect(()=>{setDetailRecord(null);setDetailError(null);if(!selected||!screen.detailEndpoint)return;let active=true;setDetailLoading(true);void loadScreenDetail(screen,selected).then(record=>{if(active)setDetailRecord(record)}).catch(caught=>{if(active)setDetailError(caught instanceof Error?caught:new Error('Unknown response'))}).finally(()=>{if(active)setDetailLoading(false)});return()=>{active=false}},[selected,screen]);
 const sort=params.get('sort')??screen.sortable?.[0]??'',direction=params.get('order')??'desc';
 const tableScreen=screen.key==='settings'?{...screen,columns:screen.columns.filter(column=>column.key==='setting'||column.key==='effectiveValue')}:screen;
 const changeSort=(key:string)=>{if(!screen.sortable?.includes(key))return;const next=new URLSearchParams(params);next.set('sort',key);next.set('order',sort===key&&direction==='desc'?'asc':'desc');next.delete('cursor');navigate(next)};
 const showAction=Boolean(action&&actionKind&&canWrite),runAction=()=>{if(!actionKind)return;if(actionKind==='invite-user'&&document.activeElement instanceof HTMLElement)inviteOpener.current=document.activeElement;setCreateOpen(true)};
 const openCredential=(value:DeliveredCredentialLink,opener?:HTMLElement|null)=>{credentialOpener.current=opener??(createOpen?inviteOpener.current:document.activeElement instanceof HTMLElement?document.activeElement:null);dispatchCredential({type:'open',value})};
 const refreshAfterMutation=async()=>{const items=await load();if(items!==null)setSelected(current=>reselect(items,current));setMutationMessage(t('admin.people.common.saved'));return items},closeAfterMutation=async()=>{const id=selected?.id===undefined||selected.id===null?null:String(selected.id),items=await refreshAfterMutation();returnFocusId.current=id!==null&&items?.some(item=>String(item.id)===id)?id:null;setSelected(null)};
 const refreshAndForget=async()=>{await refreshAfterMutation()};
 const drawerRecord=detailRecord??selected;
 const drawerName=selected?valueText(recordValue(selected,'name')??recordValue(selected,'displayName')??selected.id,'name',locale,t):t('admin.detail.title');
 const supportsRecordActions=['users','groups','models','assistants','providers','budgets'].includes(screen.key);
 const retry=()=>{region.current?.focus();void load()},content=screen.key==='settings'&&settingsRecord?<SettingsForm record={settingsRecord} canWrite={canWrite} onSaved={refreshAndForget}/>:page.items.length===0?<Empty action={showAction?action:undefined} onAction={runAction}>{screenText(1)}</Empty>:<><DataTable rows={page.items} screen={tableScreen} sort={sort} direction={direction} onSort={changeSort} onRow={screen.key==='settings'?undefined:setSelected} timeZone={timeZone}/>{settingsUpdated&&<p>{settingsUpdated}</p>}<footer className="ui-pagination"><span>{page.total===undefined?t('admin.values.shown',{count:page.items.length}):t('admin.values.shownOf',{count:page.items.length,total:page.total})}</span><button ref={nextButton} className="ui-button ui-secondary" disabled={!page.nextCursor} aria-disabled={loading?'true':undefined} onClick={()=>{if(loading||!page.nextCursor)return;const next=new URLSearchParams(params);next.set('cursor',page.nextCursor);navigate(next)}}>{t('admin.values.nextPage')}</button></footer></>;
 return <><PageHead headingId={headingId} title={runtimeTranslation(t,'admin.screens',screen.key)} description={screenText(0)} actions={<>{screen.exportEndpoint&&canWrite&&<button type="button" className="ui-button ui-secondary" onClick={()=>setExportOpen(true)}>{t("admin.common.exportCsv")}</button>}{showAction&&<button className="ui-button ui-primary" onClick={runAction}>{action}</button>}</>}/>{mutationMessage&&<p className="ui-provider-success" role="status" aria-live="polite">{mutationMessage}</p>}{screen.readOnly&&<ReadOnlyNotice/>}<FilterBar screen={screen} params={params} onChange={navigate}/><section ref={region} role="region" aria-labelledby={headingId} tabIndex={0} aria-busy={loading}>{error&&<ErrorPanel error={error} retry={retry}/>} {!loaded&&loading?<Loading/>:loaded?content:null}</section>{selected&&drawerRecord&&<Drawer title={drawerName} onClose={()=>setSelected(null)}><RecordDetail record={drawerRecord} screen={screen} timeZone={timeZone} actions={canWrite&&supportsRecordActions?<ScreenRecordActions screenKey={screen.key} record={selected} assignableRoles={assignableRoles} onChanged={closeAfterMutation} onReload={refreshAndForget} onCredential={openCredential}/>:undefined}/>{screen.detailEndpoint&&(detailLoading?<Loading/>:detailError?<ErrorPanel error={detailError}/>:detailRecord?<AuditEventDetail record={detailRecord} t={tt}/>:null)}</Drawer>}{exportOpen&&screen.exportEndpoint&&canWrite&&<AuditExportDialog endpoint={screen.exportEndpoint} filters={Object.fromEntries(params.entries())} onClose={()=>setExportOpen(false)}/>}{createOpen&&actionKind&&<ScreenCreateDrawer action={actionKind} records={page.items} assignableRoles={assignableRoles} timeZone={timeZone} onClose={()=>setCreateOpen(false)} onCreated={refreshAndForget} onCredential={openCredential}/>} {credentialLink&&<CredentialLinkDialog link={credentialLink} dispatch={dispatchCredential} timeZone={timeZone} returnFocus={credentialOpener.current}/>}</>;
}
