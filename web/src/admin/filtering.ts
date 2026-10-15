import type {ScreenDefinition} from './catalog.js';

export const ADMIN_TEXT_FILTER_DEBOUNCE_MS=300;
export const FILTER_NAVIGATION_OPTIONS={replace:true} as const;

export interface AdminQueryNavigationOptions {replace?:boolean}
export type AdminQueryNavigate=(params:URLSearchParams,options?:AdminQueryNavigationOptions)=>void;

interface TimerControls {
  set:(callback:()=>void,delay:number)=>unknown;
  clear:(handle:unknown)=>void;
}
export interface DebouncedCommit<T> {
  schedule:(value:T)=>void;
  immediate:(value:T)=>void;
  cancel:()=>void;
}

const SYSTEM_TIMERS:TimerControls={
  set:(callback,delay)=>globalThis.setTimeout(callback,delay),
  clear:handle=>globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDebouncedCommit<T>(commit:(value:T)=>void,delay=ADMIN_TEXT_FILTER_DEBOUNCE_MS,timers:TimerControls=SYSTEM_TIMERS):DebouncedCommit<T> {
  let timer:unknown=null;
  const cancel=()=>{if(timer!==null){timers.clear(timer);timer=null;}};
  const schedule=(value:T)=>{
    cancel();
    timer=timers.set(()=>{timer=null;commit(value);},delay);
  };
  const immediate=(value:T)=>{cancel();commit(value);};
  return {schedule,immediate,cancel};
}

export const isDebouncedTextFilter=(filter:ScreenDefinition['filters'][number]):boolean=>!filter.options&&!filter.key.toLowerCase().includes('date');
const textFilters=(screen:ScreenDefinition)=>screen.filters.filter(isDebouncedTextFilter);
export function textFilterDrafts(screen:ScreenDefinition,params:URLSearchParams):Record<string,string> {
  return Object.fromEntries(textFilters(screen).map(filter=>[filter.key,params.get(filter.key)??'']));
}
export function textFilterDraftSignature(screen:ScreenDefinition,drafts:Readonly<Record<string,string>>):string {
  return JSON.stringify(textFilters(screen).map(filter=>[filter.key,drafts[filter.key]??'']));
}
export function paramsWithTextFilterDrafts(screen:ScreenDefinition,params:URLSearchParams,drafts:Readonly<Record<string,string>>):URLSearchParams {
  const next=new URLSearchParams(params);
  for(const filter of textFilters(screen)){
    const value=drafts[filter.key]??'';
    if(value)next.set(filter.key,value);else next.delete(filter.key);
  }
  return next;
}

export function adminQueryUrl(path:string,params:URLSearchParams):string {
  return `${path}${params.size?`?${params}`:''}`;
}
export function writeAdminHistory(target:Pick<History,'pushState'|'replaceState'>,path:string,params:URLSearchParams,options?:AdminQueryNavigationOptions):void {
  const url=adminQueryUrl(path,params);
  if(options?.replace)target.replaceState({},'',url);else target.pushState({},'',url);
}
