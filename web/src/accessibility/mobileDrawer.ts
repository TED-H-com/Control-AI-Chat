import { useEffect, useRef, useState, type RefObject } from 'react';

const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface MobileDrawerOptions {
  readonly open:boolean;
  readonly onClose:()=>void;
  readonly mediaQuery:string;
  readonly drawerRef:RefObject<HTMLElement>;
  readonly triggerRef:RefObject<HTMLElement>;
  readonly backgroundRef:RefObject<HTMLElement>;
}

const matches=(query:string):boolean=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia(query).matches;

/** Gives a CSS-off-canvas navigation the keyboard and background isolation of a modal drawer. */
export function useMobileDrawer({open,onClose,mediaQuery,drawerRef,triggerRef,backgroundRef}:MobileDrawerOptions):boolean {
  const close=useRef(onClose);close.current=onClose;
  const [mobile,setMobile]=useState(()=>matches(mediaQuery));
  useEffect(()=>{
    const query=window.matchMedia(mediaQuery),update=()=>setMobile(query.matches);
    update();query.addEventListener('change',update);
    return()=>query.removeEventListener('change',update);
  },[mediaQuery]);
  const active=open&&mobile;
  useEffect(()=>{if(open&&!mobile)close.current()},[mobile,open]);

  useEffect(()=>{
    const drawer=drawerRef.current,background=backgroundRef.current;
    if(!active||!drawer)return;
    const trigger=triggerRef.current;
    const priorInert=background?.inert??false,priorHidden=background?.getAttribute('aria-hidden')??null,priorOverflow=document.body.style.overflow;
    if(background){background.inert=true;background.setAttribute('aria-hidden','true')}
    document.body.style.overflow='hidden';
    const focusable=()=>[...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item=>!item.closest('[inert]'));
    const frame=requestAnimationFrame(()=>{const first=focusable()[0];(first??drawer).focus()});
    const keydown=(event:KeyboardEvent)=>{
      const activeModal=(document.activeElement as Element|null)?.closest('[role="dialog"][aria-modal="true"]');
      if(activeModal&&activeModal!==drawer)return;
      if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation();close.current();return;
      }
      if(event.key!=='Tab')return;
      const items=focusable();
      if(items.length===0){event.preventDefault();drawer.focus();return}
      const first=items[0]!,last=items[items.length-1]!,focused=document.activeElement;
      if(event.shiftKey&&(focused===first||focused===drawer||!drawer.contains(focused))){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&(focused===last||!drawer.contains(focused))){event.preventDefault();first.focus()}
    };
    document.addEventListener('keydown',keydown);
    return()=>{
      cancelAnimationFrame(frame);document.removeEventListener('keydown',keydown);
      document.body.style.overflow=priorOverflow;
      if(background){background.inert=priorInert;if(priorHidden===null)background.removeAttribute('aria-hidden');else background.setAttribute('aria-hidden',priorHidden)}
      requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus()});
    };
  },[active,backgroundRef,drawerRef,triggerRef]);

  return active;
}
