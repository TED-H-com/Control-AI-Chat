import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { seedDefaultPolicy } from '../gate/default-policy.js';
import type { ProviderId } from '../providers/types.js';
import { DEFAULT_CATALOG_SEED } from '../providers/catalogSeed.js';
import { ROLES, ROLE_PERMISSIONS, TENANT_PERMISSIONS, toStorageKey } from '../../shared/permissions.js';

export class TenantProvisionConflictError extends Error {
  constructor(){super('Unable to create a workspace with these account details');}
}
export class TenantEmailConflictError extends TenantProvisionConflictError {
  readonly code='EMAIL_ALREADY_REGISTERED';
}

export interface ProvisionTenantInput {
  readonly tenantId:string;
  readonly ownerUserId:string;
  readonly slug:string;
  readonly tenantName:string;
  readonly ownerEmail:string;
  readonly ownerDisplayName:string;
  readonly passwordHash:string;
  readonly now:number;
}

export interface ProvisionedTenant {
  readonly tenantId:string;
  readonly ownerUserId:string;
  readonly allEmployeesGroupId:string;
  readonly modelIds:readonly string[];
  readonly providerConfigIds:Readonly<Record<ProviderId,string>>;
}

/**
 * Creates the minimum complete tenant.
 */
export function provisionTenant(database:Database.Database,input:ProvisionTenantInput):ProvisionedTenant {
  return database.transaction(()=>{
    const models=DEFAULT_CATALOG_SEED;
    const existingEmail=database.prepare<[string],{tenant_id:string}>(`SELECT tenant_id FROM users
      WHERE lower(email)=lower(?) AND deleted_at IS NULL LIMIT 1`).get(input.ownerEmail);
    if(existingEmail&&existingEmail.tenant_id!==input.tenantId)throw new TenantEmailConflictError();
    database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)")
      .run(input.tenantId,input.slug,input.tenantName,input.now,input.now);
    database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?,?)`)
      .run(input.ownerUserId,input.tenantId,input.ownerEmail,input.ownerDisplayName,input.passwordHash,input.now,input.now,input.now);
    database.prepare(`INSERT INTO tenant_settings(tenant_id,conversation_retention_days,audit_retention_days,retain_full_transcripts,
      requests_per_minute,concurrent_streams,max_upload_bytes,updated_at,updated_by_user_id)
      VALUES(?,90,365,1,120,3,26214400,?,?)`).run(input.tenantId,input.now,input.ownerUserId);

    for(const permission of TENANT_PERMISSIONS)database.prepare('INSERT OR IGNORE INTO permissions(key,description) VALUES(?,?)')
      .run(toStorageKey(permission),permission);
    const roleIds=new Map<string,string>();
    for(const role of ROLES){
      const roleId=randomUUID();roleIds.set(role,roleId);
      database.prepare('INSERT INTO roles(id,tenant_id,key,name,description,is_system,created_at) VALUES(?,?,?,?,?,1,?)')
        .run(roleId,input.tenantId,role,role[0]!.toUpperCase()+role.slice(1),'Default tenant role',input.now);
      for(const permission of ROLE_PERMISSIONS[role])database.prepare('INSERT INTO role_permissions(role_id,permission_key) VALUES(?,?)')
        .run(roleId,toStorageKey(permission));
    }
    database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)')
      .run(input.tenantId,input.ownerUserId,roleIds.get('owner')!,input.ownerUserId,input.now);

    const allEmployeesGroupId=randomUUID();
    database.prepare(`INSERT INTO groups(id,tenant_id,name,description,is_system,created_at,updated_at)
      VALUES(?,?,'All Employees','Default model and provider access for tenant members',1,?,?)`)
      .run(allEmployeesGroupId,input.tenantId,input.now,input.now);
    database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'system',?)")
      .run(input.tenantId,allEmployeesGroupId,input.ownerUserId,input.now);

    const providerConfigIds={} as Record<ProviderId,string>;
    for(const provider of [...new Set(models.map(model=>model.provider))]){
      const providerConfigId=randomUUID();providerConfigIds[provider]=providerConfigId;
      database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,config_json,created_at,updated_at)
        VALUES(?,?,?,0,'encrypted','{}',?,?)`).run(providerConfigId,input.tenantId,provider,input.now,input.now);
      database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)')
        .run(allEmployeesGroupId,providerConfigId);
    }

    const defaultModel=models.find(model=>model.provider==='openai'&&model.qualityTier===3)??models[0]!;
    const modelIds:string[]=[];
    for(const model of models){
      const modelId=randomUUID();modelIds.push(modelId);
      database.prepare(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,
        max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at,
        speed_class,quality_tier,multi_model_eligible,cached_input_microusd_per_million,vendor_jurisdiction,processing_region,preference_weight)
        VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(modelId,input.tenantId,model.provider,model.model,model.displayName,
          model===defaultModel?1:0,model.contextWindow,model.maxOutputTokens,model.inputMicrousdPerMillion,
          model.outputMicrousdPerMillion,JSON.stringify(model.capabilities),input.now,input.now,model.speedClass,model.qualityTier,
          model.multiModelEligible?1:0,model.cachedInputMicrousdPerMillion,model.vendorJurisdiction,model.processingRegion);
      database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)')
        .run(allEmployeesGroupId,modelId);
    }

    seedDefaultPolicy(database,{tenantId:input.tenantId,createdByUserId:input.ownerUserId,now:input.now});

    return{tenantId:input.tenantId,ownerUserId:input.ownerUserId,allEmployeesGroupId,modelIds,
      providerConfigIds:Object.freeze(providerConfigIds)};
  }).immediate();
}
