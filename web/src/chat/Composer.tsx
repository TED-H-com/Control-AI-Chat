import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, File as FileIcon, Paperclip, ShieldCheck, Square, X } from 'lucide-react';
import {
  availableProviders,
  CHAT_EFFORTS,
  pinnableProvider,
  preferredModel,
  supportsEffortForSelection,
  type ChatEffort,
  type ChatMode,
} from './routing.js';
import type { AvailableAssistant, AvailableModel, UploadItem } from './types.js';
import type { ChatTranslate } from './i18n.js';
import { ACCEPTED_UPLOADS, type FileValidationProblem } from './context.js';
import { PROVIDER_NAMES } from '../providerNames.js';
import type { PinnableProvider, RoleKey, ToneKey } from '@shared/types';

export interface ComposerProps {
  text: string;
  onText: (value: string) => void;
  models: readonly AvailableModel[];
  modelId: string;
  onModel: (id: string) => void;
  assistants: readonly AvailableAssistant[];
  assistantId: string|null;
  onAssistant: (id:string|null) => void;
  mode: ChatMode;
  onMode: (mode:ChatMode) => void;
  effort: ChatEffort;
  onEffort: (effort: ChatEffort) => void;
  tone: ToneKey;
  onTone: (tone:ToneKey) => void;
  role: RoleKey;
  onRole: (role:RoleKey) => void;
  streaming: boolean;
  disabled: boolean;
  uploads: readonly UploadItem[];
  uploadProblem?: FileValidationProblem|null;
  onFiles: (files:readonly File[]) => void;
  onDismissUploadProblem?: () => void;
  onRemoveFile: (item:UploadItem) => void;
  onSend: () => void;
  onStop: () => void;
  t: ChatTranslate;
}

export function applyComposerSelection(value:string,assistantId:string|null,onAssistant:(id:string|null)=>void,onMode:(mode:ChatMode)=>void,onProvider:(provider:PinnableProvider)=>void):void {
  if(value.startsWith('assistant:')){onAssistant(value.slice('assistant:'.length));return;}
  if(assistantId)onAssistant(null);
  if(value==='auto'||value==='multi_model')onMode(value);else onProvider(value as PinnableProvider);
}

export function shouldSendComposerKey(key:string,shiftKey:boolean,isComposing:boolean):boolean {
  return key==='Enter'&&!shiftKey&&!isComposing;
}

function fileSize(item:UploadItem):number|null {
  return item.remote?.sizeBytes??item.file?.size??null;
}

function formatBytes(bytes:number):string {
  if(bytes<1024)return`${bytes} B`;
  if(bytes<1024*1024)return`${(bytes/1024).toFixed(bytes<10*1024?1:0)} KB`;
  return`${(bytes/(1024*1024)).toFixed(bytes<10*1024*1024?1:0)} MB`;
}

