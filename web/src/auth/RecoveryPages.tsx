import {useLayoutEffect,useState,type FormEvent} from 'react';
import {ArrowRight} from 'lucide-react';
import {apiFetch} from '../api.js';
import {LanguageSwitcher,useI18n} from '../i18n/index.js';
import {useDeployment} from '../deployment.js';
import {useDocumentTitle} from '../documentTitle.js';
import {PRODUCT_NAME} from '@shared/brand.js';
import {Seal} from '../ui/Seal.js';
import {Field} from '../ui/Field.js';
import './login.css';
import {readCredentialToken,recoveryFailure,stripCredentialToken,type RecoveryFailure} from './recovery-logic.js';

type RecoveryKind='setup'|'reset-password'|'forgot-password';
export function RecoveryPage({kind}:{kind:RecoveryKind}){
  const {t}=useI18n(),deployment=useDeployment(),brand=deployment.brandName?.trim()||PRODUCT_NAME;
  const [token]=useState(()=>kind==='forgot-password'?'':readCredentialToken(location));
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[email,setEmail]=useState(''),[tenantSlug,setTenantSlug]=useState('');
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState<RecoveryFailure|null>(null),[mismatch,setMismatch]=useState(false),[sent,setSent]=useState(false);
  const title=kind==='setup'?t('auth.recovery.setupTitle'):kind==='reset-password'?t('auth.recovery.resetTitle'):t('auth.recovery.forgotTitle');
  useDocumentTitle(title);
  useLayoutEffect(()=>{if(kind!=='forgot-password')stripCredentialToken(location,history)},[kind]);
  const submitPassword=async(event:FormEvent)=>{event.preventDefault();if(busy)return;if(password!==confirmation){setMismatch(true);setFailure(null);return}setBusy(true);setMismatch(false);setFailure(null);try{await apiFetch('/api/v1/auth/password/reset',{method:'POST',body:JSON.stringify({token,password})});location.assign('/login?notice=password-set')}catch(caught){setFailure(recoveryFailure(caught))}finally{setBusy(false)}};
  const forgot=async(event:FormEvent)=>{event.preventDefault();if(busy)return;setBusy(true);setFailure(null);try{await apiFetch('/api/v1/auth/password/forgot',{method:'POST',body:JSON.stringify({email:email.trim(),...(tenantSlug.trim()?{tenantSlug:tenantSlug.trim()}: {})})})}catch{/* The confirmation must not become an account-existence oracle. */}finally{setBusy(false);setSent(true)}};
  const back=<a className="ui-login__forgot" href="/login">{t('auth.recovery.backToLogin')}</a>;
  const nextStep=kind==='reset-password'?(deployment.canEmail?<a className="ui-login__forgot" href="/forgot-password">{t('auth.recovery.requestNewLink')}</a>:null):<p className="ui-login__next-step">{t('auth.recovery.askAdministrator')}</p>;
  const failureMessages=failure?.kind==='policy'?failure.rules.map(rule=>rule==='common_password'?t('auth.recovery.tooCommon'):rule==='minimum_length'?t('auth.recovery.tooShort'):t('auth.recovery.tooLong')):failure?[failure.kind==='dead'?t('auth.recovery.invalid'):failure.kind==='rate-limit'?t('auth.recovery.rateLimited'):t('auth.recovery.saveFailed')]:[];
  const unavailable=!token||failure?.kind==='dead';
  return <main className="ui-login"><LanguageSwitcher className="ui-login__language"/><section className="ui-login__surface"><header className="ui-login__heading"><a href="/login" className="ui-login__brand">{deployment.brandIconUrl?<img src={deployment.brandIconUrl} alt="" width="40" height="40"/>:<Seal size={40}/>}<span>{brand}</span></a><p>{kind==='forgot-password'?t('auth.recovery.forgotIntro'):t('auth.recovery.passwordIntro')}</p></header><div className="ui-login__form"><h1>{title}</h1>
    {sent?<div className="ui-login__confirmation" role="status"><p>{t('auth.recovery.forgotConfirmation')}</p>{back}</div>:kind==='forgot-password'?<><form onSubmit={event=>void forgot(event)}><label>{t('auth.email')}<input autoFocus required type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)}/></label><details><summary>{t('auth.workspaceOptional')}</summary><label>{t('auth.workspace')}<input value={tenantSlug} maxLength={80} autoComplete="organization" onChange={event=>setTenantSlug(event.target.value)}/></label></details><button className="ui-primary" disabled={!email.trim()||busy}>{busy?t('auth.recovery.sending'):t('auth.recovery.send')}<ArrowRight size={17}/></button></form>{back}</>:unavailable?<div className="ui-login__unavailable">{failureMessages.length?<div className="ui-login__error" role="alert">{failureMessages.map(message=><p key={message}>{message}</p>)}</div>:<p>{t('auth.recovery.missingToken')}</p>}{nextStep}{back}</div>:<>{(mismatch||failureMessages.length>0)&&<div className="ui-login__error" role="alert">{mismatch?<p>{t('auth.recovery.mismatch')}</p>:failureMessages.map(message=><p key={message}>{message}</p>)}</div>}<form onSubmit={event=>void submitPassword(event)}><Field label={t('auth.recovery.password')} hint={<small className="ui-login__field-help">{t('auth.recovery.policy')}</small>}>{field=><input id={field.id} aria-describedby={field.describedBy} autoFocus required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)}/>}</Field><label>{t('auth.recovery.confirmPassword')}<input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label><button className="ui-primary" disabled={password.length<12||confirmation.length<12||busy}>{busy?t('auth.recovery.saving'):t('auth.recovery.save')}<ArrowRight size={17}/></button></form>{back}</>}
  </div></section></main>;
}
export default RecoveryPage;
