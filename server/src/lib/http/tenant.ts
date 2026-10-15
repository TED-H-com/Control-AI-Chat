import type { MiddlewareHandler } from 'hono';
import type { Permission, RequestPrincipal, Role, TenantId } from '../../shared/types.js';
import { forTenant, type TenantDb } from '../db.js';
import { apiError } from './errors.js';

export interface TenantContext {
  readonly principal: RequestPrincipal;
  readonly db: TenantDb;
  readonly requestId: string;
  readonly now: Date;
}
export type AppVariables = { requestId:string; verifiedClientIp:string; principal:RequestPrincipal; tenant:TenantContext };
export type AuthResolver = (authorization:string|undefined) => Promise<RequestPrincipal|null>|RequestPrincipal|null;

export function requireAuth(resolvePrincipal:AuthResolver): MiddlewareHandler<{Variables:AppVariables}> {
  return async (c,next) => {
    const principal = await resolvePrincipal(c.req.header('Authorization'));
    if (!principal) return apiError(c,401,'UNAUTHENTICATED','Authentication required');
    const requestId = c.get('requestId') || crypto.randomUUID();
    c.set('principal',principal);
    c.set('tenant',{principal,db:forTenant({tenantId:principal.tenantId}),requestId,now:new Date()});
    await next();
  };
}
export function requireRole(...roles:readonly Role[]): MiddlewareHandler<{Variables:AppVariables}> {
  return async (c,next) => {
    const principal = c.get('principal');
    if (!principal || !roles.some(role => principal.roles.includes(role))) {
      return apiError(c,403,'FORBIDDEN','Insufficient role');
    }
    await next();
  };
}
export function requirePermission(permission:Permission): MiddlewareHandler<{Variables:AppVariables}> {
  return async (c,next) => {
    if (!c.get('principal')?.permissions.has(permission)) return apiError(c,403,'FORBIDDEN','Insufficient permission');
    await next();
  };
}
export function asTenantId(value:string): TenantId { return value as TenantId; }