export function Composer(props: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const idPrefix=useId();
  const [optionsOpen,setOptionsOpen]=useState(false);
  const providers = availableProviders(props.models);
  const assistants=props.assistants??[];
  const activeAssistant=assistants.find(assistant=>assistant.id===props.assistantId);
  const selected = props.models.find(model => model.id === props.modelId);
  const selectedProvider = (selected && pinnableProvider(selected)) || providers[0] || '';
  const mode=props.mode??'auto';
  const selection=activeAssistant?`assistant:${activeAssistant.id}`:(mode==='single'?selectedProvider:mode);
  const effortAvailable=supportsEffortForSelection(props.models,activeAssistant?'single':mode,activeAssistant?activeAssistant.modelId:props.modelId);
  const personasAvailable=providers.length>0||assistants.length>0;
  const toId=`${idPrefix}-to`,effortId=`${idPrefix}-effort`,roleId=`${idPrefix}-role`,toneId=`${idPrefix}-tone`;
  const effortReasonId=`${idPrefix}-effort-reason`,optionsId=`${idPrefix}-options`;

  // The box is resize:none, so keep externally inserted prompts and skills visible too.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [props.text]);

  const chooseProvider = (provider: PinnableProvider): void => {
    const model = preferredModel(props.models, provider, props.modelId);
    if (model){props.onModel(model.id);props.onMode('single');}
  };
  const chooseSelection=(value:string):void=>{
    applyComposerSelection(value,props.assistantId,props.onAssistant,props.onMode,chooseProvider);
  };
  const send=():void=>{
    props.onSend();
    requestAnimationFrame(()=>area.current?.focus());
  };

  const attachmentsReady=props.uploads.every(item=>item.status==='ready');
  const hasReadyAttachment=props.uploads.some(item=>item.status==='ready');
  const modeUnavailable=activeAssistant?false:(mode==='single'?!props.modelId:mode==='multi_model'?providers.length<2:providers.length===0);
  const canAttach=!props.disabled&&props.uploads.length<10&&!props.uploads.some(item=>item.status==='uploading'||item.status==='processing');
  const editor=<textarea ref={area} value={props.text} onChange={event => props.onText(event.target.value)} onKeyDown={event => {
    if (shouldSendComposerKey(event.key,event.shiftKey,event.nativeEvent.isComposing)) {
      event.preventDefault();
      send();
    }
  }} placeholder={props.t('chat.composer.placeholder')} aria-label={props.t('chat.composer.label')} rows={2} />;
  const attach=<button type="button" className="ui-attach-button" disabled={!canAttach} onClick={()=>fileInput.current?.click()} aria-label={props.t('chat.composer.attach')} title={props.t('chat.composer.attach')}><Paperclip size={18} aria-hidden="true" /></button>;
  const toControl=<div className="ui-field-control ui-routing-field"><label htmlFor={toId}>{props.t('chat.composer.field.to')}</label><span className="ui-select-control">
    <select id={toId} className="ui-provider-select" value={selection} disabled={providers.length===0&&assistants.length===0} onChange={event => chooseSelection(event.target.value)}>
      {providers.length === 0 && assistants.length===0 && <option value="" disabled>{props.t('chat.composer.noProvider')}</option>}
      {providers.length>0&&<option value="auto">{props.t('chat.composer.auto')}</option>}
      {providers.map(provider => <option key={provider} value={provider}>{PROVIDER_NAMES[provider]}</option>)}
      {providers.length>1&&<option value="multi_model">{props.t('chat.composer.multiModel')}</option>}
      {assistants.length>0&&<optgroup label={props.t('chat.composer.assistant.optgroup')}>
        {assistants.map(assistant=><option key={assistant.id} value={`assistant:${assistant.id}`}>{assistant.name}</option>)}
      </optgroup>}
    </select>
    <ChevronDown size={14} aria-hidden="true" />
  </span></div>;
  const effortControl=providers.length > 0 ? <div className="ui-field-control"><label htmlFor={effortId}>{props.t('chat.composer.field.effort')}</label><span className="ui-select-control">
    <select id={effortId} className="ui-effort-select" value={props.effort} disabled={!effortAvailable} onChange={event => props.onEffort(event.target.value as ChatEffort)} aria-describedby={!effortAvailable?effortReasonId:undefined} title={!effortAvailable?props.t('chat.composer.effortUnavailable'):undefined}>
      {CHAT_EFFORTS.map(effort => <option key={effort} value={effort}>{props.t(`chat.composer.effortName.${effort}`)}</option>)}
    </select>
    <ChevronDown size={14} aria-hidden="true" />
    {!effortAvailable&&<span id={effortReasonId} className="ui-sr">{props.t('chat.composer.effortUnavailable')}</span>}
  </span></div> : null;
  const roleControl=personasAvailable?<div className="ui-field-control"><label htmlFor={roleId}>{props.t('chat.composer.field.role')}</label><span className="ui-select-control">
    <select id={roleId} className="ui-role-select" value={props.role} onChange={event=>props.onRole(event.target.value as RoleKey)}>
      {(['default','coach','creative','critic','debate','support'] as const).map(role=><option key={role} value={role}>{props.t(`chat.composer.role.option.${role}`)}</option>)}
    </select><ChevronDown size={14} aria-hidden="true" /></span></div>:null;
  const toneControl=personasAvailable?<div className="ui-field-control"><label htmlFor={toneId}>{props.t('chat.composer.field.tone')}</label><span className="ui-select-control">
    <select id={toneId} className="ui-tone-select" value={props.tone} onChange={event=>props.onTone(event.target.value as ToneKey)}>
      {(['default','concise','detailed','formal','friendly'] as const).map(tone=><option key={tone} value={tone}>{props.t(`chat.composer.tone.option.${tone}`)}</option>)}
    </select><ChevronDown size={14} aria-hidden="true" /></span></div>:null;
  const options=<div id={optionsId} className={`ui-composer-options${optionsOpen?' is-open':''}`}>{effortControl}{roleControl}{toneControl}<span className="ui-options-hint"><ShieldCheck size={14} aria-hidden="true" />{props.t('chat.composer.hint')}</span></div>;
  const optionsButton=<button type="button" className="ui-options-button" aria-expanded={optionsOpen} aria-controls={optionsId} onClick={()=>setOptionsOpen(open=>!open)}>{props.t('chat.composer.options')}<ChevronDown size={14} aria-hidden="true" /></button>;
  const submit=props.streaming
    ? <button type="button" className="ui-secondary ui-send-button" onClick={props.onStop} aria-label={props.t('chat.composer.stop')===props.t('chat.composer.stopLabel')?undefined:props.t('chat.composer.stop')}><Square size={13} fill="currentColor" aria-hidden="true" />{props.t('chat.composer.stopLabel')}</button>
    : <button type="button" className="ui-primary ui-send-button" onClick={send} aria-label={props.t('chat.composer.send')===props.t('chat.composer.sendLabel')?undefined:props.t('chat.composer.send')} disabled={props.disabled || modeUnavailable || (!props.text.trim()&&!hasReadyAttachment) || !attachmentsReady}>{props.t('chat.composer.sendLabel')}<ArrowUp size={16} aria-hidden="true" /></button>;
  const actionsClass=`ui-composer-actions${providers.length===0&&assistants.length===0 ? ' is-empty' : ''}`;
  return <div className="ui-composer-dock"><div className="ui-composer">
    <div className="ui-composer-fields">{toControl}{optionsButton}{options}</div>
    {props.uploadProblem&&<div className="ui-upload-notice" role="alert"><span>{props.t(`chat.composer.error.${props.uploadProblem}`)}</span><button type="button" className="ui-icon-button" onClick={props.onDismissUploadProblem} aria-label={props.t('common.close')} title={props.t('common.close')}><X size={16} aria-hidden="true" /></button></div>}
    {props.uploads.length>0&&<ul className="ui-upload-list" aria-label={props.t('chat.composer.attachments')}>
      {props.uploads.map(item=>{const name=item.file?.name??item.remote?.name??'',size=fileSize(item);return <li key={item.localId} className={`ui-upload-row is-${item.status}`}>
        <FileIcon size={16} aria-hidden="true" />
        <span className="ui-upload-file"><span className="ui-upload-name" title={name}>{name}</span>{item.error&&(item.status==='failed'||item.status==='rejected')&&<small className="ui-upload-error" role="alert">{item.error}</small>}</span>
        <small className="ui-upload-status">{props.t(`chat.composer.fileStatus.${item.status}`)}</small>
        {size!==null&&<small className="ui-upload-size">{formatBytes(size)}</small>}
        <button type="button" className="ui-upload-remove" onClick={()=>props.onRemoveFile(item)} aria-label={props.t('chat.composer.removeFile',{name})} title={props.t('chat.composer.removeFile',{name})}><X size={16} aria-hidden="true" /></button>
      </li>;})}
    </ul>}
    <input ref={fileInput} className="ui-sr" type="file" multiple accept={ACCEPTED_UPLOADS} tabIndex={-1} aria-label={props.t('chat.composer.attach')} onChange={event=>{const files=[...(event.target.files??[])];event.target.value='';if(files.length)props.onFiles(files);}} />
    <div className="ui-composer-editor">{editor}</div>
    <div className={actionsClass}>{attach}<span className="ui-composer-check"><ShieldCheck size={14} aria-hidden="true" />{props.t('chat.composer.hint')}</span>{submit}</div>
  </div></div>;
}
