import {apiFetch,ApiClientError} from '../api.js';
import type {NavigableLocation} from './returnPath.js';

type SignOutRequest=(path:string,init:RequestInit)=>Promise<unknown>;

/** A full navigation drops every authenticated value held in memory. */
export async function signOut({request=apiFetch,location}:{request?:SignOutRequest;location:Pick<NavigableLocation,'assign'>}):Promise<Error|null> {
  try {
    await request('/api/v1/auth/logout',{method:'POST',body:'{}'});
  } catch(error) {
    if(!(error instanceof ApiClientError&&error.status===401))return error instanceof Error?error:new Error('Sign out failed');
  }
  location.assign('/login');
  return null;
}
