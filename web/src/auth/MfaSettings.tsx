import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, KeyRound, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react';
import { ApiClientError } from '../api.js';
import type { ChatTranslate } from '../chat/i18n.js';
import { chatApi } from '../chat/api.js';

export interface MfaEnrollment {
  secret:string;
  otpauthUri:string;
  rotating:boolean;
}

export type MfaErrorKind='loadError'|'setupError'|'verifyError'|'disableError'|'recentRequired';
type Screen='loading'|'ready'|'setup'|'recovery'|'disable-confirm';
type BusyAction='setup'|'verify'|'disable'|null;
type CopyState='key'|'codes'|'failed'|null;

export function normalizeSetupTotpCode(value:string):string {
  return value.replace(/[^0-9]/gu,'').slice(0,6);
}

export function safeOtpauthUri(value:string):string|null {
  try {
    const url=new URL(value);
    return url.protocol==='otpauth:'&&url.hostname==='totp'?value:null;
  } catch { return null; }
}

export function groupedTotpSecret(value:string):string {
  return value.match(/.{1,4}/gu)?.join(' ')??value;
}

export function recoveryCodesText(codes:readonly string[]):string {
  return codes.join('\n');
}

export function mfaErrorKind(error:unknown,fallback:Exclude<MfaErrorKind,'recentRequired'>):MfaErrorKind {
  return error instanceof ApiClientError&&error.body.error.code==='MFA_REQUIRED'?'recentRequired':fallback;
}

async function copyToClipboard(value:string):Promise<boolean> {
  try {
    if(!navigator.clipboard?.writeText)return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch { return false; }
}

function usePanelHeadingFocus() {
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{
    heading.current?.focus();
    heading.current?.scrollIntoView({block:'start'});
  },[]);
  return heading;
}

