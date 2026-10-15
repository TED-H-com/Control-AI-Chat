import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { runtimeTranslation, useI18n } from '../i18n/index.js';
import { adminGet, createAdminWrite } from './api.js';
import { Empty, ErrorPanel, Loading, PageHead } from './components.js';
import {errorText} from '../error-message.js';
import {Field} from '../ui/Field.js';

type Action='flag'|'warn'|'redact'|'block';
interface Term {term:string;action:Action}
interface State {terms:Term[];counts:Record<Action,number>}
const actions:Action[]=['flag','warn','redact','block'];
export const splitCustomTerms=(value:string)=>[...new Set(value.split(/[\n,]/u).map(term=>term.trim()).filter(Boolean))];

export function CustomTerms({canWrite,initialState=null}:{canWrite:boolean;initialState?:State|null}){
  const {t}=useI18n(),[state,setState]=useState<State|null>(initialState),[loading,setLoading]=useState(initialState==null),[error,setError]=useState<Error|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const headingId=useId(),region=useRef<HTMLElement>(null),termField=useRef<HTMLInputElement>(null),bulkField=useRef<HTMLTextAreaElement>(null);
  const [adminWrite]=useState(createAdminWrite);
  const [term,setTerm]=useState(''),[action,setAction]=useState<Action>('block'),[bulk,setBulk]=useState(''),[bulkAction,setBulkAction]=useState<Action>('block');
  const parsed=useMemo(()=>splitCustomTerms(bulk),[bulk]);
  const label=(value:Action)=>runtimeTranslation(t,'admin.enums',value);
  const load=async()=>{setLoading(true);setError(null);try{setState(await adminGet<State>('/admin/custom-terms'))}catch(cause){setError(cause instanceof Error?cause:new Error(t('admin.customTerms.loadError')))}finally{setLoading(false)}};
  useEffect(()=>void load(),[]);
  const mutate=async(method:'POST'|'DELETE',body:unknown,focusOnSuccess?:()=>void):Promise<boolean>=>{if(busy)return false;setBusy(true);setNotice('');try{const next=await adminWrite<State>('/admin/custom-terms',method,body);focusOnSuccess?.();setState(next);setNotice(t('admin.customTerms.saved'));return true}catch(cause){setNotice(errorText(cause,t));return false}finally{setBusy(false)}};
  const content=state&&<>
    <div className="ui-term-counts">{actions.map(item=><span key={item} className={`ui-action ui-action--${item}`}>{label(item)} · {state.counts[item]}</span>)}</div>
    {canWrite&&<div className="ui-term-entry">
      <form className="ui-term-card" onSubmit={event=>{event.preventDefault();if(busy||term.trim().length<2)return;void mutate('POST',{terms:[term],action}).then(saved=>{if(saved){setTerm('');requestAnimationFrame(()=>termField.current?.focus())}})}}>
        <h2>{t('admin.customTerms.addTitle')}</h2>
        <label><span>{t('admin.customTerms.term')}</span><input ref={termField} value={term} onChange={event=>setTerm(event.target.value)} minLength={2} maxLength={256} placeholder={t('admin.customTerms.placeholder')}/></label>
        <label><span>{t('admin.customTerms.action')}</span><select value={action} onChange={event=>setAction(event.target.value as Action)}>{actions.map(item=><option value={item} key={item}>{label(item)}</option>)}</select></label>
        <footer className="ui-form-footer"><button className="ui-button ui-primary" disabled={term.trim().length<2} aria-disabled={busy?'true':undefined}>{t('admin.customTerms.add')}</button></footer>
      </form>
      <form className="ui-term-card" onSubmit={event=>{event.preventDefault();if(busy||!parsed.length)return;void mutate('POST',{terms:parsed,action:bulkAction}).then(saved=>{if(saved){setBulk('');requestAnimationFrame(()=>bulkField.current?.focus())}})}}>
        <h2>{t('admin.customTerms.bulkTitle')}</h2>
        <Field label={<span>{t('admin.customTerms.bulkLabel')}</span>} hint={<small>{t('admin.customTerms.bulkHint')}</small>}>{field=><textarea ref={bulkField} id={field.id} aria-describedby={field.describedBy} value={bulk} onChange={event=>setBulk(event.target.value)}/>}</Field>
        <label><span>{t('admin.customTerms.action')}</span><select value={bulkAction} onChange={event=>setBulkAction(event.target.value as Action)}>{actions.map(item=><option value={item} key={item}>{label(item)}</option>)}</select></label>
        <footer className="ui-form-footer"><span className="ui-term-preview">{t('admin.customTerms.preview',{count:parsed.length,action:label(bulkAction)})}</span><button className="ui-button ui-secondary" disabled={!parsed.length} aria-disabled={busy?'true':undefined}>{t('admin.customTerms.bulkAdd')}</button></footer>
      </form>
    </div>}
    {!state.terms.length?<Empty title={t('admin.customTerms.emptyTitle')} body={t('admin.customTerms.emptyBody')}/>:<div className="ui-table-wrap"><table><thead><tr><th>{t('admin.customTerms.term')}</th><th>{t('admin.customTerms.action')}</th>{canWrite&&<th>{t('admin.customTerms.controls')}</th>}</tr></thead><tbody>{state.terms.map(item=><tr key={item.term}><td>{item.term}</td><td><span className={`ui-action ui-action--${item.action}`}>{label(item.action)}</span></td>{canWrite&&<td className="ui-term-actions"><div className="ui-term-action-controls"><select aria-label={t('admin.customTerms.changeAction',{term:item.term})} value={item.action} aria-disabled={busy?'true':undefined} onChange={event=>{if(!busy)void mutate('POST',{terms:[item.term],action:event.target.value})}}>{actions.map(next=><option value={next} key={next}>{label(next)}</option>)}</select><button className="ui-icon-button" aria-disabled={busy?'true':undefined} aria-label={t('admin.customTerms.delete',{term:item.term})} onClick={()=>{if(!busy)void mutate('DELETE',{term:item.term},()=>region.current?.focus())}}><Trash2 size={16}/></button></div></td>}</tr>)}</tbody></table></div>}
    {notice&&<p role="status" className="ui-notice">{notice}</p>}
  </>;
  return <section ref={region} className="ui-custom-terms" role="region" aria-labelledby={headingId} tabIndex={0} aria-busy={loading}><PageHead headingId={headingId} title={t('admin.screens.custom-terms')} description={t('admin.screen.customTerms.0')} actions={state?<span className="ui-page-count">{t('admin.customTerms.total',{count:state.terms.length})}</span>:undefined}/>{error&&<ErrorPanel error={error} retry={()=>{region.current?.focus();void load()}}/>}{!state&&loading?<Loading/>:content}</section>;
}
