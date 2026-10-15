import { useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { apiFetch } from '../api.js';
import { LanguageSwitcher, useI18n } from '../i18n/index.js';
import './login.css';
import { useDeployment } from '../deployment.js';
import { returnPathFromLoginSearch } from './returnPath.js';
import { useDocumentTitle } from '../documentTitle.js';
import { mfaCodeForSubmission, normalizeMfaCode } from './mfaCode.js';
import { PRODUCT_NAME } from '@shared/brand.js';
import { Seal } from '../ui/Seal.js';
import { Field } from '../ui/Field.js';

type Phase='password'|'mfa';
interface LoginResponse { mfaRequired:boolean;mfaTicket?:string }
const safeReturnTo=():string=>returnPathFromLoginSearch(location.search,location.origin);

export function LoginPage({initialPhase='password'}:{initialPhase?:Phase}={}){
  const {t}=useI18n();
  const deployment=useDeployment(),brand=deployment.brandName?.trim()||PRODUCT_NAME;
  const [phase,setPhase]=useState<Phase>(initialPhase);
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[tenantSlug,setTenantSlug]=useState('');
  const [mfaTicket,setMfaTicket]=useState(''),[code,setCode]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const notice=new URLSearchParams(location.search).get('notice')==='password-set';
  const submissionCode=mfaCodeForSubmission(code);
  useDocumentTitle(phase==='mfa'?t('auth.mfaTitle'):t('auth.title'));
  const login=async(event:FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const result=await apiFetch<LoginResponse>('/api/v1/auth/login',{method:'POST',body:JSON.stringify({email:email.trim(),password,...(tenantSlug.trim()?{tenantSlug:tenantSlug.trim()}: {})})});
      if(result.mfaRequired&&result.mfaTicket){setMfaTicket(result.mfaTicket);setPhase('mfa');return}
      location.assign(safeReturnTo());
    }catch{setError(t('auth.invalid'))}finally{setBusy(false)}
  };
  const verify=async(event:FormEvent)=>{
    event.preventDefault();if(busy||!submissionCode)return;setBusy(true);setError('');
    try{await apiFetch('/api/v1/auth/login',{method:'POST',body:JSON.stringify({mfaTicket,code:submissionCode})});location.assign(safeReturnTo())}
    catch{setError(t('auth.invalidCode'))}finally{setBusy(false)}
  };
  return <main className="ui-login"><LanguageSwitcher className="ui-login__language"/><section className="ui-login__surface"><header className="ui-login__heading"><a href="/" className="ui-login__brand">{deployment.brandIconUrl?<img src={deployment.brandIconUrl} alt="" width="40" height="40"/>:<Seal size={40}/>}<span>{brand}</span></a><p>{phase==='password'?t('auth.intro'):t('auth.mfaIntro')}</p></header>
    <div className="ui-login__form"><h1>{phase==='mfa'?t('auth.mfaTitle'):t('auth.title')}</h1>
      {notice&&phase==='password'&&<div className="ui-login__success" role="status">{t('auth.recovery.passwordSaved')}</div>}
      {error&&<div className="ui-login__error" role="alert">{error}</div>}
      {phase==='password'&&<form onSubmit={event=>void login(event)}><label>{t('auth.email')}<input autoFocus required type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} placeholder="name@company.com"/></label><label>{t('auth.password')}<input required type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>{deployment.canEmail&&<a className="ui-login__forgot" href="/forgot-password">{t('auth.recovery.forgotLink')}</a>}<details><summary>{t('auth.workspaceOptional')}</summary><label>{t('auth.workspace')}<input value={tenantSlug} maxLength={80} autoComplete="organization" onChange={event=>setTenantSlug(event.target.value)}/></label></details><button className="ui-primary" disabled={!email.trim()||!password||busy}>{busy?t('auth.signingIn'):t('auth.signIn')}<ArrowRight size={17}/></button></form>}
      {phase==='mfa'&&<form onSubmit={event=>void verify(event)}><Field label={t('auth.code')} hint={<small className="ui-login__field-help">{t('auth.codeHelp')}</small>}>{field=><input id={field.id} aria-describedby={field.describedBy} autoFocus required autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={code} onChange={event=>setCode(normalizeMfaCode(event.target.value))}/>}</Field><button className="ui-primary" disabled={!submissionCode||busy}>{busy?t('auth.verifying'):t('auth.verify')}<ArrowRight size={17}/></button></form>}
    </div>
  </section></main>;
}
export default LoginPage;
