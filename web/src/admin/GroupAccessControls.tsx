import { useEffect, useState } from 'react';
import { ApiClientError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { createAdminWrite, getRecords } from './api.js';
import { Dialog, InlineError } from './components.js';
import { budgetLimitForApi, budgetLimitForForm, microUsdToUsd, modelUpdatePayload, mutationErrorText, mutationVersion, type BudgetMetric, type ModelDraft } from './form-logic.js';
import type { AdminRecord } from './types.js';

const text=(value:unknown)=>typeof value==='string'?value:'';
const id=(record:AdminRecord)=>text(record.id);
const name=(record:AdminRecord)=>text(record.name)||text(record.displayName)||text(record.email)||id(record);

export interface ProviderGroupAccess {groupId:string;enabled:boolean;version:number}

export const budgetUpdatePayload=(metric:BudgetMetric,soft:string,hard:string,enabled:boolean)=>({softLimit:soft?budgetLimitForApi(metric,soft):null,hardLimit:budgetLimitForApi(metric,hard),enabled});

export function providerAccessByGroup(record:AdminRecord):Map<string,ProviderGroupAccess>{
 const access=new Map<string,ProviderGroupAccess>();
 if(!Array.isArray(record.groupAccess))return access;
 for(const candidate of record.groupAccess){
  if(!candidate||typeof candidate!=='object')continue;
  const value=candidate as Record<string,unknown>;
  if(typeof value.groupId!=='string'||typeof value.enabled!=='boolean'||typeof value.version!=='number'||!Number.isSafeInteger(value.version)||value.version<=0)continue;
  access.set(value.groupId,{groupId:value.groupId,enabled:value.enabled,version:value.version});
 }
 return access;
}

export async function settleControlWrite(task:()=>Promise<void>,onError:(error:unknown)=>void,onSettled:()=>void):Promise<boolean>{
 try{await task();return true}catch(error){onError(error);return false}finally{onSettled()}
}

export function ModelControls({record,onChanged}:{record:AdminRecord;onChanged:()=>Promise<void>}){
 const {t}=useI18n();
 const original:ModelDraft={displayName:text(record.displayName),enabled:record.enabled!==false,contextWindowTokens:Number(record.contextWindowTokens),maxOutputTokens:Number(record.maxOutputTokens),inputPriceUsd:microUsdToUsd(Number(record.inputPriceMicroUsdPerMillion)),outputPriceUsd:microUsdToUsd(Number(record.outputPriceMicroUsdPerMillion)),capabilities:Array.isArray(record.capabilities)?record.capabilities.join(', '):''};
 const [draft,setDraft]=useState(original),[groups,setGroups]=useState<AdminRecord[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[adminWrite]=useState(createAdminWrite);
 useEffect(()=>{void getRecords('/admin/groups',new URLSearchParams()).then(page=>setGroups(page.items)).catch(caught=>setError(mutationErrorText(caught,t)))},[t]);
 const fail=(caught:unknown)=>setError(mutationErrorText(caught,t));
 const save=async()=>{if(busy||!Object.keys(modelUpdatePayload(draft,original)).length)return;setBusy(true);setError('');await settleControlWrite(async()=>{await adminWrite(`/admin/models/${encodeURIComponent(id(record))}`,'PATCH',modelUpdatePayload(draft,original),mutationVersion(record));await onChanged()},fail,()=>setBusy(false))};
 const access=async(group:AdminRecord,enabled:boolean)=>{if(busy)return;setBusy(true);setError('');await settleControlWrite(async()=>{await adminWrite(`/admin/groups/${encodeURIComponent(id(group))}/models/${encodeURIComponent(id(record))}`,enabled?'PUT':'DELETE',enabled?{}:undefined,mutationVersion(group));setGroups((await getRecords('/admin/groups',new URLSearchParams())).items);await onChanged()},fail,()=>setBusy(false))};
 return <section className="ui-group-access-controls">
  {error&&<InlineError message={error}/>}
  <label>{t('admin.fields.name')}<input value={draft.displayName} disabled={busy} onChange={event=>setDraft(current=>({...current,displayName:event.target.value}))}/></label>
  <label>{t('admin.fields.contextWindowTokens')}<input type="number" min="1" value={draft.contextWindowTokens} disabled={busy} onChange={event=>setDraft(current=>({...current,contextWindowTokens:Number(event.target.value)}))}/></label>
  <label>{t('admin.fields.outputTokens')}<input type="number" min="1" value={draft.maxOutputTokens} disabled={busy} onChange={event=>setDraft(current=>({...current,maxOutputTokens:Number(event.target.value)}))}/></label>
  <label>{t('admin.fields.capabilities')}<input value={draft.capabilities} disabled={busy} onChange={event=>setDraft(current=>({...current,capabilities:event.target.value}))}/></label>
  <label>{t('admin.fields.inputPriceMicroUsdPerMillion')} (USD)<input value={draft.inputPriceUsd} disabled={busy} onChange={event=>setDraft(current=>({...current,inputPriceUsd:event.target.value}))}/></label>
  <label>{t('admin.fields.outputPriceMicroUsdPerMillion')} (USD)<input value={draft.outputPriceUsd} disabled={busy} onChange={event=>setDraft(current=>({...current,outputPriceUsd:event.target.value}))}/></label>
  <label className="ui-switch"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event=>setDraft(current=>({...current,enabled:event.target.checked}))}/>{t('admin.fields.enabled')}</label>
  <h3>{t('admin.fields.enabledGroups')}</h3>
  <ul className="ui-access-list">{groups.map(group=><li key={id(group)}><span>{name(group)}</span><button className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>void access(group,true)}>{t('admin.fields.enableAccess')}</button><button className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>void access(group,false)}>{t('admin.fields.disableAccess')}</button></li>)}</ul>
  <footer className="ui-form-footer"><button className="ui-button ui-primary" aria-disabled={busy||!Object.keys(modelUpdatePayload(draft,original)).length?'true':undefined} onClick={()=>void save()}>{t('common.save')}</button></footer>
 </section>;
}

