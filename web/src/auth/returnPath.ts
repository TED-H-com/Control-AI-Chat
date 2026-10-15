const DEFAULT_RETURN_PATH='/chat';

export interface NavigableLocation {
  readonly origin:string;
  readonly pathname:string;
  readonly search:string;
  assign(url:string):void;
}

/** Normalizes a user-controlled return target to a same-origin path and query. */
export function safeReturnPath(requested:string|null|undefined,origin:string, fallback=DEFAULT_RETURN_PATH):string {
  if(!requested?.startsWith('/')||requested.startsWith('//'))return fallback;
  try {
    const expectedOrigin=new URL(origin).origin;
    const target=new URL(requested,`${expectedOrigin}/`);
    // URL treats some backslash-prefixed inputs as authority delimiters. Comparing the parsed
    // origin, rather than relying only on a string prefix, keeps those out too.
    if(target.origin!==expectedOrigin||target.pathname==='/login')return fallback;
    return `${target.pathname}${target.search}`;
  } catch { return fallback; }
}

export function returnPathFromLoginSearch(search:string,origin:string):string {
  return safeReturnPath(new URLSearchParams(search).get('returnTo'),origin);
}

export function loginRedirectPath(location:NavigableLocation):string {
  const returnTo=safeReturnPath(`${location.pathname}${location.search}`,location.origin);
  return `/login?${new URLSearchParams({returnTo}).toString()}`;
}

// A chat bootstrap fans out several requests. They can all discover the same expired session at
// once, so remember the navigation per Location object and issue only one redirect.
const redirects=new WeakMap<object,string>();

export function redirectToLogin(locationOverride?:NavigableLocation):string|null {
  const active=locationOverride??(typeof location==='undefined'?null:location as NavigableLocation);
  if(!active)return null;
  const target=loginRedirectPath(active);
  if(redirects.get(active as object)===target)return target;
  redirects.set(active as object,target);
  active.assign(target);
  return target;
}