export function MfaSettings({t}:{t:ChatTranslate}) {
  const [screen,setScreen]=useState<Screen>('loading');
  const [enabled,setEnabled]=useState(false);
  const [enrollment,setEnrollment]=useState<MfaEnrollment|null>(null);
  const [recoveryCodes,setRecoveryCodes]=useState<readonly string[]>([]);
  const [code,setCode]=useState('');
  const [acknowledged,setAcknowledged]=useState(false);
  const [busy,setBusy]=useState<BusyAction>(null);
  const [error,setError]=useState<MfaErrorKind|null>(null);
  const [notice,setNotice]=useState<'disabledSuccess'|null>(null);
  const [copyState,setCopyState]=useState<CopyState>(null);
  const alive=useRef(true);
  const startButton=useRef<HTMLButtonElement>(null);
  const disableButton=useRef<HTMLButtonElement>(null);
  const cancelDisableButton=useRef<HTMLButtonElement>(null);

  const load=async(signal?:AbortSignal):Promise<void>=>{
    setScreen('loading');
    setError(null);
    try {
      const me=await chatApi.me(signal);
      if(signal?.aborted||!alive.current)return;
      setEnabled(me.mfa.enabled);
      setScreen('ready');
    } catch {
      if(signal?.aborted||!alive.current)return;
      setError('loadError');
      setScreen('ready');
    }
  };

  useEffect(()=>{
    alive.current=true;
    const abort=new AbortController();
    void load(abort.signal);
    return()=>{alive.current=false;abort.abort()};
  },[]);

  useEffect(()=>{
    if(screen!=='disable-confirm')return;
    cancelDisableButton.current?.focus();
    const close=(event:KeyboardEvent):void=>{
      if(event.key!=='Escape'||busy==='disable')return;
      setScreen('ready');
      requestAnimationFrame(()=>disableButton.current?.focus());
    };
    document.addEventListener('keydown',close);
    return()=>document.removeEventListener('keydown',close);
  },[screen,busy]);

  const beginSetup=async():Promise<void>=>{
    if(busy)return;
    setBusy('setup');
    setError(null);
    setNotice(null);
    setCopyState(null);
    try {
      const result=await chatApi.mfaSetup();
      if(!alive.current)return;
      setEnrollment({...result,rotating:enabled});
      setCode('');
      setScreen('setup');
    } catch(cause) {
      if(!alive.current)return;
      setError(mfaErrorKind(cause,'setupError'));
      setScreen('ready');
    } finally { if(alive.current)setBusy(null); }
  };

  const cancelSetup=():void=>{
    setEnrollment(null);
    setCode('');
    setCopyState(null);
    setError(null);
    setScreen('ready');
    requestAnimationFrame(()=>startButton.current?.focus());
  };

  const verify=async(event:FormEvent):Promise<void>=>{
    event.preventDefault();
    if(busy||code.length!==6)return;
    setBusy('verify');
    setError(null);
    try {
      const result=await chatApi.mfaVerify(code);
      if(!alive.current)return;
      // Clear the seed as soon as the server promotes it. Plaintext recovery codes stay only in
      // this component until the user acknowledges saving them or leaves the page.
      setEnrollment(null);
      setCode('');
      setEnabled(true);
      setRecoveryCodes(result.recoveryCodes);
      setAcknowledged(false);
      setCopyState(null);
      setScreen('recovery');
    } catch(cause) {
      if(!alive.current)return;
      setError(mfaErrorKind(cause,'verifyError'));
    } finally { if(alive.current)setBusy(null); }
  };

  const finishRecovery=():void=>{
    if(!acknowledged)return;
    setRecoveryCodes([]);
    setAcknowledged(false);
    setCopyState(null);
    setScreen('ready');
  };

  const cancelDisable=():void=>{
    setScreen('ready');
    requestAnimationFrame(()=>disableButton.current?.focus());
  };

  const disable=async():Promise<void>=>{
    if(busy)return;
    setBusy('disable');
    setError(null);
    setNotice(null);
    try {
      await chatApi.mfaDelete();
      if(!alive.current)return;
      setEnabled(false);
      setEnrollment(null);
      setRecoveryCodes([]);
      setNotice('disabledSuccess');
      setScreen('ready');
    } catch(cause) {
      if(!alive.current)return;
      setError(mfaErrorKind(cause,'disableError'));
      setScreen('ready');
    } finally { if(alive.current)setBusy(null); }
  };

  const copy=async(value:string,success:Exclude<CopyState,'failed'|null>):Promise<void>=>{
    setCopyState(await copyToClipboard(value)?success:'failed');
  };

  const feedback=error?t(`chat.settings.mfa.${error}`):notice?t(`chat.settings.mfa.${notice}`):null;
  const feedbackRole=error?'alert':'status';

  if(screen==='loading')return <section className="ui-settings-section ui-mfa" aria-labelledby="ui-mfa-title" aria-busy="true"><h2 id="ui-mfa-title">{t('chat.settings.mfa.title')}</h2><p>{t('common.loading')}</p></section>;

  if(screen==='setup'&&enrollment)return <MfaSetupPanel t={t} enrollment={enrollment} code={code} busy={busy==='verify'} error={error} copyState={copyState} onCode={setCode} onVerify={event=>void verify(event)} onCancel={cancelSetup} onCopy={value=>void copy(value,'key')} />;

  if(screen==='recovery')return <MfaRecoveryPanel t={t} codes={recoveryCodes} acknowledged={acknowledged} copyState={copyState} onAcknowledge={setAcknowledged} onCopy={()=>void copy(recoveryCodesText(recoveryCodes),'codes')} onDone={finishRecovery} />;

  return <section className="ui-settings-section ui-mfa" aria-labelledby="ui-mfa-title">
    <div className="ui-mfa__heading"><h2 id="ui-mfa-title">{t('chat.settings.mfa.title')}</h2>{!error||error!=='loadError'?<span className="ui-mfa__status" data-enabled={enabled}>{enabled?<ShieldCheck size={16} aria-hidden="true"/>:<ShieldOff size={16} aria-hidden="true"/>}{t(enabled?'chat.settings.mfa.statusEnabled':'chat.settings.mfa.statusDisabled')}</span>:null}</div>
    {feedback&&<p className={`ui-mfa__feedback${error?' is-error':''}`} role={feedbackRole} aria-live="polite">{feedback}</p>}
    {error==='recentRequired'&&<p><a className="ui-mfa__reauth" href="/login?returnTo=%2Fsettings">{t('chat.settings.mfa.recentAction')}</a></p>}
    {error==='loadError'?<button type="button" className="ui-button ui-secondary" onClick={()=>void load()}>{t('common.retry')}</button>:<>
      <p className="ui-mfa__description">{t(enabled?'chat.settings.mfa.enabledDescription':'chat.settings.mfa.disabledDescription')}</p>
      {screen==='disable-confirm'?<div className="ui-mfa__confirm" role="alertdialog" aria-labelledby="ui-mfa-disable-title" aria-describedby="ui-mfa-disable-description">
        <h3 id="ui-mfa-disable-title">{t('chat.settings.mfa.disableTitle')}</h3>
        <p id="ui-mfa-disable-description">{t('chat.settings.mfa.disableDescription')}</p>
        <div className="ui-settings-actions"><button ref={cancelDisableButton} className="ui-button ui-secondary" type="button" disabled={busy==='disable'} onClick={cancelDisable}>{t('common.cancel')}</button><button className="ui-button ui-danger" type="button" disabled={busy==='disable'} onClick={()=>void disable()}>{busy==='disable'?t('chat.settings.mfa.disabling'):t('chat.settings.mfa.confirmDisable')}</button></div>
      </div>:<div className="ui-settings-actions">{enabled?<><button ref={startButton} className="ui-button ui-secondary" type="button" disabled={Boolean(busy)} onClick={()=>void beginSetup()}><RotateCcw size={17} aria-hidden="true"/>{busy==='setup'?t('common.loading'):t('chat.settings.mfa.replace')}</button><button ref={disableButton} className="ui-button ui-danger" type="button" disabled={Boolean(busy)} onClick={()=>{setError(null);setNotice(null);setScreen('disable-confirm')}}><ShieldOff size={17} aria-hidden="true"/>{t('chat.settings.mfa.disable')}</button></>:<button ref={startButton} className="ui-button ui-secondary" type="button" disabled={Boolean(busy)} onClick={()=>void beginSetup()}><KeyRound size={17} aria-hidden="true"/>{busy==='setup'?t('common.loading'):t('chat.settings.mfa.enable')}</button>}</div>}
    </>}
  </section>;
}

