import { Component, type ErrorInfo, type ReactNode } from 'react';
import { localeStorageKey, matchLocale } from './i18n/detection.js';
import { isLocale, type Locale } from './i18n/types.js';
import { PRODUCT_NAME } from '@shared/brand.js';
import { Seal } from './ui/Seal.js';

interface RecoveryCopy {title:string;body:string;reload:string}
const COPY:Readonly<Record<Locale,RecoveryCopy>>={
  en:{title:'This view ran into a problem',body:`${PRODUCT_NAME} could not display this view. Reload the app and try again.`,reload:'Reload app'},
  'zh-TW':{title:'這個畫面發生問題',body:`${PRODUCT_NAME} 無法顯示此畫面。請重新載入後再試一次。`,reload:'重新載入'},
  ja:{title:'この画面で問題が発生しました',body:`${PRODUCT_NAME} でこの画面を表示できませんでした。再読み込みしてもう一度お試しください。`,reload:'再読み込み'},
};

export const appRecoveryCopy=(locale:Locale):RecoveryCopy=>COPY[locale];

export function recoveryLocale():Locale {
  const candidates:string[]=[];
  if(typeof document!=='undefined'&&document.documentElement.lang)candidates.push(document.documentElement.lang);
  try {
    if(typeof localStorage!=='undefined'){
      const stored=localStorage.getItem(localeStorageKey);
      if(isLocale(stored))candidates.push(stored);
    }
  } catch { /* Device storage is optional, including on the recovery path. */ }
  if(typeof navigator!=='undefined')candidates.push(...(navigator.languages?.length?navigator.languages:[navigator.language]));
  return matchLocale(candidates);
}

export function AppFailurePanel({locale=recoveryLocale(),onReload}:{locale?:Locale;onReload?:()=>void}) {
  const copy=appRecoveryCopy(locale);
  const reload=onReload??(()=>location.reload());
  return <main className="ui-app-failure" role="alert">
    <section className="ui-app-failure__panel">
      <Seal size={40}/>
      <p>{PRODUCT_NAME}</p>
      <h1>{copy.title}</h1>
      <span>{copy.body}</span>
      <button type="button" onClick={reload}>{copy.reload}</button>
    </section>
  </main>;
}

interface BoundaryProps {children:ReactNode}
interface BoundaryState {failed:boolean}

export class AppErrorBoundary extends Component<BoundaryProps,BoundaryState> {
  state:BoundaryState={failed:false};
  static getDerivedStateFromError():BoundaryState{return {failed:true}}
  componentDidCatch(error:Error,info:ErrorInfo):void {
    console.error('Unexpected application render failure',error,info.componentStack);
  }
  render():ReactNode{return this.state.failed?<AppFailurePanel/>:this.props.children}
}
