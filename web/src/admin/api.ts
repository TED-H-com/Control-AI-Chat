import { apiFetch } from '../api.js';
import { createStableWrite, type MutationSender, type MutationWrite } from '../mutation-write.js';
import type { AdminCapabilities, AdminPage, AdminRecord } from './types.js';

// The server mounts one route tree, at /api/v1 (server/src/index.ts); there is no /api/admin prefix,
// so every caller passes the absolute v1 path of a route that exists in server/src/routes/catalog.ts.
export const BASE='/api/v1';
export function adminGet<T>(path:string, query?:URLSearchParams):Promise<T> { return apiFetch<T>(`${BASE}${path}${query?.size ? `?${query}` : ''}`); }
export function createMutationKey(factory:()=>string=()=>crypto.randomUUID()):{current:()=>string;rotate:()=>string} {
  let value=factory();
  return {current:()=>value,rotate:()=>{value=factory();return value}};
}
export function adminMutate<T>(path:string, method:'POST'|'PATCH'|'PUT'|'DELETE', body?:unknown, version?:number, idempotencyKey:string=crypto.randomUUID()):Promise<T> {
  const headers:Record<string,string>={'Idempotency-Key':idempotencyKey};
  if (version !== undefined) headers['If-Match']=`"${version}"`;
  return apiFetch<T>(`${BASE}${path}`,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)});
}
export type AdminWrite=MutationWrite;
export function createAdminWrite(send:MutationSender=adminMutate,factory:()=>string=()=>crypto.randomUUID()):AdminWrite {return createStableWrite(send,factory);}
export const getCapabilities=():Promise<AdminCapabilities> => adminGet('/admin/me/capabilities');
export function getRecords(path:string, query:URLSearchParams):Promise<AdminPage<AdminRecord>> { return adminGet(path,query); }
