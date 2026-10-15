import { readFile,stat } from 'node:fs/promises';
import { extname,resolve,sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES:Readonly<Record<string,string>>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8','.json':'application/json; charset=utf-8'};

export interface StaticSurfaceOptions { readonly appRoot:string; }

/** Serves the application shell for every host; API requests continue to the API router. */
export function staticSurfaces(options:StaticSurfaceOptions):MiddlewareHandler {
  const appRoot=resolve(options.appRoot);
  return async (c,next) => c.req.path.startsWith('/api/')?next():appResponse(appRoot,c.req.path);
}

async function appResponse(root:string,pathname:string):Promise<Response> {
  const path=decodePath(pathname);if(path===null)return new Response('Not Found',{status:404});
  const asset=path.slice(1);
  if(asset&&extname(asset)){const found=await fileResponse(root,asset,/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(`/${asset}`)?'public, max-age=31536000, immutable':'public, max-age=86400');if(found)return found;}
  if(path.startsWith('/assets/')||path.startsWith('/fonts/'))return new Response('Not Found',{status:404});
  return (await fileResponse(root,'index.html','no-cache'))??new Response('Not Found',{status:404});
}

async function fileResponse(root:string,relative:string,cache:string):Promise<Response|null> {
  const target=resolve(root,relative);if(target!==root&&!target.startsWith(`${root}${sep}`))return null;
  try {if(!(await stat(target)).isFile())return null;const data=await readFile(target);return new Response(data,{headers:{'Content-Type':TYPES[extname(target).toLowerCase()]??'application/octet-stream','Cache-Control':cache}});} catch{return null;}
}

function decodePath(value:string):string|null {try{return decodeURIComponent(value);}catch{return null;}}
