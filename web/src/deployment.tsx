import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface SupportContact {vendorName:string|null;email:string|null;phone:string|null;url:string|null;notes:string|null}
export interface DeploymentIdentity {brandName:string|null;brandIconUrl:string|null;canEmail:boolean;support:SupportContact|null}
const fallback:DeploymentIdentity={brandName:null,brandIconUrl:null,canEmail:false,support:null};
const Context=createContext(fallback);
export const useDeployment=()=>useContext(Context);
export function DeploymentProvider({children,authenticated=false}:{children:ReactNode;authenticated?:boolean}){
  const [value,setValue]=useState(fallback);
  useEffect(()=>{const controller=new AbortController();
    // The brand is public because the sign-in screen renders it. Who maintains the installation is
    // not: it comes from an authenticated route, and a signed-out visitor simply gets nothing.
    void fetch('/api/v1/deployment',{headers:{Accept:'application/json'},signal:controller.signal})
      .then(async response=>response.ok?await response.json() as Omit<DeploymentIdentity,'support'>:fallback)
      .then(brand=>setValue(current=>({...current,...brand}))).catch(()=>{});
    if(authenticated)void fetch('/api/v1/deployment/support',{headers:{Accept:'application/json'},signal:controller.signal})
      .then(async response=>response.ok?(await response.json() as {support:SupportContact|null}).support:null)
      .then(support=>setValue(current=>({...current,support}))).catch(()=>{});
    return()=>controller.abort()},[authenticated]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
