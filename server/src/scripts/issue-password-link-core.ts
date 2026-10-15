import type Database from 'better-sqlite3';
import type {AuditService} from '../lib/audit/index.js';
import {ADMIN_RESET_LINK_TTL_MS,SETUP_LINK_TTL_MS,issueCredentialLinkInTransaction,type CredentialLinkPurpose} from '../lib/identity/credential-links.js';
import {normalizeEmail} from '../lib/identity/password.js';
import type {TenantId} from '../shared/types.js';

export interface OperatorLinkResult {purpose:CredentialLinkPurpose;url:string;expiresAt:string;userId:string;tenantId:TenantId}

export function issueOperatorPasswordLink(database:Database.Database,audit:Pick<AuditService,'transact'>,input:{workspaceSlug:string;email:string;appOrigin:string;now?:number}):OperatorLinkResult {
  const row=database.prepare<[string,string],{tenant_id:TenantId;tenant_status:string;user_id:string;user_status:string}>(`SELECT t.id tenant_id,t.status tenant_status,u.id user_id,u.status user_status
    FROM tenants t JOIN users u ON u.tenant_id=t.id WHERE t.slug=? AND u.email=? AND u.deleted_at IS NULL`).get(input.workspaceSlug.trim(),normalizeEmail(input.email));
  if(!row||row.tenant_status!=='active'||(row.user_status!=='active'&&row.user_status!=='invited'))throw new Error('No active or invited user matched that workspace and email');
  const now=input.now??Date.now(),purpose:CredentialLinkPurpose=row.user_status==='invited'?'setup':'reset',lifetimeMs=purpose==='setup'?SETUP_LINK_TTL_MS:ADMIN_RESET_LINK_TTL_MS;
  return audit.transact(tx=>{
    const link=issueCredentialLinkInTransaction(database,{tenantId:row.tenant_id,userId:row.user_id,purpose,issuedByUserId:null,issuedByService:'issue-password-link',lifetimeMs,appOrigin:input.appOrigin,now});
    tx.append({tenantId:row.tenant_id,action:'identity.credential_link_issued',actor:{type:'service',id:'issue-password-link',sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'user',id:row.user_id},outcome:'success',context:{requestId:`issue-password-link:${link.id}`,traceId:null,source:'cli',occurredAtMs:now},metadata:{purpose}});
    return{purpose,url:link.url,expiresAt:new Date(link.expiresAt).toISOString(),userId:row.user_id,tenantId:row.tenant_id};
  });
}