export function MfaSetupPanel({t,enrollment,code,busy,error,copyState,onCode,onVerify,onCancel,onCopy}:{t:ChatTranslate;enrollment:MfaEnrollment;code:string;busy:boolean;error:MfaErrorKind|null;copyState:CopyState;onCode:(code:string)=>void;onVerify:(event:FormEvent)=>void;onCancel:()=>void;onCopy:(value:string)=>void}) {
  const uri=safeOtpauthUri(enrollment.otpauthUri);
  const heading=usePanelHeadingFocus();
  return <section className="ui-settings-section ui-mfa" aria-labelledby="ui-mfa-setup-title">
    <h2 ref={heading} tabIndex={-1} id="ui-mfa-setup-title">{t('chat.settings.mfa.setupTitle')}</h2>
    <p>{t(enrollment.rotating?'chat.settings.mfa.rotationDescription':'chat.settings.mfa.setupDescription')}</p>
    <ol className="ui-mfa__steps">
      <li><strong>{t('chat.settings.mfa.addAccount')}</strong>{uri&&<p><a className="ui-mfa__open" href={uri}>{t('chat.settings.mfa.openApp')}<ExternalLink size={16} aria-hidden="true"/></a></p>}<p>{t('chat.settings.mfa.manualKey')}</p><div className="ui-mfa__secret"><code aria-label={t('chat.settings.mfa.manualKey')}>{groupedTotpSecret(enrollment.secret)}</code><button type="button" className="ui-button ui-secondary" onClick={()=>onCopy(enrollment.secret)}><Copy size={16} aria-hidden="true"/>{t('chat.settings.mfa.copyKey')}</button></div>{copyState==='key'&&<p className="ui-mfa__copy-status" role="status" aria-live="polite">{t('chat.settings.mfa.keyCopied')}</p>}{copyState==='failed'&&<p className="ui-mfa__feedback is-error" role="alert">{t('chat.message.copyFailed')}</p>}</li>
      <li><strong>{t('chat.settings.mfa.verifyAccount')}</strong><form className="ui-mfa__verify" onSubmit={onVerify}><label htmlFor="ui-mfa-setup-code">{t('chat.settings.mfa.codeLabel')}</label><input id="ui-mfa-setup-code" required inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" spellCheck={false} aria-describedby="ui-mfa-setup-help" value={code} onChange={event=>onCode(normalizeSetupTotpCode(event.target.value))}/><small id="ui-mfa-setup-help">{t('chat.settings.mfa.codeHelp')}</small>{error&&<><p className="ui-mfa__feedback is-error" role="alert">{t(`chat.settings.mfa.${error}`)}</p>{error==='recentRequired'&&<p><a className="ui-mfa__reauth" href="/login?returnTo=%2Fsettings">{t('chat.settings.mfa.recentAction')}</a></p>}</>}<p className="ui-mfa__expiry">{t('chat.settings.mfa.expires')}</p><div className="ui-settings-actions"><button type="button" className="ui-button ui-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button><button className="ui-button ui-primary" disabled={busy||code.length!==6}>{busy?t('auth.verifying'):t('auth.verify')}</button></div></form></li>
    </ol>
  </section>;
}

