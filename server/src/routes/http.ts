import { Hono } from 'hono';
import { apiError } from '../lib/http/index.js';
import type { RouteDefinition, RouteEnv, RouteRequest, RouteResult, RouteServices } from './types.js';

function requestId(c: {get(name:'requestId'):string}): string { return c.get('requestId') || crypto.randomUUID(); }

async function readRequest(c: import('./types.js').RouteContext, def:RouteDefinition): Promise<RouteRequest> {
  let body:unknown = undefined;
  let rawBody:Uint8Array|null = null;
  if (def.body === 'json') {
    try { body = await c.req.json<unknown>(); } catch { throw new SyntaxError('Invalid JSON'); }
  } else if (def.body === 'multipart') body = await c.req.parseBody({all:true});
  else if (def.body === 'raw') rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers=new Headers(c.req.raw.headers);
  // Proxy authentication belongs only at the socket boundary. Never let its shared secret drift
  // into adapters, audit metadata, provider requests, or an accidental diagnostic dump.
  headers.delete('X-Gateway-Proxy-Secret');headers.delete('X-Gateway-Proxy-Client-IP');
  headers.set('X-Gateway-Client-IP',c.get('verifiedClientIp')||'unknown');
  return {url:c.req.url,tenant:def.access === 'tenant' ? c.get('tenant') : null, requestId:requestId(c),
    params:c.req.param(), query:c.req.query(), headers, body, rawBody};
}

function response(c:import('./types.js').RouteContext, result:RouteResult, fallback:number):Response {
  const headers = new Headers();for(const [name,value] of Object.entries(result.headers??{})){if(name.toLowerCase()==='set-cookie')for(const item of value.split(/, (?=__Host-)/))headers.append(name,item);else headers.set(name,value)}
  headers.set('X-API-Version','1'); headers.set('X-Request-Id',requestId(c));
  const status=result.status ?? fallback;
  if (status === 204 || result.body === undefined) return new Response(null,{status,headers});
  if (result.body instanceof Uint8Array || typeof result.body === 'string') return new Response(result.body,{status,headers});
  headers.set('Content-Type','application/json; charset=utf-8');
  return new Response(JSON.stringify(result.body),{status,headers});
}

export function mountDefinitions(app:Hono<RouteEnv>, services:RouteServices, definitions:readonly RouteDefinition[]):void {
  for (const def of definitions) {
    app.on(def.method,def.path,async c => {
      if (def.access === 'tenant') {
        const tenant=c.get('tenant');
        if (!tenant) return apiError(c,401,'UNAUTHENTICATED','Authentication required');
        if (def.permission && !tenant.principal.permissions.has(def.permission)) return apiError(c,403,'FORBIDDEN','Insufficient permission');
      }
      if (def.ifMatch && !c.req.header('If-Match')) return apiError(c,428,'PRECONDITION_REQUIRED','If-Match is required');
      if (def.idempotency && !c.req.header('Idempotency-Key')) return apiError(c,400,'INVALID_REQUEST','Idempotency-Key is required');
      try { return response(c,await services.execute(def.operation,await readRequest(c,def)),def.success ?? 200); }
      catch (error) {
        if (error instanceof SyntaxError) return apiError(c,400,'INVALID_REQUEST','Request body is not valid JSON');
        throw error;
      }
    });
  }
}

export function unavailableServices():RouteServices {
  return {execute(operation):Promise<RouteResult> { throw new Error(`NotImplemented: route service ${operation} is not configured`); }};
}
