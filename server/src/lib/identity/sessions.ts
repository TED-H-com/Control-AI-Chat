import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TenantId } from '../../shared/types.js';
import { forTenant } from '../db.js';
import { digestToken, issueAccessToken, randomOpaqueToken, verifyAccessToken, type IssueAccessInput } from './tokens.js';
import { IdentityError, type AccessTokenClaims } from './types.js';

interface SessionRow {id:string;tenant_id:string;user_id:string;token_hash:string;jwt_id:string;auth_method:'password'|'mfa';expires_at:number;revoked_at:number|null}
const byRefresh = (db:Database.Database)=>db.prepare<[TenantId,string],SessionRow>('SELECT id,tenant_id,user_id,token_hash,jwt_id,auth_method,expires_at,revoked_at FROM sessions WHERE tenant_id = ? AND token_hash = ?');
const activeById = (db:Database.Database)=>db.prepare<[TenantId,string],SessionRow>('SELECT id,tenant_id,user_id,token_hash,jwt_id,auth_method,expires_at,revoked_at FROM sessions WHERE tenant_id = ? AND id = ?');
export interface CreatedSession {id:string;refreshToken:string;accessToken:string;accessExpiresAt:number}
/**
 * Refresh happens before the caller has a verifiable tenant: the access token has expired by
 * definition and the refresh cookie carries no tenant. `token_hash` is globally UNIQUE and holds 256
 * bits of entropy, so the token itself identifies the tenant — and everything downstream of this
 * lookup goes back through the tenant-scoped path. Returns null rather than throwing so the caller
 * decides what an unknown, revoked or expired token looks like from outside.
 */
export function findRefreshSession(db:Database.Database,refreshToken:string,now=Date.now()):{id:string;tenantId:TenantId;userId:string;authMethod:SessionRow['auth_method'];expiresAt:number}|null {
  const row=db.prepare<[string],SessionRow>('SELECT id,tenant_id,user_id,token_hash,jwt_id,auth_method,expires_at,revoked_at FROM sessions WHERE token_hash = ?').get(digestToken(refreshToken));
  return !row||row.revoked_at!==null||row.expires_at<=now?null:{id:row.id,tenantId:row.tenant_id as TenantId,userId:row.user_id,authMethod:row.auth_method,expiresAt:row.expires_at};
}
export function createSession(db:Database.Database,input:IssueAccessInput&{authMethod:'password'|'mfa';jwtSecret:string;ipHash?:string|null;userAgent?:string|null;absoluteTtlSeconds?:number;absoluteExpiresAt?:number}):CreatedSession {
  const now=input.now??Date.now(),id=randomUUID(),refreshToken=randomOpaqueToken(),jwtId=randomUUID(),expires=input.absoluteExpiresAt??now+(input.absoluteTtlSeconds??2_592_000)*1000;
  if(!Number.isSafeInteger(expires)||expires<=now)throw new IdentityError('SESSION_EXPIRED','Session expiry must be in the future');
  const accessNow=Math.floor(now/1000),maxAccessTtl=Math.floor(expires/1000)-accessNow;
  if(maxAccessTtl<1)throw new IdentityError('SESSION_EXPIRED','Session expires too soon');
  const access=issueAccessToken({...input,sessionId:id,now:accessNow,ttlSeconds:Math.min(input.ttlSeconds??600,maxAccessTtl)},input.jwtSecret);
  db.prepare('INSERT INTO sessions (id,tenant_id,user_id,token_hash,jwt_id,ip_hash,user_agent,auth_method,created_at,last_seen_at,expires_at,mfa_verified_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.tenantId,input.userId,digestToken(refreshToken),jwtId,input.ipHash??null,input.userAgent?.slice(0,512)??null,input.authMethod,now,now,expires,input.authMethod==='mfa'?now:null);
  return {id,refreshToken,accessToken:access.token,accessExpiresAt:access.claims.exp};
}
export function rotateRefresh(db:Database.Database,tenantId:TenantId,refreshToken:string,input:Omit<IssueAccessInput,'sessionId'|'tenantId'> & {jwtSecret:string}):CreatedSession {
  const tenantDb=forTenant({tenantId}),row=tenantDb.get(byRefresh(db),digestToken(refreshToken)),now=input.now??Date.now();
  if(!row||row.revoked_at!==null||row.expires_at<=now)throw new IdentityError('SESSION_EXPIRED','Refresh session expired');
  const accessNow=Math.floor(now/1000),maxAccessTtl=Math.floor(row.expires_at/1000)-accessNow;if(maxAccessTtl<1)throw new IdentityError('SESSION_EXPIRED','Refresh session expired');
  const next=randomOpaqueToken();const result=tenantDb.run(db.prepare<[TenantId,string,string,number,string]>('WITH tenant_scope(id) AS (VALUES (?)) UPDATE sessions SET token_hash = ?, last_seen_at = ?, jwt_id = ? WHERE tenant_id = (SELECT id FROM tenant_scope) AND id = ? AND revoked_at IS NULL') as Database.Statement<[TenantId,...unknown[]]>,digestToken(next),now,randomUUID(),row.id);
  if(result.changes!==1)throw new IdentityError('SESSION_EXPIRED','Refresh session expired');const access=issueAccessToken({...input,tenantId,sessionId:row.id,now:accessNow,ttlSeconds:Math.min(input.ttlSeconds??600,maxAccessTtl)},input.jwtSecret);return{id:row.id,refreshToken:next,accessToken:access.token,accessExpiresAt:access.claims.exp};
}
export function authorizeAccess(db:Database.Database,token:string,secret:string):AccessTokenClaims {const claims=verifyAccessToken(token,secret);const tenantId=claims.tid as TenantId;const row=forTenant({tenantId}).get(activeById(db),claims.sid);if(!row||row.user_id!==claims.sub||row.revoked_at!==null||row.expires_at<=Date.now())throw new IdentityError('SESSION_EXPIRED','Session revoked or expired');return claims;}
export function revokeSession(db:Database.Database,tenantId:TenantId,sessionId:string,reason:string,now=Date.now()):boolean {const stmt=db.prepare<[TenantId,number,string,string]>('WITH tenant_scope(id) AS (VALUES (?)) UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE tenant_id = (SELECT id FROM tenant_scope) AND id = ? AND revoked_at IS NULL') as Database.Statement<[TenantId,...unknown[]]>;return forTenant({tenantId}).run(stmt,now,reason,sessionId).changes===1;}