export function MfaRecoveryPanel({t,codes,acknowledged,copyState,onAcknowledge,onCopy,onDone}:{t:ChatTranslate;codes:readonly string[];acknowledged:boolean;copyState:CopyState;onAcknowledge:(checked:boolean)=>void;onCopy:()=>void;onDone:()=>void}) {
  const heading=usePanelHeadingFocus();
  return <section className="ui-settings-section ui-mfa ui-mfa__recovery" aria-labelledby="ui-mfa-recovery-title">
    <div className="ui-mfa__success-icon" aria-hidden="true"><Check size={22}/></div><h2 ref={heading} tabIndex={-1} id="ui-mfa-recovery-title">{t('chat.settings.mfa.recoveryTitle')}</h2>
    <p>{t('chat.settings.mfa.recoveryDescription')}</p><p className="ui-mfa__warning" role="note">{t('chat.settings.mfa.recoveryWarning')}</p>
    <ul className="ui-mfa__codes" aria-label={t('chat.settings.mfa.recoveryTitle')}>{codes.map(code=><li key={code}><code>{code}</code></li>)}</ul>
    <div className="ui-settings-actions"><button type="button" className="ui-button ui-secondary" onClick={onCopy}><Copy size={17} aria-hidden="true"/>{t('chat.settings.mfa.copyCodes')}</button></div>
    {copyState==='codes'&&<p className="ui-mfa__copy-status" role="status" aria-live="polite">{t('chat.settings.mfa.codesCopied')}</p>}{copyState==='failed'&&<p className="ui-mfa__feedback is-error" role="alert">{t('chat.message.copyFailed')}</p>}
    <label className="ui-check ui-mfa__ack"><input type="checkbox" checked={acknowledged} onChange={event=>onAcknowledge(event.target.checked)}/>{t('chat.settings.mfa.acknowledge')}</label>
    <button className="ui-primary" type="button" disabled={!acknowledged} onClick={onDone}>{t('chat.settings.mfa.done')}</button>
  </section>;
}