export function ProviderControls({record,onReload}:{record:AdminRecord;onReload:()=>Promise<void>}){
 const {t}=useI18n(),accessByGroup=providerAccessByGroup(record),[groups,setGroups]=useState<AdminRecord[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[adminWrite]=useState(createAdminWrite);
 useEffect(()=>{void getRecords('/admin/groups',new URLSearchParams()).then(page=>setGroups(page.items))},[]);
 const change=async(group:AdminRecord,enabled:boolean,version:number)=>{if(busy)return;setBusy(true);setError('');setSaved('');try{await adminWrite(`/admin/groups/${encodeURIComponent(id(group))}/providers/${encodeURIComponent(text(record.provider)||id(record))}`,'PUT',{enabled},version);await onReload();setSaved(t('admin.people.common.saved'))}catch(caught){setError(mutationErrorText(caught,t));if(caught instanceof ApiClientError&&caught.status===412)await onReload()}finally{setBusy(false)}};
 return <section className="ui-group-access-controls">{error&&<InlineError message={error}/>}<h3>{t('admin.fields.enabledGroups')}</h3>{saved&&<p className="ui-provider-success" role="status">{saved}</p>}<ul className="ui-access-list">{groups.map(group=>{const current=accessByGroup.get(id(group))??{groupId:id(group),enabled:false,version:0};return <li key={id(group)}><span>{name(group)}</span><button className="ui-button ui-secondary" aria-disabled={busy||current.enabled?'true':undefined} onClick={()=>{if(!current.enabled)void change(group,true,current.version)}}>{t('admin.fields.enableAccess')}</button><button className="ui-button ui-secondary" aria-disabled={busy||!current.enabled?'true':undefined} onClick={()=>{if(current.enabled)void change(group,false,current.version)}}>{t('admin.fields.disableAccess')}</button></li>})}</ul></section>;
}

export function BudgetControls({record,onChanged}:{record:AdminRecord;onChanged:()=>Promise<void>}){
 const {t}=useI18n(),metric=(record.metric==='usd'?'usd':'tokens') as BudgetMetric;
 const [soft,setSoft]=useState(record.softLimit==null?'':budgetLimitForForm(metric,Number(record.softLimit))),[hard,setHard]=useState(budgetLimitForForm(metric,Number(record.hardLimit))),[enabled,setEnabled]=useState(record.enabled!==false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDisable,setConfirmDisable]=useState(false),[adminWrite]=useState(createAdminWrite);
 const fail=(caught:unknown)=>setError(mutationErrorText(caught,t));
 const save=async()=>{if(busy)return;setBusy(true);setError('');await settleControlWrite(async()=>{await adminWrite(`/budgets/${encodeURIComponent(id(record))}`,'PATCH',budgetUpdatePayload(metric,soft,hard,enabled),mutationVersion(record));await onChanged()},fail,()=>setBusy(false))};
 const disable=async()=>{if(busy)return;setBusy(true);setError('');const succeeded=await settleControlWrite(async()=>{await adminWrite(`/budgets/${encodeURIComponent(id(record))}`,'DELETE',undefined,mutationVersion(record));await onChanged()},fail,()=>setBusy(false));if(succeeded)setConfirmDisable(false)};
 return <>
  <section className="ui-group-access-controls">
   {error&&<InlineError message={error}/>}
   <label>{t('admin.fields.softLimit')}<input value={soft} disabled={busy} onChange={event=>setSoft(event.target.value)}/></label>
   <label>{t('admin.fields.hardLimit')}<input value={hard} disabled={busy} onChange={event=>setHard(event.target.value)}/></label>
   <label className="ui-switch"><input type="checkbox" checked={enabled} disabled={busy} onChange={event=>setEnabled(event.target.checked)}/>{t('admin.fields.enabled')}</label>
   <footer className="ui-form-footer"><button className="ui-button ui-danger" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)setConfirmDisable(true)}}>{t('admin.fields.disableAccess')}</button><button className="ui-button ui-primary" aria-disabled={busy?'true':undefined} onClick={()=>void save()}>{t('common.save')}</button></footer>
  </section>
  {confirmDisable&&<Dialog title={t('admin.budget.disableTitle')} busy={busy} onClose={()=>setConfirmDisable(false)}><section className="ui-confirm"><p>{t('admin.budget.disableBody')}</p>{error&&<InlineError message={error}/>}<footer><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)setConfirmDisable(false)}}>{t('common.cancel')}</button><button type="button" className="ui-button ui-danger ui-danger--filled" aria-disabled={busy?'true':undefined} onClick={()=>void disable()}>{t('admin.fields.disableAccess')}</button></footer></section></Dialog>}
 </>;
}
