import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiClientError } from '../api.js';
import { runtimeTranslation, useI18n, type Locale, type Translate } from '../i18n/index.js';
import { adminGet, createAdminWrite, getRecords } from './api.js';
import { DataTable, Drawer, Empty, ErrorPanel, FilterBar, formatAdminDate, Loading, PageHead, ReasonDialog, RecordDetail, TextReasonDialog } from './components.js';
import { SCREENS } from './catalog.js';
import type { AdminPage, AdminRecord, ApprovalProgress, ApprovalReleaseStatus, ViolationAssignee, ViolationDetail, ViolationTriageStatus } from './types.js';
import type { AdminQueryNavigate } from './filtering.js';
import {zonedDateTime,zonedDateTimeInstant} from './zoned-dates.js';
import {errorText} from '../error-message.js';
import {Field} from '../ui/Field.js';
import {APPROVAL_RELEASE_ERROR_CODES,type ApprovalReleaseErrorCode} from '@shared/types';

// A reviewer acts on the joined approval request, not the violation status itself.
export const approvalDecisionAvailable = (row:AdminRecord,nowMs=Date.now()): boolean => {
  const expiresAt=typeof row.approvalExpiresAt==='string'?Date.parse(row.approvalExpiresAt):NaN;
  return typeof row.approvalId === 'string'
    && Number.isSafeInteger(Number(row.approvalVersion))
    && ['pending', 'claimed', 'release_failed'].includes(String(row.approvalStatus))
    && Number.isFinite(expiresAt)
    && expiresAt>nowMs;
};
export const shouldPollApprovalRelease=(status:unknown):boolean=>['queued','releasing','finalizing','failed'].includes(String(status));
export const approvalReleaseErrorCode=(value:unknown):ApprovalReleaseErrorCode=>(APPROVAL_RELEASE_ERROR_CODES as readonly unknown[]).includes(value)?value as ApprovalReleaseErrorCode:'release_failed';
export const isViolationConflict=(error:unknown):boolean=>error instanceof ApiClientError&&(error.status===409||error.status===412||error.body.error.code==='PRECONDITION_FAILED');
export function readableDetectorName(value:unknown,translate:Translate,_locale:Locale):string {
  const id=String(value??'').trim();if(!id)return '—';
  return runtimeTranslation(translate,'admin.enums',id);
}
const canRelease=(row:AdminRecord):boolean=>row.releaseAvailable===true;
const activeViolation=(row:AdminRecord):boolean=>['open','triaged','in_review'].includes(String(row.status));

interface ItemResponse { item:ViolationDetail }
interface BulkPayload { items?:Array<{id:string;version:number}>;allMatching?:{filter:Record<string,string>;excludedIds:string[]};command:string;parameters:Record<string,unknown>;reason?:string;dryRun:boolean }
interface BulkPreview { affected:number;skipped:number;errors:Array<{id:string;code:string;message:string}>;snapshot:Array<{id:string;version:number}> }
export const approvalPollNeedsViolationRefresh=(status:unknown):boolean=>['released','indeterminate','terminal'].includes(String(status));
export async function authoritativeViolationAfterApprovalPoll(
  status:unknown,
  violationId:string,
  get:(path:string)=>Promise<ItemResponse>=path=>adminGet<ItemResponse>(path),
):Promise<ViolationDetail|null> {
  if(!approvalPollNeedsViolationRefresh(status))return null;
  return (await get(`/admin/violations/${encodeURIComponent(violationId)}`)).item;
}
const VIOLATION_BULK_FILTERS=['search','status','approvalOnly','severity','action','detector','rule','user','group','model','provider','project','direction','assignee','date'] as const;
export function violationBulkFilter(params:URLSearchParams):Record<string,string> {
  return Object.fromEntries(VIOLATION_BULK_FILTERS.flatMap(key=>{const value=params.get(key)?.trim();return value?[[key,value]]:[];}));
}
export function violationBulkOperation(action:string,values:{assignee?:string;due?:string;note?:string},timeZone='UTC'):{command:string;parameters:Record<string,unknown>} {
  if(action==='assign')return {command:'assign',parameters:{assigneeUserId:values.assignee||null}};
  if(action==='unassign')return {command:'assign',parameters:{assigneeUserId:null}};
  if(action==='in_review')return {command:'status',parameters:{status:'in_review'}};
  if(action==='resolve')return {command:'status',parameters:{status:'resolved'}};
  if(action==='set_due'){const due=values.due??'',instant=/(?:Z|[+-]\d{2}:\d{2})$/u.test(due)?Date.parse(due):zonedDateTimeInstant(due,timeZone);return {command:'due',parameters:{dueAt:new Date(instant).toISOString()}};}
  if(action==='clear_due')return {command:'due',parameters:{dueAt:null}};
  if(action==='note')return {command:'note',parameters:{note:values.note??''}};
  return {command:action,parameters:{}};
}

