import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {TenantId} from '../../shared/types.js';

export type CredentialLinkPurpose='setup'|'reset';
export const SETUP_LINK_TTL_MS=7*24*60*60_000;
export const ADMIN_RESET_LINK_TTL_MS=24*60*60_000;
export const SELF_SERVICE_RESET_LINK_TTL_MS=60*60_000;
const TOKEN=/^[A-Za-z0-9_-]{43}$/u;

export interface IssuedCredentialLink {id:string;tenantId:TenantId;userId:string;purpose:CredentialLinkPurpose;token:string;url:string;expiresAt:number}
export interface CredentialLinkRow {id:string;tenant_id:TenantId;user_id:string;purpose:CredentialLinkPurpose;token_sha256:string;expires_at:number;user_status:string;tenant_status:string;deleted_at:number|null}

export function credentialTokenShape(token:unknown):token is string {
  if(typeof token!=='string'||!TOKEN.test(token))return false;
  try{return Buffer.from(token,'base64url').byteLength===32&&Buffer.from(token,'base64url').toString('base64url')===token}catch{return false}
}
export const credentialTokenDigest=(token:string):string=>createHash('sha256').update(token,'utf8').digest('hex');

/** Call inside the caller's transaction so superseding and insertion share its audit boundary. */
export function issueCredentialLinkInTransaction(database:Database.Database,input:{tenantId:TenantId;userId:string;purpose:CredentialLinkPurpose;issuedByUserId:string|null;issuedByService?:string|null;lifetimeMs:number;appOrigin:string;now:number}):IssuedCredentialLink {
  const token=randomBytes(32).toString('base64url'),digest=credentialTokenDigest(token),id=randomUUID(),expiresAt=input.now+input.lifetimeMs;
  database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE credential_links SET superseded_at=?
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND user_id=? AND purpose=? AND consumed_at IS NULL AND superseded_at IS NULL`)
    .run(input.tenantId,input.now,input.userId,input.purpose);
  database.prepare(`INSERT INTO credential_links(tenant_id,id,user_id,purpose,token_sha256,issued_by_user_id,issued_by_service,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(input.tenantId,id,input.userId,input.purpose,digest,input.issuedByUserId,input.issuedByService??null,input.now,expiresAt);
  const path=input.purpose==='setup'?'setup':'reset-password';
  return{id,tenantId:input.tenantId,userId:input.userId,purpose:input.purpose,token,url:`${input.appOrigin.replace(/\/$/u,'')}/${path}#${token}`,expiresAt};
}

/** Shape validation is intentionally separate so malformed input performs no database lookup. */
export function findUsableCredentialLink(database:Database.Database,token:string,now:number):CredentialLinkRow|null {
  const row=database.prepare<[string],CredentialLinkRow>(`SELECT l.id,l.tenant_id,l.user_id,l.purpose,l.token_sha256,l.expires_at,
      u.status user_status,u.deleted_at,t.status tenant_status
    FROM credential_links l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.user_id JOIN tenants t ON t.id=l.tenant_id
    WHERE l.token_sha256=? AND l.consumed_at IS NULL AND l.superseded_at IS NULL`).get(credentialTokenDigest(token));
  if(!row||row.expires_at<=now||row.deleted_at!==null||row.tenant_status!=='active')return null;
  if(row.purpose==='setup'?row.user_status!=='invited':row.user_status!=='active')return null;
  return row;
}

export function consumeCredentialLinkInTransaction(database:Database.Database,row:CredentialLinkRow,passwordHash:string,now:number):{sessionsRevoked:number}|null {
  const expectedStatus=row.purpose==='setup'?'invited':'active';
  const consumed=database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE credential_links SET consumed_at=?
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND token_sha256=? AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM tenants WHERE id=(SELECT id FROM tenant_scope) AND status='active')
      AND EXISTS(SELECT 1 FROM users WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status=? AND deleted_at IS NULL)`)
    .run(row.tenant_id,now,row.id,row.token_sha256,now,row.user_id,expectedStatus);
  if(consumed.changes!==1)return null;
  if(row.purpose==='setup'){
    const changed=database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET password_hash=?,status='active',email_verified_at=?,failed_login_count=0,locked_until=NULL,updated_at=?
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='invited' AND deleted_at IS NULL`).run(row.tenant_id,passwordHash,now,now,row.user_id);
    if(changed.changes!==1)throw new Error('credential_link_state_changed');
    return{sessionsRevoked:0};
  }
  const changed=database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE users SET password_hash=?,failed_login_count=0,locked_until=NULL,updated_at=?
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='active' AND deleted_at IS NULL`).run(row.tenant_id,passwordHash,now,row.user_id);
  if(changed.changes!==1)throw new Error('credential_link_state_changed');
  const sessions=database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE sessions SET revoked_at=?,revoke_reason='password_reset'
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND user_id=? AND revoked_at IS NULL`).run(row.tenant_id,now,row.user_id);
  return{sessionsRevoked:sessions.changes};
}
