import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GovernanceError } from './errors.js';
import type { EffectiveModel, ProviderId, ResolveModelsInput, ResolveModelsResult } from './types.js';

interface Row { id:string;provider_key:string;model_key:string;display_name:string;context_window:number;max_output_tokens:number;input_microusd_per_million:number;output_microusd_per_million:number;capabilities_json:string;is_default:0|1;updated_at:number;group_id:string }
interface StatusRow { tenant_status:string;user_status:string }

export function resolveEffectiveModels(database:Database.Database,input:ResolveModelsInput):ResolveModelsResult {
  const status=database.prepare<[string,string],StatusRow>(`SELECT t.status tenant_status,u.status user_status FROM tenants t JOIN users u ON u.tenant_id=t.id WHERE t.id=? AND u.id=? AND u.deleted_at IS NULL`).get(input.tenantId,input.userId);
  if(!status) throw new GovernanceError('resource_not_found','Tenant or user was not found');
  if(status.tenant_status!=='active') throw new GovernanceError('tenant_inactive','Tenant is not active');
  if(status.user_status!=='active') throw new GovernanceError('account_inactive','Account is not active');
  const rows=database.prepare<[string,string],Row>(`SELECT m.id,m.provider_key,m.model_key,m.display_name,m.context_window,m.max_output_tokens,m.input_microusd_per_million,m.output_microusd_per_million,m.capabilities_json,m.is_default,m.updated_at,gm.group_id
    FROM group_members member JOIN groups g ON g.id=member.group_id AND g.tenant_id=member.tenant_id AND g.deleted_at IS NULL
    JOIN group_model_access gm ON gm.group_id=g.id AND gm.enabled=1 JOIN model_catalog m ON m.id=gm.model_catalog_id AND m.tenant_id=member.tenant_id AND m.enabled=1
    JOIN provider_config pc ON pc.tenant_id=member.tenant_id AND pc.provider_key=m.provider_key AND pc.enabled=1
    JOIN group_provider_access gp ON gp.group_id=g.id AND gp.provider_config_id=pc.id AND gp.enabled=1
    WHERE member.tenant_id=? AND member.user_id=? ORDER BY m.display_name,m.id,gm.group_id`).all(input.tenantId,input.userId);
  const groupIds=[...new Set(rows.map(r=>r.group_id))].sort();
  const byModel=new Map<string,{row:Row;groups:string[]}>();
  for(const row of rows){ const current=byModel.get(row.id); if(current)current.groups.push(row.group_id); else byModel.set(row.id,{row,groups:[row.group_id]}); }
  const models:EffectiveModel[]=[...byModel.values()].map(({row,groups})=>{ const capabilities=JSON.parse(row.capabilities_json) as unknown; const caps=Array.isArray(capabilities)?capabilities:[]; return {id:row.id,provider:row.provider_key as ProviderId,providerModel:row.model_key,displayName:row.display_name,enabledGlobally:true,supportsStreaming:true,supportsVision:caps.includes('vision'),contextWindowTokens:row.context_window,maxOutputTokens:row.max_output_tokens,inputPriceMicrosPerMillion:row.input_microusd_per_million,outputPriceMicrosPerMillion:row.output_microusd_per_million,cachedInputPriceMicrosPerMillion:null,pricingVersion:1,version:row.updated_at,isDefault:Boolean(row.is_default),enabledByGroupIds:groups,limitingMaxOutputTokens:row.max_output_tokens}; });
  if(input.requestedModelId&&!byModel.has(input.requestedModelId)) throw new GovernanceError('model_not_allowed','Requested model is not allowed');
  const defaultModelId=models.find(m=>m.isDefault)?.id??models[0]?.id??null;
  const catalogVersion=createHash('sha256').update(rows.map(r=>`${r.id}:${r.updated_at}:${r.group_id}`).join('|')).digest('hex').slice(0,16);
  return {models,defaultModelId,groupIds,catalogVersion};
}