export function Violations({ params, navigate, canDecide, timeZone, initialState }:{
  params:URLSearchParams;
  navigate:AdminQueryNavigate;
  canDecide:boolean;
  timeZone:string;
  initialState?:{selected?:AdminRecord|null;bulkAction?:string;selectedIds?:readonly string[]};
}) {
  const { locale, t } = useI18n();
  const [adminWrite] = useState(createAdminWrite);
  const screen = SCREENS.find(item => item.key === 'violations')!;
  const [page, setPage] = useState<AdminPage<AdminRecord>>({ items:[], nextCursor:null });
  const [loaded,setLoaded]=useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error|null>(null);
  const [selected, setSelected] = useState<AdminRecord|null>(initialState?.selected??null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [drawerError,setDrawerError]=useState('');
  const [assignees,setAssignees]=useState<ViolationAssignee[]>([]);
  const [decision, setDecision] = useState<'approve'|'deny'|null>(null);
  const [closure,setClosure]=useState<'resolved'|'dismissed'|null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [approvalProgress,setApprovalProgress]=useState<ApprovalProgress|null>(null);
  const [assigneeDraft,setAssigneeDraft]=useState('');
  const [statusDraft,setStatusDraft]=useState('');
  const [dueDraft,setDueDraft]=useState('');
  const [noteDraft,setNoteDraft]=useState('');
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set(initialState?.selectedIds??[]));
  const [allMatching,setAllMatching]=useState(false);
  const [excludedIds,setExcludedIds]=useState<Set<string>>(new Set());
  const [bulkAction,setBulkAction]=useState(initialState?.bulkAction??'acknowledge');
  const [bulkAssignee,setBulkAssignee]=useState('');
  const [bulkReason,setBulkReason]=useState('');
  const [bulkDue,setBulkDue]=useState('');
  const [bulkNote,setBulkNote]=useState('');
  const [bulkPreview,setBulkPreview]=useState<{summary:BulkPreview;payload:BulkPayload}|null>(null);
  const headingId=useId(),region=useRef<HTMLElement>(null),nextButton=useRef<HTMLButtonElement>(null),returnFocusId=useRef<string|null|undefined>(undefined),releaseState=useRef<HTMLDivElement>(null),releaseFocusPending=useRef(false),noteField=useRef<HTMLTextAreaElement>(null),statusField=useRef<HTMLSelectElement>(null),dueField=useRef<HTMLInputElement>(null);
  const detailRequest=useRef(0);
  const sort = params.get('sort') ?? 'occurredAt';
  const order = params.get('order') ?? 'desc';
  const matchingFilter=useMemo(()=>violationBulkFilter(params),[params.toString()]);
  const matchingFilterSignature=JSON.stringify(matchingFilter);

  const load = useCallback(async ():Promise<AdminPage<AdminRecord>|null> => {
    setLoading(true);
    setError(null);
    try {
      const next=await getRecords(screen.endpoint, params);
      if(document.activeElement===nextButton.current&&!next.nextCursor)region.current?.focus();
      setPage(next);
      setLoaded(true);
      const visible=new Set(next.items.flatMap(row=>typeof row.id==='string'?[row.id]:[]));
      setSelectedIds(current=>new Set([...current].filter(id=>visible.has(id))));
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(t('admin.violations.loadError')));
      return null;
    } finally {
      setLoading(false);
    }
  }, [params.toString(), screen.endpoint, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(()=>{if(selected||returnFocusId.current===undefined)return;const id=returnFocusId.current;returnFocusId.current=undefined;queueMicrotask(()=>{const target=id===null?null:[...(region.current?.querySelectorAll<HTMLElement>('[data-record-id]')??[])].find(row=>row.dataset.recordId===id);(target??region.current)?.focus()})},[selected,page.items]);
  useEffect(()=>{if(decision||!releaseFocusPending.current)return;releaseFocusPending.current=false;releaseState.current?.focus()},[decision,approvalProgress?.releaseStatus]);
  useEffect(()=>{setAllMatching(false);setExcludedIds(new Set());setSelectedIds(new Set());setBulkPreview(null);},[matchingFilterSignature]);
  useEffect(()=>{
    if(!canDecide)return;
    void adminGet<{items:ViolationAssignee[]}>('/admin/violations/assignees').then(result=>setAssignees(result.items)).catch(()=>setAssignees([]));
  },[canDecide]);

  const syncDrafts=(row:AdminRecord):void=>{
    setAssigneeDraft(typeof row.assigneeId==='string'?row.assigneeId:'');
    setStatusDraft('');setDueDraft(zonedDateTime(row.dueAt,timeZone));setNoteDraft('');
  };
  const open=async(row:AdminRecord):Promise<void>=>{
    const requestNumber=++detailRequest.current;
    setSelected(row);syncDrafts(row);setDrawerError('');setApprovalProgress(progressFrom(row));setDetailLoading(true);
    try{
      const result=await adminGet<ItemResponse>(`/admin/violations/${encodeURIComponent(String(row.id))}`);
      if(requestNumber!==detailRequest.current)return;
      setSelected(result.item);syncDrafts(result.item);setApprovalProgress(progressFrom(result.item));
    }catch(caught){if(requestNumber===detailRequest.current)setDrawerError(errorText(caught,t));}
    finally{if(requestNumber===detailRequest.current)setDetailLoading(false);}
  };
  const refreshSelected=useCallback(async(id:string):Promise<void>=>{
    try{
      const result=await adminGet<ItemResponse>(`/admin/violations/${encodeURIComponent(id)}`);
      setSelected(result.item);syncDrafts(result.item);setApprovalProgress(progressFrom(result.item));
    }catch(caught){
      if(caught instanceof ApiClientError&&caught.status===404){returnFocusId.current=null;setSelected(null);setNotice(t('admin.violations.noLongerAvailable'));return;}
      throw caught;
    }
  },[t]);

  useEffect(()=>{
    if(!selected||!approvalProgress||!shouldPollApprovalRelease(approvalProgress.releaseStatus))return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{
        const current=await adminGet<ApprovalProgress>(`/gate/approvals/${encodeURIComponent(approvalProgress.id)}`);
        if(cancelled)return;
        const authoritative=await authoritativeViolationAfterApprovalPoll(current.releaseStatus,String(selected.id));
        if(cancelled)return;
        if(authoritative){
          setSelected(authoritative);syncDrafts(authoritative);setApprovalProgress(progressFrom(authoritative));
          if(current.releaseStatus==='released')setNotice(t('admin.violations.releaseReleased'));
          void load();return;
        }
        setApprovalProgress(current);
        setSelected(row=>row?{...row,approvalStatus:current.status,approvalVersion:current.version,releaseStatus:current.releaseStatus,releaseErrorCode:current.releaseErrorCode,releaseMessageId:current.releaseMessageId,releaseAttempts:current.releaseAttempts}:row);
        if(shouldPollApprovalRelease(current.releaseStatus))timer=setTimeout(()=>void poll(),current.releaseStatus==='failed'?5000:2000);
      }catch(caught){if(!cancelled){setDrawerError(errorText(caught,t));timer=setTimeout(()=>void poll(),5000);}}
    };
    timer=setTimeout(()=>void poll(),1000);
    return()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[approvalProgress?.id,approvalProgress?.releaseStatus,selected?.id,load,t]);

  const changeSort = (key:string): void => {
    if (!screen.sortable?.includes(key)) return;
    const next = new URLSearchParams(params);
    next.set('sort', key);
    next.set('order', sort === key && order === 'desc' ? 'asc' : 'desc');
    next.delete('cursor');
    navigate(next);
  };

  const mutateViolation=async(path:string,body:Record<string,unknown>,success:string,focusOnSuccess?:()=>void):Promise<void>=>{
    if(busy||!selected||!Number.isSafeInteger(Number(selected.version)))return;
    const id=String(selected.id),version=Number(selected.version);setBusy(true);setDrawerError('');
    try{
      const result=await adminWrite<ItemResponse>(path,'POST',body,version);
      if(focusOnSuccess)requestAnimationFrame(focusOnSuccess);
      setSelected(result.item);syncDrafts(result.item);setApprovalProgress(progressFrom(result.item));setNotice(success);
      await load();
    }catch(caught){
      if(isViolationConflict(caught)){
        setDrawerError(t('admin.violations.changed'));
        try{await Promise.all([refreshSelected(id),load()]);}catch(refreshError){setDrawerError(errorText(refreshError,t));}
      }else setDrawerError(errorText(caught,t));
    }finally{setBusy(false);}
  };

  const applyStatus=(status:ViolationTriageStatus,reason?:string):void=>{
    if(busy||!selected)return;
    const id=encodeURIComponent(String(selected.id));
    if(status==='resolved'||status==='dismissed'){
      if(reason===undefined){setClosure(status);return;}
      const path=status==='dismissed'?`/admin/violations/${id}/dismiss`:`/admin/violations/${id}/status`;
      void mutateViolation(path,status==='dismissed'?{reason}:{status,reason},t(status==='dismissed'?'admin.violations.dismissed':'admin.violations.resolved'),()=>statusField.current?.focus());
      return;
    }
    const acknowledge=status==='triaged'&&selected.status==='open';
    void mutateViolation(`/admin/violations/${id}/${acknowledge?'acknowledge':'status'}`,acknowledge?{}:{status},t('admin.violations.statusUpdated'),()=>statusField.current?.focus());
  };

  const decide = async (reason:string, ticketUrl?:string): Promise<void> => {
    if (!selected || !decision || !approvalDecisionAvailable(selected)) return;
    const version = Number(selected.approvalVersion),approvalId=String(selected.approvalId),choice=decision;
    setBusy(true);setDrawerError('');
    try {
      const result=await adminWrite<{id:string;status:string;releaseStatus?:ApprovalReleaseStatus;reason:string}>(`/gate/approvals/${encodeURIComponent(approvalId)}/decision`, 'POST', { decision:choice, reason, ticketUrl, version }, version);
      setDecision(null);
      if(choice==='approve'){
        const progress:ApprovalProgress={id:result.id,status:result.status,releaseStatus:result.releaseStatus??'queued',releaseErrorCode:null,releaseMessageId:null,releaseAttempts:Number(selected.releaseAttempts??0),version:version+1};
        releaseFocusPending.current=true;setApprovalProgress(progress);setSelected(row=>row?{...row,approvalStatus:progress.status,approvalVersion:progress.version,releaseStatus:progress.releaseStatus}:row);
        setNotice(t('admin.violations.releaseQueued'));await load();
      }else{
        setNotice(t('admin.violations.denied'));const id=String(selected.id),next=await load();returnFocusId.current=next?.items.some(item=>String(item.id)===id)?id:null;setSelected(null);
      }
    } catch (caught) {
      setDrawerError(errorText(caught,t));
      if(isViolationConflict(caught)){try{await Promise.all([refreshSelected(String(selected.id)),load()]);}catch{/* The original conflict remains visible. */}}
    } finally { setBusy(false); }
  };

  const selectedRows=useMemo(()=>page.items.filter(row=>typeof row.id==='string'&&selectedIds.has(row.id)&&Number.isSafeInteger(Number(row.version))),[page.items,selectedIds]);
  const visibleIds=useMemo(()=>page.items.flatMap(row=>typeof row.id==='string'?[row.id]:[]),[page.items]);
  const tableSelection=useMemo(()=>allMatching?new Set(visibleIds.filter(id=>!excludedIds.has(id))):selectedIds,[allMatching,visibleIds,excludedIds,selectedIds]);
  const bulkPayload=(dryRun:boolean):BulkPayload=>{
    const {command,parameters}=violationBulkOperation(bulkAction,{assignee:bulkAssignee,due:bulkDue,note:bulkNote},timeZone);
    const scope=allMatching
      ?{allMatching:{filter:matchingFilter,excludedIds:[...excludedIds]}}
      :{items:selectedRows.map(row=>({id:String(row.id),version:Number(row.version)}))};
    return {...scope,command,parameters,...(['resolve','dismiss'].includes(bulkAction)?{reason:bulkReason.trim()}:{}),dryRun};
  };
  const previewBulk=async():Promise<void>=>{
    setBusy(true);setNotice('');setBulkPreview(null);
    try{
      const payload=bulkPayload(true),summary=await adminWrite<BulkPreview>('/admin/violations/bulk','POST',payload);
      const {allMatching:_allMatching,...validated}=payload;
      setBulkPreview({summary,payload:{...validated,items:summary.snapshot,dryRun:false}});
    }
    catch(caught){setNotice(errorText(caught,t));}
    finally{setBusy(false);}
  };
  const confirmBulk=async():Promise<void>=>{
    if(!bulkPreview)return;setBusy(true);
    try{await adminWrite('/admin/violations/bulk','POST',bulkPreview.payload);setNotice(t('admin.violations.bulkApplied',{count:bulkPreview.summary.affected}));setSelectedIds(new Set());setExcludedIds(new Set());setAllMatching(false);setBulkPreview(null);await load();}
    catch(caught){setBulkPreview(null);setNotice(errorText(caught,t));await load();}
    finally{setBusy(false);}
  };

  const displayDetector=(row:AdminRecord):AdminRecord=>({...row,detector:readableDetectorName(row.detector,t,locale)});
  const displayRows=page.items.map(displayDetector);
  const detail=selected?withoutWorkflowFields(displayDetector(selected)):null;
  const transitions=Array.isArray(selected?.allowedTransitions)?selected.allowedTransitions.filter((value):value is ViolationTriageStatus=>typeof value==='string'):[];
  const releaseStatus=approvalProgress?.releaseStatus??(typeof selected?.releaseStatus==='string'?selected.releaseStatus:null);
  const bulkReasonValid=!['resolve','dismiss'].includes(bulkAction)||bulkReason.trim().length>=10;
  const bulkInputValid=bulkReasonValid&&(bulkAction!=='set_due'||validLocalDateTime(bulkDue))&&(bulkAction!=='note'||bulkNote.trim().length>=3);
  const bulkActive=allMatching||selectedIds.size>0;
  const filterSummary=Object.keys(matchingFilter).length===0?t('admin.violations.allMatchingNoFilters'):t('admin.violations.allMatchingFilters',{count:Object.keys(matchingFilter).length});

  return <>
    <PageHead headingId={headingId} title={t('admin.screens.violations')} description={t('admin.screen.violations.0')}/>
    <FilterBar screen={screen} params={params} onChange={navigate} />
    {notice && <p role="status" className="ui-notice">{notice}</p>}
    {canDecide&&bulkActive&&<section className="ui-bulk" aria-label={t('admin.violations.bulkTitle')}>
      <strong>{allMatching?t('admin.violations.allMatchingSelected'):t('admin.violations.selected',{count:selectedIds.size})}</strong>
      {allMatching&&<span className="ui-bulk-scope">{filterSummary}</span>}
      <button className="ui-button ui-secondary" onClick={()=>{if(allMatching){setSelectedIds(new Set(tableSelection));setAllMatching(false);setExcludedIds(new Set());}else{setAllMatching(true);setExcludedIds(new Set());}setBulkPreview(null);}}>{t(allMatching?'admin.violations.usePageSelection':'admin.violations.selectAllMatching')}</button>
      <label><span>{t('admin.violations.bulkAction')}</span><select value={bulkAction} onChange={event=>{setBulkAction(event.target.value);setBulkPreview(null);}}>
        {['acknowledge','in_review','resolve','dismiss','assign','unassign','set_due','clear_due','note'].map(value=><option key={value} value={value}>{runtimeTranslation(t,'admin.violations.bulk',value)}</option>)}
      </select></label>
      {bulkAction==='assign'&&<label><span>{t('admin.violations.assignee')}</span><select value={bulkAssignee} onChange={event=>{setBulkAssignee(event.target.value);setBulkPreview(null);}}><option value="">{t('admin.values.none')}</option>{assignees.map(user=><option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></label>}
      {['resolve','dismiss'].includes(bulkAction)&&<Field label={<span>{t('admin.violations.reason')}</span>}>{field=><input id={field.id} aria-describedby={field.describedBy} minLength={10} maxLength={1000} value={bulkReason} onChange={event=>{setBulkReason(event.target.value);setBulkPreview(null);}} placeholder={t('admin.violations.reasonHint')}/>}</Field>}
      {bulkAction==='set_due'&&<Field label={<span>{t('admin.violations.dueDate')}</span>} hint={<span className="ui-field-hint">{t('admin.violations.dueDateHint',{zone:timeZone})}</span>}>{field=><input id={field.id} aria-describedby={field.describedBy} type="datetime-local" value={bulkDue} onChange={event=>{setBulkDue(event.target.value);setBulkPreview(null);}}/>}</Field>}
      {bulkAction==='note'&&<Field label={<span>{t('admin.violations.notes')}</span>}>{field=><textarea id={field.id} aria-describedby={field.describedBy} minLength={3} maxLength={2000} value={bulkNote} onChange={event=>{setBulkNote(event.target.value);setBulkPreview(null);}} placeholder={t('admin.violations.noteHint')}/>}</Field>}
      <button className="ui-button ui-secondary" disabled={(!allMatching&&selectedRows.length===0)||!bulkInputValid} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)void previewBulk()}}>{t('admin.violations.reviewBulk')}</button>
      {bulkPreview&&<><span>{t('admin.violations.bulkPreview',{affected:bulkPreview.summary.affected,skipped:bulkPreview.summary.skipped})}</span>{bulkPreview.summary.skipped>0&&<span role="alert" className="ui-bulk-warning">{t('admin.violations.bulkSkippedDetail')}</span>}<button className="ui-button ui-secondary" disabled={bulkPreview.summary.skipped>0} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)void confirmBulk()}}>{t('admin.violations.applyBulk')}</button></>}
    </section>}
    <section ref={region} role="region" aria-labelledby={headingId} tabIndex={0} aria-busy={loading}>
      {error&&<ErrorPanel error={error} retry={()=>{region.current?.focus();void load()}}/>}
      {!loaded&&loading?<Loading/>:loaded&&(page.items.length === 0
      ? <Empty>{t('admin.screen.violations.1')}</Empty>
      : <>
        <DataTable rows={displayRows} screen={screen} sort={sort} direction={order} onSort={changeSort} onRow={row=>{const original=page.items.find(item=>item.id===row.id)??row;void open(original)}} timeZone={timeZone} selection={canDecide?{ids:tableSelection,label:t('admin.violations.select'),onChange:(id,checked)=>{if(allMatching)setExcludedIds(current=>{const next=new Set(current);checked?next.delete(id):next.add(id);setBulkPreview(null);return next;});else setSelectedIds(current=>{const next=new Set(current);checked?next.add(id):next.delete(id);setBulkPreview(null);return next;});},onAll:(ids,checked)=>{if(allMatching)setExcludedIds(current=>{const next=new Set(current);for(const id of ids)checked?next.delete(id):next.add(id);setBulkPreview(null);return next;});else setSelectedIds(current=>{const next=new Set(current);for(const id of ids)checked?next.add(id):next.delete(id);setBulkPreview(null);return next;});}}:undefined}/>
        <footer className="ui-pagination"><span>{t('admin.values.shown', { count:page.items.length })}</span><button ref={nextButton} className="ui-button ui-secondary" disabled={!page.nextCursor} aria-disabled={loading?'true':undefined} onClick={() => {if(loading||!page.nextCursor)return;const next = new URLSearchParams(params);next.set('cursor', page.nextCursor);navigate(next);}}>{t('admin.values.nextPage')}</button></footer>
      </>)}</section>
    {selected && <Drawer title={t('admin.violations.drawer')} onClose={() => {if(!busy){detailRequest.current+=1;setSelected(null);setApprovalProgress(null);setDrawerError('');setDetailLoading(false);}}}>
      {drawerError&&<p role="alert" className="ui-inline-error">{drawerError}</p>}
      {detail&&<RecordDetail record={detail} screen={screen} timeZone={timeZone} extraDetails={<div><dt>{t('admin.violations.reference')}</dt><dd className="ui-reference">{String(selected.id??'—')}</dd></div>}/>} {detailLoading&&<Loading/>}
      {canDecide&&!detailLoading&&<div className="ui-triage-controls">
        <section><h3>{t('admin.violations.assignment')}</h3><div><label><span>{t('admin.violations.assignee')}</span><select value={assigneeDraft} disabled={busy||!activeViolation(selected)} onChange={event=>setAssigneeDraft(event.target.value)}><option value="">{t('admin.values.none')}</option>{assignees.map(user=><option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></label><button className="ui-button ui-secondary" disabled={!activeViolation(selected)} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy&&activeViolation(selected))void mutateViolation(`/admin/violations/${encodeURIComponent(String(selected.id))}/assign`,{assigneeUserId:assigneeDraft||null},t('admin.violations.assignmentUpdated'))}}>{assigneeDraft?t('common.save'):t('admin.violations.unassign')}</button></div></section>
        {transitions.length>0&&<section><h3 id="ui-violation-workflow">{t('admin.violations.workflow')}</h3><div><select ref={statusField} aria-labelledby="ui-violation-workflow" value={statusDraft} disabled={busy} onChange={event=>setStatusDraft(event.target.value)}><option value="">{t('admin.violations.chooseStatus')}</option>{transitions.map(status=><option key={status} value={status}>{runtimeTranslation(t,'admin.enums',status)}</option>)}</select><button className="ui-button ui-secondary" disabled={!statusDraft} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy&&statusDraft)applyStatus(statusDraft as ViolationTriageStatus)}}>{t('admin.violations.updateStatus')}</button></div></section>}
        {activeViolation(selected)&&<section><Field bare labelTag="h3" labelId="ui-violation-due" hintBeforeControl label={t('admin.violations.dueDate')} hint={<p className="ui-field-hint">{t('admin.violations.dueDateHint',{zone:timeZone})}</p>}>{field=><div><input ref={dueField} id={field.id} aria-labelledby={field.labelledBy} aria-describedby={field.describedBy} type="datetime-local" value={dueDraft} onChange={event=>setDueDraft(event.target.value)}/><button className="ui-button ui-secondary" disabled={!dueDraft} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy&&dueDraft)void mutateViolation(`/admin/violations/${encodeURIComponent(String(selected.id))}/due`,{dueAt:new Date(zonedDateTimeInstant(dueDraft,timeZone)).toISOString()},t('admin.violations.dueUpdated'))}}>{t('common.save')}</button><button className="ui-button ui-secondary" disabled={selected.dueAt==null} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy&&selected.dueAt!=null)void mutateViolation(`/admin/violations/${encodeURIComponent(String(selected.id))}/due`,{dueAt:null},t('admin.violations.dueCleared'),()=>dueField.current?.focus())}}>{t('admin.violations.clearDue')}</button></div>}</Field></section>}
        <section><h3 id="ui-violation-notes">{t('admin.violations.notes')}</h3><div><textarea ref={noteField} aria-labelledby="ui-violation-notes" value={noteDraft} minLength={3} maxLength={2000} placeholder={t('admin.violations.noteHint')} onChange={event=>setNoteDraft(event.target.value)}/><button className="ui-button ui-secondary" disabled={noteDraft.trim().length<3} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy&&noteDraft.trim().length>=3)void mutateViolation(`/admin/violations/${encodeURIComponent(String(selected.id))}/notes`,{note:noteDraft},t('admin.violations.noteAdded'),()=>noteField.current?.focus())}}>{t('admin.violations.addNote')}</button></div>{Array.isArray(selected.comments)&&selected.comments.length>0&&<ol className="ui-timeline">{(selected.comments as ViolationDetail['comments']).map(comment=><li key={comment.id}><header><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{formatAdminDate(comment.createdAt,locale,timeZone)}</time></header><p>{comment.body}</p></li>)}</ol>}</section>
      </div>}
      {releaseStatus&&<div ref={releaseState} className="ui-release-state" data-state={releaseStatus} tabIndex={-1}><strong>{t('admin.violations.releaseTitle')}</strong><span>{runtimeTranslation(t,'admin.violations.release',releaseStatus)}</span>{approvalProgress?.releaseErrorCode&&<span>{runtimeTranslation(t,'admin.violations.releaseErrors',approvalReleaseErrorCode(approvalProgress.releaseErrorCode))}</span>}</div>}
      {canDecide && approvalDecisionAvailable(selected) && <div className="ui-decision"><p>{t(canRelease(selected)?'admin.violations.review':'admin.violations.releaseUnavailable')}</p><button className="ui-button ui-danger" aria-disabled={busy?'true':undefined} onClick={() => {if(!busy)setDecision('deny')}}>{t('admin.violations.deny')}</button>{canRelease(selected)&&<button className="ui-button ui-primary" disabled={shouldPollApprovalRelease(releaseStatus)} aria-disabled={busy?'true':undefined} onClick={() => {if(!busy&&!shouldPollApprovalRelease(releaseStatus))setDecision('approve')}}>{t('admin.violations.approve')}</button>}</div>}
    </Drawer>}
    {decision && <ReasonDialog decision={decision} busy={busy} onCancel={() => setDecision(null)} onSubmit={(reason, ticket) => void decide(reason, ticket)} />}
    {closure&&<TextReasonDialog title={t(closure==='resolved'?'admin.violations.resolveTitle':'admin.violations.dismissTitle')} description={t('admin.violations.reasonDescription')} label={t('admin.violations.reason')} hint={t('admin.violations.reasonHint')} submitLabel={t(closure==='resolved'?'admin.violations.resolve':'admin.violations.dismiss')} busy={busy} onCancel={()=>setClosure(null)} onSubmit={reason=>{const status=closure;setClosure(null);applyStatus(status,reason);}}/>}
  </>;
}

export function validLocalDateTime(value:string):boolean {
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if(!match)return false;
  const nominal=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]),Number(match[5]));
  return new Date(nominal).toISOString().slice(0,16)===value;
}
function withoutWorkflowFields(row:AdminRecord):AdminRecord {const hidden=new Set(['comments','allowedTransitions','releaseAvailable','releaseStatus','releaseErrorCode','releaseMessageId','releaseAttempts']);return Object.fromEntries(Object.entries(row).filter(([key])=>!hidden.has(key)));}
function progressFrom(row:AdminRecord):ApprovalProgress|null {if(typeof row.approvalId!=='string'||typeof row.releaseStatus!=='string')return null;return {id:row.approvalId,status:String(row.approvalStatus??''),releaseStatus:row.releaseStatus as ApprovalReleaseStatus,releaseErrorCode:typeof row.releaseErrorCode==='string'?row.releaseErrorCode:null,releaseMessageId:typeof row.releaseMessageId==='string'?row.releaseMessageId:null,releaseAttempts:Number(row.releaseAttempts??0),version:Number(row.approvalVersion??0)};}
