import type { MiddlewareHandler } from 'hono';
import type { RequestPrincipal, TenantId } from '../../shared/types.js';
import type { AppVariables } from '../http/index.js';
import type { TenantDb } from '../db.js';
import { csrfProtection, type CsrfOptions } from './csrf.js';

export interface ApiAuthenticationOptions {
  readonly resolvePrincipal:(cookie:string|undefined)=>RequestPrincipal|null;
  readonly tenantDatabase:(tenantId:TenantId)=>TenantDb;
}

export function apiV1Authentication(options:ApiAuthenticationOptions):MiddlewareHandler<{Variables:AppVariables}> {
  return async(c,next)=>{
    if(c.req.header('Authorization'))
      return c.json({error:{code:'UNAUTHENTICATED',message:'Browser bearer authentication is not accepted',requestId:c.get('requestId'),retryable:false}},401);
    const principal=options.resolvePrincipal(c.req.header('Cookie'));
    if(principal){
      c.set('principal',principal);
      c.set('tenant',{principal,db:options.tenantDatabase(principal.tenantId),requestId:c.get('requestId'),now:new Date()});
    }
    await next();
  };
}

export function apiV1CsrfProtection(options:CsrfOptions):MiddlewareHandler<{Variables:AppVariables}> {
  return csrfProtection(options);
}
