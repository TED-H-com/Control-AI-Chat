import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {provisionTenant} from '../lib/identity/tenant-provision.js';

export function provisionTestTenant(database:Database.Database,input:{email:string;name:string;now:number;passwordHash?:string;configured?:boolean}) {
  const tenantId=randomUUID(),ownerUserId=randomUUID();
  const result=provisionTenant(database,{tenantId,ownerUserId,slug:`${input.name.toLowerCase().replace(/[^a-z0-9]+/gu,'-')}-${tenantId.slice(0,8)}`,
    tenantName:input.name,ownerEmail:input.email,ownerDisplayName:`${input.name} Owner`,passwordHash:input.passwordHash??'test-password-hash',now:input.now});
  if(input.configured!==false)database.prepare("UPDATE provider_config SET enabled=1,credential_source='encrypted',credential_ciphertext='test-fixture-envelope',key_version=1 WHERE tenant_id=?").run(tenantId);
  return result;
}
