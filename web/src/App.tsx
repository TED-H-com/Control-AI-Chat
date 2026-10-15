import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { AppearanceProvider } from './appearance/AppearanceProvider.js';
import { I18nProvider, useI18n, type LocaleAccountAdapter } from './i18n/index.js';
import { DeploymentProvider } from './deployment.js';
import { NotFoundPage } from './NotFoundPage.js';
import { resolveAppRoute } from './routing.js';

const ChatApp = lazy(() => import('./chat/index.js').then(module => ({ default: module.ChatApp })));
const AdminConsole = lazy(() => import('./admin/index.js').then(module => ({ default: module.AdminConsole })));
const LoginPage = lazy(() => import('./auth/LoginPage.js').then(module => ({ default: module.LoginPage })));
const RecoveryPage = lazy(() => import('./auth/RecoveryPages.js').then(module => ({ default: module.RecoveryPage })));

export function App() {
  const [path,setPath]=useState(()=>window.location.pathname);
  const route=resolveAppRoute(path,import.meta.env.DEV);
  const admin = route.kind==='admin';
  useEffect(() => { document.documentElement.dataset.surface = admin ? 'admin' : 'chat'; }, [admin]);
  useEffect(()=>{const sync=()=>setPath(window.location.pathname);addEventListener('popstate',sync);return()=>removeEventListener('popstate',sync)},[]);
  const content=(child:ReactNode,authenticated=false)=><Suspense fallback={<LocalizedFallback/>}><AppearanceProvider authenticated={authenticated}>{child}</AppearanceProvider></Suspense>;
  const account:LocaleAccountAdapter=useMemoAccount;
  if (route.kind==='login') return <DeploymentProvider><I18nProvider>{content(<LoginPage />)}</I18nProvider></DeploymentProvider>;
  if (route.kind==='setup'||route.kind==='reset-password'||route.kind==='forgot-password') return <DeploymentProvider><I18nProvider>{content(<RecoveryPage kind={route.kind}/>)}</I18nProvider></DeploymentProvider>;
  if (route.kind==='admin') return <DeploymentProvider authenticated><I18nProvider account={account}>{content(<AdminConsole />,true)}</I18nProvider></DeploymentProvider>;
  if (route.kind==='chat') return <DeploymentProvider authenticated><I18nProvider account={account}>{content(<ChatApp />,true)}</I18nProvider></DeploymentProvider>;
  return <DeploymentProvider><I18nProvider>{content(<NotFoundPage area="app"/>)}</I18nProvider></DeploymentProvider>;
}

function LocalizedFallback(){const {t}=useI18n();return <main aria-busy="true"><p>{t('common.loading')}</p></main>}

const useMemoAccount:LocaleAccountAdapter={
  async load(){const response=await fetch('/api/v1/me/preferences',{credentials:'include',headers:{Accept:'application/json'}});if(!response.ok)return null;const body=await response.json() as {locale?:unknown};return body.locale==='en'||body.locale==='zh-TW'||body.locale==='ja'?body.locale:null},
  async save(locale){const response=await fetch('/api/v1/me/preferences',{method:'PATCH',credentials:'include',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({locale})});if(!response.ok)throw new Error('Locale preference update failed')},
};
