export interface FragmentLocation {hash:string;pathname:string;search:string}
export interface FragmentHistory {state:unknown;replaceState(data:unknown,unused:string,url?:string|URL|null):void}

let captured:{route:string;hash:string;token:string;stripped:boolean}|null=null;
const routeKey=(current:FragmentLocation)=>`${current.pathname}${current.search}`;

/** Capture during render without changing browser state. Module scope preserves it across remounts. */
export function readCredentialToken(current:FragmentLocation):string {
  if(current.hash){
    const route=routeKey(current);
    if(captured?.route!==route||captured.hash!==current.hash)captured={route,hash:current.hash,token:current.hash.startsWith('#')?current.hash.slice(1):'',stripped:false};
  }
  return captured?.route===routeKey(current)?captured.token:'';
}

/** Called from a layout effect so the secret leaves the address bar before paint. */
export function stripCredentialToken(current:FragmentLocation,navigation:FragmentHistory):void {
  if(!current.hash)return;
  const route=routeKey(current);
  if(captured?.route!==route||captured.hash!==current.hash)readCredentialToken(current);
  if(!captured||captured.route!==route||captured.stripped)return;
  captured.stripped=true;
  navigation.replaceState(navigation.state,'',route);
}

export type RecoveryFailure={kind:'dead'|'rate-limit'|'generic';rules:readonly string[]}|{kind:'policy';rules:readonly ('common_password'|'minimum_length'|'maximum_length')[]};
export function recoveryFailure(error:unknown):RecoveryFailure {
  if(!error||typeof error!=='object')return{kind:'generic',rules:[]};
  const candidate=error as {status?:unknown;body?:{error?:{code?:unknown;details?:unknown}}},status=candidate.status,api=candidate.body?.error;
  if(status===422&&api?.code==='CREDENTIAL_LINK_INVALID')return{kind:'dead',rules:[]};
  if(status===422&&api?.code==='PASSWORD_POLICY_FAILED'){
    const details=api.details&&typeof api.details==='object'&&!Array.isArray(api.details)?api.details as {rules?:unknown}:null;
    const allowed=new Set(['common_password','minimum_length','maximum_length']),rules=Array.isArray(details?.rules)?details.rules.filter((rule):rule is 'common_password'|'minimum_length'|'maximum_length'=>typeof rule==='string'&&allowed.has(rule)):[];
    return rules.length?{kind:'policy',rules}:{kind:'generic',rules:[]};
  }
  if(status===429||api?.code==='RATE_LIMITED')return{kind:'rate-limit',rules:[]};
  return{kind:'generic',rules:[]};
}
