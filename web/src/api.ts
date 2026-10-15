import type { ApiError, StreamEvent } from '@shared/types';
import { redirectToLogin } from './auth/returnPath.js';

let accessToken:string|null = null;
export function setAccessToken(token:string|null): void { accessToken=token; }
export class ApiClientError extends Error {
  constructor(readonly status:number,readonly body:ApiError) { super(body.error.message); }
}

let refreshFlight:Promise<boolean>|null = null;
let refreshRevision = 0;
let lastRefreshSucceeded = false;

function pathname(path:string): string|null {
  try {
    const base = typeof location === 'undefined' ? 'http://localhost' : location.origin;
    const target = new URL(path, base);
    if (target.origin !== base) return null;
    return target.pathname;
  } catch { return null; }
}

function mayRefreshSession(path:string): boolean {
  const target = pathname(path);
  if (!target) return false;
  // These routes establish or inspect auth state. Retrying them through refresh either recurses or
  // turns an expected signed-out response into an unrelated refresh-token failure.
  return target !== '/api/v1/auth/me'
    && !target.startsWith('/api/v1/auth/login')
    && !target.startsWith('/api/v1/auth/refresh')
    && !target.startsWith('/api/v1/auth/password/forgot')
    && !target.startsWith('/api/v1/auth/password/reset');
}

async function isSessionAuthenticationFailure(response:Response):Promise<boolean> {
  if(response.status!==401)return false;
  try {
    const body=await response.clone().json() as {error?:{code?:unknown}};
    return body.error?.code==='SESSION_EXPIRED'||body.error?.code==='UNAUTHENTICATED';
  } catch { return false; }
}

async function refreshSession(): Promise<boolean> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method:'POST',
        credentials:'include',
        headers:{
          Accept:'application/json',
          'Content-Type':'application/json',
          'Idempotency-Key':crypto.randomUUID(),
        },
        body:'{}',
      });
      return response.ok;
    } catch { return false; }
  })().then(succeeded => {
    refreshRevision += 1;
    lastRefreshSucceeded = succeeded;
    return succeeded;
  }).finally(() => { refreshFlight = null; });
  return refreshFlight;
}

/** Fetches a cookie-authenticated request and retries it once after a shared session refresh. */
export async function fetchWithSessionRefresh(path:string,init:RequestInit={}): Promise<Response> {
  const prepared:RequestInit = {...init,headers:new Headers(init.headers),credentials:'include'};
  const observedRevision = refreshRevision;
  const response = await fetch(path,prepared);
  if (!mayRefreshSession(path) || !await isSessionAuthenticationFailure(response)) return response;

  // A sibling request may have completed the shared refresh before this request's 401 arrived.
  const refreshed = observedRevision === refreshRevision ? await refreshSession() : lastRefreshSucceeded;
  const finalResponse=refreshed?await fetch(path,{...prepared,headers:new Headers(prepared.headers)}):response;
  // The refresh endpoint has already been tried (and shared with sibling requests) by this point.
  // A remaining 401 is an expired login, not a recoverable view error.
  if(await isSessionAuthenticationFailure(finalResponse))redirectToLogin();
  return finalResponse;
}

export async function apiFetch<T>(path:string,init:RequestInit={}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept','application/json');
  // Not for FormData. `fetch` derives `multipart/form-data; boundary=…` from the body itself, and a
  // Content-Type set here overwrites it without the boundary — the server then reads a body it cannot
  // split into parts. This is why the paperclip failed on every upload. The same holds for Blob and
  // URLSearchParams, which also carry their own type.
  const derivesOwnType = init.body instanceof FormData || init.body instanceof Blob || init.body instanceof URLSearchParams;
  if (init.body && !derivesOwnType && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  if (accessToken) headers.set('Authorization',`Bearer ${accessToken}`);
  const response = await fetchWithSessionRefresh(path,{...init,headers});
  if (!response.ok) throw new ApiClientError(response.status,await response.json() as ApiError);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export interface SseMessage { id:number; event:StreamEvent }
export async function* streamChat(path:string,body:unknown,signal?:AbortSignal): AsyncGenerator<SseMessage> {
  const headers = new Headers({'Accept':'text/event-stream','Content-Type':'application/json'});
  if (accessToken) headers.set('Authorization',`Bearer ${accessToken}`);
  const response = await fetchWithSessionRefresh(path,{method:'POST',headers,body:JSON.stringify(body),signal});
  if (!response.ok) throw new ApiClientError(response.status,await response.json() as ApiError);
  if (!response.body) throw new Error('Streaming response has no body');
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer='';
  try {
    while (true) {
      const {done,value}=await reader.read(); if (done) break; buffer+=value;
      let boundary:number;
      while ((boundary=buffer.indexOf('\n\n')) >= 0) {
        const frame=buffer.slice(0,boundary).replace(/\r/g,''); buffer=buffer.slice(boundary+2);
        if (!frame || frame.startsWith(':')) continue;
        const lines=frame.split('\n'); const id=Number(lines.find(x=>x.startsWith('id:'))?.slice(3).trim());
        const eventName=lines.find(x=>x.startsWith('event:'))?.slice(6).trim();
        const data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
        if (!Number.isInteger(id) || !eventName || !data) continue;
        yield {id,event:{event:eventName,data:JSON.parse(data)} as StreamEvent};
      }
    }
  } finally { reader.releaseLock(); }
}
