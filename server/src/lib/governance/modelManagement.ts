import type Database from 'better-sqlite3';
import { GovernanceError } from './errors.js';
import type { ProviderId } from './types.js';

export class ModelGovernance {
  constructor(private readonly database:Database.Database,readonly tenantId:string) {}
  setProviderAllowed(groupId:string,provider:ProviderId,allowed:boolean,now:number):void { const result=this.database.prepare(`UPDATE group_provider_access SET enabled=? WHERE group_id IN (SELECT id FROM groups WHERE tenant_id=? AND id=? AND deleted_at IS NULL) AND provider_config_id IN (SELECT id FROM provider_config WHERE tenant_id=? AND provider_key=?)`).run(allowed?1:0,this.tenantId,groupId,this.tenantId,provider); if(result.changes!==1)throw new GovernanceError('resource_not_found','Group or provider configuration was not found'); void now; }
  setGroupModelEnabled(groupId:string,modelId:string,enabled:boolean):void { const result=this.database.prepare(`UPDATE group_model_access SET enabled=? WHERE group_id IN (SELECT id FROM groups WHERE tenant_id=? AND id=? AND deleted_at IS NULL) AND model_catalog_id IN (SELECT id FROM model_catalog WHERE tenant_id=? AND id=?)`).run(enabled?1:0,this.tenantId,groupId,this.tenantId,modelId); if(result.changes!==1)throw new GovernanceError('resource_not_found','Group or model was not found'); }
  updatePrice(modelId:string,inputMicrosPerMillion:number,outputMicrosPerMillion:number,now:number):void { for(const value of [inputMicrosPerMillion,outputMicrosPerMillion])if(!Number.isSafeInteger(value)||value<0)throw new GovernanceError('pricing_overflow','Price must be a nonnegative safe integer'); const result=this.database.prepare<[number,number,number,string,string]>('UPDATE model_catalog SET input_microusd_per_million=?,output_microusd_per_million=?,updated_at=? WHERE tenant_id=? AND id=?').run(inputMicrosPerMillion,outputMicrosPerMillion,now,this.tenantId,modelId); if(result.changes!==1)throw new GovernanceError('resource_not_found','Model was not found'); }
}
