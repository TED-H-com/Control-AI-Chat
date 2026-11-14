import {useRef,useState} from 'react';
import {signOut} from './signOut.js';

export interface SignOutControl {busy:boolean;failed:boolean;submit:()=>Promise<boolean>}

export function useSignOut():SignOutControl {
  const flight=useRef(false);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  async function submit(){
    if(flight.current)return false;
    flight.current=true;setBusy(true);setFailed(false);
    const error=await signOut({location:window.location});
    // Stay disabled until the successful full navigation replaces the page.
    if(error){flight.current=false;setBusy(false);setFailed(true);}
    return error===null;
  }
  return{busy,failed,submit};
}
