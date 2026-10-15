import { useMemo, useState, type FormEvent } from 'react';
import { runtimeTranslation, useI18n } from '../i18n/index.js';
import { createAdminWrite } from './api.js';
import { settingsPayload, type SettingsDraft } from './form-logic.js';
import type { AdminRecord } from './types.js';
import { Status } from './components.js';
import {TimeZoneSelect} from './TimeZoneSelect.js';
import {Field} from '../ui/Field.js';

const num=(value:unknown,fallback:number)=>typeof value==='number'?value:fallback;

export function SettingsForm({record,canWrite,onSaved}:{record:AdminRecord;canWrite:boolean;onSaved:()=>Promise<void>}){
 const {t}=useI18n();
 const original=useMemo<SettingsDraft>(()=>({
  defaultLocale:String(record.default_locale??'en'),timezone:String(record.timezone??'UTC'),retentionDays:num(record.conversation_retention_days,30),
  transcriptCapture:Boolean(record.retain_full_transcripts),
  requestsPerMinute:num(record.requests_per_minute,60),concurrentStreams:num(record.concurrent_streams,4),
  brandName:String(record.brand_name??''),supportVendorName:String(record.support_vendor_name??''),supportContactEmail:String(record.support_contact_email??''),supportContactPhone:String(record.support_contact_phone??''),supportContactUrl:String(record.support_contact_url??''),supportNotes:String(record.support_notes??''),
 }),[record]);
 const [draft,setDraft]=useState(original),[busy,setBusy]=useState(false),[error,setError]=useState(''),[iconName,setIconName]=useState(''),[adminWrite]=useState(createAdminWrite);
 const set=<K extends keyof SettingsDraft>(key:K,value:SettingsDraft[K])=>setDraft(current=>({...current,[key]:value}));
 const submit=async(event:FormEvent)=>{event.preventDefault();const payload=settingsPayload(draft,original);if(busy||Object.keys(payload).length===0)return;setBusy(true);setError('');try{await adminWrite('/admin/settings','PATCH',payload,num(record.updated_at,0));await onSaved()}catch{setError(t('admin.people.common.failed'))}finally{setBusy(false)}};
 return <section className="ui-settings-form">
  <dl className="ui-settings-context"><div><dt>{t('admin.settings.labels.name')}</dt><dd>{String(record.name??'—')}</dd></div><div><dt>{t('admin.fields.tenantSlug')}</dt><dd>{String(record.slug??'—')}</dd></div><div><dt>{t('admin.settings.labels.status')}</dt><dd><Status value={record.status??'—'}/></dd></div></dl>
  <form className="ui-admin-form" onSubmit={event=>void submit(event)}>
   {error&&<p className="ui-inline-error">{error}</p>}
   <label>{t('admin.people.users.locale')}<select disabled={!canWrite||busy} value={draft.defaultLocale} onChange={event=>set('defaultLocale',event.target.value)}>{['en','zh-TW','ja'].map(locale=><option key={locale} value={locale}>{runtimeTranslation(t,'language',locale)}</option>)}</select></label>
   <Field label={t('admin.fields.timezone')} hint={<small>{t('admin.settings.timeZoneHint')}</small>}>{field=><TimeZoneSelect id={field.id} describedBy={field.describedBy} disabled={!canWrite||busy} value={draft.timezone} onChange={value=>set('timezone',value)}/>}</Field>
   <label>{t('admin.fields.retentionDays')}<input disabled={!canWrite||busy} type="number" min="1" value={draft.retentionDays} onChange={event=>set('retentionDays',Number(event.target.value))}/></label>
   <label className="ui-switch"><input disabled={!canWrite||busy} type="checkbox" checked={draft.transcriptCapture} onChange={event=>set('transcriptCapture',event.target.checked)}/>{t('admin.settings.labels.retain_full_transcripts')}</label>
   <label>{t('admin.fields.requestsPerMinute')}<input disabled={!canWrite||busy} type="number" min="1" value={draft.requestsPerMinute} onChange={event=>set('requestsPerMinute',Number(event.target.value))}/></label>
   <label>{t('admin.fields.concurrentStreams')}<input disabled={!canWrite||busy} type="number" min="1" value={draft.concurrentStreams} onChange={event=>set('concurrentStreams',Number(event.target.value))}/></label>
   <label>{t('admin.settings.labels.brand_name')}<input disabled={!canWrite||busy} maxLength={200} value={draft.brandName} onChange={event=>set('brandName',event.target.value)}/></label>
   <label className="ui-file-picker"><span>{t('admin.settings.labels.brand_icon_file_id')}</span><span className="ui-file-row"><span className="ui-button ui-secondary">{t('admin.settings.uploadImage')}</span><span className="ui-file-name">{iconName||t('admin.settings.noImageSelected')}</span><input className="ui-file-input" disabled={!canWrite||busy} type="file" accept="image/png,image/jpeg,image/webp" onChange={async event=>{const file=event.target.files?.[0];setIconName(file?.name??'');if(!file)return;setBusy(true);setError('');try{const data=new FormData();data.set('file',file);const response=await fetch('/api/v1/admin/settings/icon',{method:'POST',credentials:'include',body:data});if(!response.ok)throw new Error();await onSaved()}catch{setError(t('admin.people.common.failed'))}finally{setBusy(false)}}}/></span></label>
   <label>{t('admin.settings.labels.support_vendor_name')}<input disabled={!canWrite||busy} maxLength={200} value={draft.supportVendorName} onChange={event=>set('supportVendorName',event.target.value)}/></label>
   <label>{t('admin.settings.labels.support_contact_email')}<input disabled={!canWrite||busy} type="email" maxLength={320} value={draft.supportContactEmail} onChange={event=>set('supportContactEmail',event.target.value)}/></label>
   <label>{t('admin.settings.labels.support_contact_phone')}<input disabled={!canWrite||busy} maxLength={100} value={draft.supportContactPhone} onChange={event=>set('supportContactPhone',event.target.value)}/></label>
   <label>{t('admin.settings.labels.support_contact_url')}<input disabled={!canWrite||busy} type="url" maxLength={2048} value={draft.supportContactUrl} onChange={event=>set('supportContactUrl',event.target.value)}/></label>
   <label>{t('admin.settings.labels.support_notes')}<textarea disabled={!canWrite||busy} maxLength={2000} value={draft.supportNotes} onChange={event=>set('supportNotes',event.target.value)}/></label>
   {canWrite&&<footer><button className="ui-button ui-primary" aria-disabled={busy||Object.keys(settingsPayload(draft,original)).length===0?'true':undefined}>{busy?t('admin.people.common.working'):t('common.save')}</button></footer>}
  </form>
 </section>;
}
