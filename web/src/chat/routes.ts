import type { ChatView } from './types.js';

export type ChatRoute = Readonly<{view:ChatView;id:string|null}>;

function decoded(value:string):string|null{
  try{return decodeURIComponent(value)}catch{return null}
}

function normalized(pathname:string):string{
  return pathname.length>1?pathname.replace(/\/+$/,''):pathname;
}

/** Match only routes owned by the chat application shell. */
export function parseChatRoute(pathname:string):ChatRoute|null{
  const path=normalized(pathname);
  if(path==='/'||path==='/chat')return{view:'chat',id:null};
  if(path==='/projects')return{view:'projects',id:null};
  if(path==='/skills')return{view:'skills',id:null};
  if(path==='/settings'||path==='/settings/general')return{view:'settings',id:null};
  if(path==='/archived')return{view:'archived',id:null};
  if(path==='/search')return{view:'search',id:null};
  const match=/^\/(chat|projects)\/([^/]+)$/.exec(path);
  if(!match?.[1]||!match[2])return null;
  const id=decoded(match[2]);
  if(id===null)return null;
  return{view:match[1]==='chat'?'chat':'projects',id};
}
