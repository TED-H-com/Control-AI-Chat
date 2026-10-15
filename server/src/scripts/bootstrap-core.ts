import {randomBytes,randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import {provisionTenant} from '../lib/identity/tenant-provision.js';

export interface BootstrapInput {workspaceName:string;adminEmail:string;adminName:string;now?:number}
export type BootstrapResult={created:false;slug:string}|{created:true;slug:string;email:string;password:string};

export function requireBootstrapSecrets(environment:NodeJS.ProcessEnv):void {
  if(!environment.JWT_SECRET?.trim())throw new Error('JWT_SECRET is required');
  if(!environment.AUDIT_KEY?.trim())throw new Error('AUDIT_KEY is required');
}

export async function bootstrapTenant(database:Database.Database,input:BootstrapInput):Promise<BootstrapResult> {
  const existing=database.prepare<[],{slug:string}>('SELECT slug FROM tenants ORDER BY created_at,id LIMIT 1').get();
  if(existing)return{created:false,slug:existing.slug};
  const tenantId=randomUUID(),ownerUserId=randomUUID(),password=randomBytes(18).toString('base64url'),now=input.now??Date.now();
  const base=input.workspaceName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'').slice(0,40)||'workspace';
  const slug=`${base}-${tenantId.slice(0,8)}`;
  provisionTenant(database,{tenantId,ownerUserId,slug,tenantName:input.workspaceName,ownerEmail:input.adminEmail,ownerDisplayName:input.adminName,passwordHash:await bcrypt.hash(password,12),now});
  database.prepare('UPDATE users SET email_verified_at=?,updated_at=? WHERE tenant_id=? AND id=?').run(now,now,tenantId,ownerUserId);
  return{created:true,slug,email:input.adminEmail,password};
}
