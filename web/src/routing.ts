import { parseChatRoute } from './chat/routes.js';

export type AppRoute =
  | Readonly<{kind:'login'}>
  | Readonly<{kind:'setup'}>
  | Readonly<{kind:'reset-password'}>
  | Readonly<{kind:'forgot-password'}>
  | Readonly<{kind:'admin'}>
  | Readonly<{kind:'chat'}>
  | Readonly<{kind:'not-found';area:'app'}>;

/** Resolve the top-level shell without mounting chat for an address it does not own. */
export function resolveAppRoute(pathname:string,_development=false):AppRoute{
  const path=pathname.length>1?pathname.replace(/\/+$/,''):pathname;
  if(path==='/login')return{kind:'login'};
  if(path==='/setup')return{kind:'setup'};
  if(path==='/reset-password')return{kind:'reset-password'};
  if(path==='/forgot-password')return{kind:'forgot-password'};
  if(path==='/admin'||path.startsWith('/admin/'))return{kind:'admin'};
  if(parseChatRoute(path))return{kind:'chat'};
  return{kind:'not-found',area:'app'};
}
