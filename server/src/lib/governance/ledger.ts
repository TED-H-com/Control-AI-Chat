import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { applicableBudgets, warningFor } from './budgets.js';
import { GovernanceError } from './errors.js';
import { calculateCost } from './pricing.js';
import type { PricingSnapshot, ReservationGrant, ReservationRequest, SettlementInput, SettlementResult } from './types.js';

const MIN_OUTPUT=16;
const TTL=15*60_000;
interface ModelRow { id:string;provider_key:string;model_key:string;input_microusd_per_million:number;output_microusd_per_million:number;cached_input_microusd_per_million:number|null;pricing_version:number;max_output_tokens:number }
interface ReservationMetadataRow { metadata_json:string }
interface LedgerRow { tenant_id:string;budget_id:string;budget_tenant_id:string;amount:number;period_start:number;period_end:number;metadata_json:string;metric:'tokens'|'usd' }
interface ReservationWindow { budgetId:string;start:number;end:number }
interface UsageRow { id:string;user_id:string|null;conversation_id:string|null;message_id:string|null;model_catalog_id:string|null;input_tokens:number;output_tokens:number;cost_microusd:number;status:string }
interface UsageAttributionRow { user_id:string;conversation_id:string;message_id:string;model_catalog_id:string }
interface Meta { reservationId:string;tenantId:string;userId:string;conversationId:string;messageId:string;modelId:string;provider:string;input:number;output:number;cost:number;expiresAt:number;pricing:PricingSnapshot }
interface DurableReservationRow { tenant_id:string;status:'active'|'released'|'settled';expires_at:number;metadata_json:string }
const volatile=new Map<string,Meta>();
function safeInt(n:number,name:string):void { if(!Number.isSafeInteger(n)||n<0)throw new GovernanceError('ledger_invariant_violation',`${name} must be a nonnegative safe integer`); }
function parseMeta(text:string):Meta { const value=JSON.parse(text) as Meta; return value; }

export class GovernanceLedger {
  constructor(private readonly database:Database.Database) {}
  private durable():boolean{return Boolean(this.database.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='budget_reservations'").get())}
  reserve(input:ReservationRequest):ReservationGrant {
    safeInt(input.estimatedInputTokens,'estimated input'); safeInt(input.requestedMaxOutputTokens,'requested output');
    if(input.groupIds.length>100)throw new GovernanceError('ledger_invariant_violation','A user may have at most 100 groups');
    return this.database.transaction(()=>{
      const existing=this.database.prepare<[string,string],ReservationMetadataRow>('SELECT metadata_json FROM budget_ledger WHERE tenant_id=? AND reservation_key=? AND kind=\'reserve\' LIMIT 1').get(input.tenantId,input.idempotencyKey);
      if(existing){
        const durable=this.durable()?this.database.prepare<[string,string],DurableReservationRow>('SELECT tenant_id,status,expires_at,metadata_json FROM budget_reservations WHERE tenant_id=? AND idempotency_key=?').get(input.tenantId,input.idempotencyKey):undefined;
        const meta=parseMeta(durable?.metadata_json??existing.metadata_json);
        if(meta.tenantId!==input.tenantId||meta.userId!==input.userId||meta.conversationId!==input.conversationId||meta.messageId!==input.messageId||meta.modelId!==input.modelId||meta.provider!==input.provider)throw new GovernanceError('idempotency_conflict','Idempotency key was used for a different request');
        if(durable&&(durable.status!=='active'||durable.expires_at<=input.now))throw new GovernanceError('idempotency_conflict','Idempotent reservation is no longer active');
        if(!durable&&meta.expiresAt<=input.now)throw new GovernanceError('idempotency_conflict','Idempotent reservation is no longer active');
        return this.grant(meta,[]);
      }
      const model=this.database.prepare<[string,string],ModelRow>(`SELECT id,provider_key,model_key,input_microusd_per_million,output_microusd_per_million,
          cached_input_microusd_per_million,1 pricing_version,max_output_tokens FROM model_catalog WHERE tenant_id=? AND id=? AND enabled=1`).get(input.tenantId,input.modelId);
      if(!model||model.provider_key!==input.provider)throw new GovernanceError('model_not_allowed','Requested model is not enabled');
      const user=this.database.prepare<[string,string],{status:string}>('SELECT status FROM users WHERE tenant_id=? AND id=? AND deleted_at IS NULL').get(input.tenantId,input.userId);
      const tenant=this.database.prepare<[string],{status:string}>('SELECT status FROM tenants WHERE id=?').get(input.tenantId);
      if(!tenant||tenant.status!=='active')throw new GovernanceError('tenant_inactive','Tenant is not active');
      if(!user||user.status!=='active')throw new GovernanceError('account_inactive','Account is not active');
      const pricing:PricingSnapshot={modelId:model.id,provider:input.provider,providerModel:model.model_key,pricingVersion:model.pricing_version,inputPriceMicrosPerMillion:model.input_microusd_per_million,outputPriceMicrosPerMillion:model.output_microusd_per_million,cachedInputPriceMicrosPerMillion:model.cached_input_microusd_per_million};
      const budgets=applicableBudgets(this.database,input.tenantId,input.userId,input.groupIds,input.now);
      let output=Math.min(input.requestedMaxOutputTokens,model.max_output_tokens);
      for(const b of budgets){ const remaining=b.hardLimit-b.used-b.reserved; const inputAmount=b.metric==='tokens'?input.estimatedInputTokens:calculateCost(pricing,input.estimatedInputTokens,0,0).totalCostMicros; if(inputAmount>remaining)throw new GovernanceError('budget_hard_cap_exceeded','Budget hard cap exceeded',{scopeType:b.scopeType,window:b.window,metric:b.metric,resetAt:b.windowEnd}); if(b.metric==='tokens') output=Math.min(output,remaining-input.estimatedInputTokens); else { let low=0,high=output; while(low<high){const mid=Math.ceil((low+high)/2); if(calculateCost(pricing,input.estimatedInputTokens,0,mid).totalCostMicros<=remaining)low=mid;else high=mid-1;} output=low; } }
      if(output<MIN_OUTPUT)throw new GovernanceError('budget_output_too_small','Budget cannot reserve the minimum response size');
      const cost=calculateCost(pricing,input.estimatedInputTokens,0,output).totalCostMicros;
      const meta:Meta={reservationId:randomUUID(),tenantId:input.tenantId,userId:input.userId,conversationId:input.conversationId,messageId:input.messageId,modelId:input.modelId,provider:input.provider,input:input.estimatedInputTokens,output,cost,expiresAt:input.now+TTL,pricing};
      if(this.durable())this.database.prepare("INSERT INTO budget_reservations(id,tenant_id,idempotency_key,status,metadata_json,created_at,expires_at,budget_windows_json) VALUES(?,?,?,'active',?,?,?,?)").run(meta.reservationId,input.tenantId,input.idempotencyKey,JSON.stringify(meta),input.now,meta.expiresAt,JSON.stringify(budgets.map(b=>({budgetId:b.id,start:b.windowStart,end:b.windowEnd}))));
      const warnings=[];
      for(const b of budgets){ const amount=b.metric==='tokens'?meta.input+meta.output:meta.cost; this.database.prepare(`INSERT INTO budget_ledger(id,tenant_id,budget_id,reservation_key,kind,amount,period_start,period_end,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),input.tenantId,b.id,input.idempotencyKey,'reserve',amount,b.windowStart,b.windowEnd,input.now,JSON.stringify(meta)); const warning=warningFor(b,b.used+b.reserved+amount); if(warning)warnings.push(warning); }
      volatile.set(meta.reservationId,meta);
      return this.grant(meta,warnings);
    }).immediate();
  }
  private grant(meta:Meta,warnings:ReservationGrant['softWarnings']):ReservationGrant { return {reservationId:meta.reservationId,allowedMaxOutputTokens:meta.output,reservedInputTokens:meta.input,reservedOutputTokens:meta.output,reservedTotalTokens:meta.input+meta.output,reservedCostMicros:meta.cost,expiresAt:meta.expiresAt,softWarnings:warnings,pricingSnapshot:meta.pricing}; }
  private load(reservationId:string):{tenantId:string;meta:Meta;rows:LedgerRow[]}|null {
    const rows=this.database.prepare<[string],LedgerRow>(`SELECT l.tenant_id,l.budget_id,b.tenant_id budget_tenant_id,l.amount,l.period_start,l.period_end,l.metadata_json,b.metric
      FROM budget_ledger l LEFT JOIN budgets b ON b.id=l.budget_id
      WHERE l.kind='reserve' AND json_extract(l.metadata_json,'$.reservationId')=?`).all(reservationId);
    const durable=this.durable()?this.database.prepare<[string],DurableReservationRow&{budget_windows_json:string}>('SELECT tenant_id,status,expires_at,metadata_json,budget_windows_json FROM budget_reservations WHERE id=?').get(reservationId):undefined;
    const meta=durable?parseMeta(durable.metadata_json):rows.length?parseMeta(rows[0]!.metadata_json):volatile.get(reservationId);
    if(!meta)return null;
    const tenantId=durable?.tenant_id??rows[0]?.tenant_id??meta.tenantId;
    if(meta.reservationId!==reservationId||meta.tenantId!==tenantId||meta.pricing?.modelId!==meta.modelId||meta.pricing?.provider!==meta.provider||rows.some(row=>row.tenant_id!==tenantId||row.budget_tenant_id!==tenantId||!['tokens','usd'].includes(row.metric)))throw new GovernanceError('ledger_invariant_violation','Reservation tenant attribution is inconsistent');
    if(!durable)return {tenantId,meta,rows};
    const windows=JSON.parse(durable.budget_windows_json) as ReservationWindow[],byBudget=new Map(windows.map(window=>[window.budgetId,window]));
    return {tenantId,meta,rows:rows.map(row=>{const window=byBudget.get(row.budget_id);return window?{...row,period_start:window.start,period_end:window.end}:row;})};
  }
  settle(input:SettlementInput):SettlementResult { return this.database.transaction(()=>{
    const reservationId=input.reservationId,loaded=this.load(reservationId); if(!loaded)throw new GovernanceError('resource_not_found','Reservation was not found'); const {tenantId,meta,rows}=loaded;
    if(input.providerModel!==meta.pricing.providerModel)throw new GovernanceError('ledger_invariant_violation','Settlement provider model does not match its reservation');
    const attribution=this.database.prepare<[string,string,string,string,string,string],UsageAttributionRow>(`SELECT u.id user_id,c.id conversation_id,m.id message_id,mc.id model_catalog_id
      FROM users u JOIN conversations c ON c.tenant_id=u.tenant_id AND c.owner_user_id=u.id
      JOIN messages m ON m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND m.role='assistant'
      JOIN model_catalog mc ON mc.tenant_id=c.tenant_id AND mc.id=m.model_catalog_id AND mc.provider_key=m.provider_key
      WHERE c.tenant_id=? AND u.id=? AND c.id=? AND m.id=? AND mc.id=? AND mc.provider_key=?`).get(tenantId,meta.userId,meta.conversationId,meta.messageId,meta.modelId,meta.provider);
    if(!attribution)throw new GovernanceError('ledger_invariant_violation','Reservation usage attribution is missing or outside its tenant');
    const prior=this.database.prepare<[string,string],UsageRow>(`SELECT id,user_id,conversation_id,message_id,model_catalog_id,input_tokens,output_tokens,cost_microusd,status FROM usage_records WHERE tenant_id=? AND provider_request_id=?`).get(tenantId,`reservation:${reservationId}`);
    if(prior){
      if(prior.user_id!==attribution.user_id||prior.model_catalog_id!==attribution.model_catalog_id||(prior.conversation_id!==null&&prior.conversation_id!==attribution.conversation_id)||(prior.message_id!==null&&prior.message_id!==attribution.message_id))throw new GovernanceError('ledger_invariant_violation','Settled usage attribution conflicts with its reservation');
      if(prior.conversation_id===null||prior.message_id===null){
        const conflict=this.database.prepare<[string,string,string],{id:string}>('SELECT id FROM usage_records WHERE tenant_id=? AND message_id=? AND id<>? LIMIT 1').get(tenantId,attribution.message_id,prior.id);
        if(conflict)throw new GovernanceError('ledger_invariant_violation','Reservation message is already attributed to another usage record');
        const changed=this.database.prepare(`UPDATE usage_records SET conversation_id=?,message_id=? WHERE tenant_id=? AND id=? AND (conversation_id IS NULL OR conversation_id=?) AND (message_id IS NULL OR message_id=?)`).run(attribution.conversation_id,attribution.message_id,tenantId,prior.id,attribution.conversation_id,attribution.message_id);
        if(changed.changes!==1)throw new GovernanceError('ledger_invariant_violation','Settled usage attribution changed during reconciliation');
      }
      return {reservationId,usageEventId:prior.id,chargedInputTokens:prior.input_tokens,chargedOutputTokens:prior.output_tokens,chargedCostMicros:prior.cost_microusd,releasedTokens:Math.max(0,meta.input+meta.output-prior.input_tokens-prior.output_tokens),releasedCostMicros:Math.max(0,meta.cost-prior.cost_microusd),status:prior.status==='failed'?'reconciliation_required' as const:'settled' as const};
    }
    const chargedInput=Math.max(0,input.actualInputTokens??meta.input); const chargedOutput=Math.max(0,input.actualOutputTokens??input.locallyCountedOutputTokens); safeInt(chargedInput,'actual input');safeInt(chargedOutput,'actual output');
    if(input.actualCostMicros!==undefined)safeInt(input.actualCostMicros,'actual cost');
    const cost=input.actualCostMicros??calculateCost(meta.pricing,chargedInput,Math.max(0,input.actualCachedInputTokens??0),chargedOutput).totalCostMicros; const over=chargedInput+chargedOutput>meta.input+meta.output||cost>meta.cost;
    const usageId=randomUUID(); this.database.prepare(`INSERT INTO usage_records(id,tenant_id,user_id,conversation_id,message_id,model_catalog_id,provider_key,model_key,input_tokens,output_tokens,cached_input_tokens,cost_microusd,started_at,completed_at,provider_request_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(usageId,tenantId,attribution.user_id,attribution.conversation_id,attribution.message_id,attribution.model_catalog_id,meta.provider,input.providerModel,chargedInput,chargedOutput,Math.max(0,input.actualCachedInputTokens??0),cost,input.now,input.now,`reservation:${reservationId}`,over?'failed':input.outcome==='complete'?'success':'cancelled');
    for(const row of rows){
      const metricAmount=row.metric==='usd'?cost:chargedInput+chargedOutput,metadata=JSON.stringify({reservationId});
      const released=this.database.prepare<[string,string,string],{n:number}>(`SELECT COUNT(*) n FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND json_extract(metadata_json,'$.reservationId')=? AND kind='release'`).get(tenantId,row.budget_id,reservationId)?.n??0;
      if(!released)this.database.prepare(`INSERT INTO budget_ledger(id,tenant_id,budget_id,usage_record_id,reservation_key,kind,amount,period_start,period_end,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),tenantId,row.budget_id,usageId,null,'release',row.amount,row.period_start,row.period_end,input.now,metadata);
      this.database.prepare(`INSERT INTO budget_ledger(id,tenant_id,budget_id,usage_record_id,reservation_key,kind,amount,period_start,period_end,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),tenantId,row.budget_id,usageId,null,'settle',metricAmount,row.period_start,row.period_end,input.now,metadata);
    }
    if(this.durable())this.database.prepare("UPDATE budget_reservations SET status='settled',settled_at=? WHERE tenant_id=? AND id=? AND status IN ('active','released')").run(input.now,tenantId,reservationId);volatile.delete(reservationId); return {reservationId,usageEventId:usageId,chargedInputTokens:chargedInput,chargedOutputTokens:chargedOutput,chargedCostMicros:cost,releasedTokens:Math.max(0,meta.input+meta.output-chargedInput-chargedOutput),releasedCostMicros:Math.max(0,meta.cost-cost),status:over?'reconciliation_required' as const:'settled' as const};
  }).immediate(); }
  heartbeat(reservationId:string,now:number,ttlMs=TTL):boolean {
    safeInt(now,'heartbeat time');safeInt(ttlMs,'heartbeat ttl');if(ttlMs<1)throw new GovernanceError('ledger_invariant_violation','Heartbeat ttl must be positive');
    if(this.durable()){
      const extend=()=>{
      const expiresAt=now+ttlMs;safeInt(expiresAt,'reservation expiry');
      const changed=this.database.prepare("UPDATE budget_reservations SET expires_at=?,metadata_json=json_set(metadata_json,'$.expiresAt',?) WHERE id=? AND status='active' AND expires_at>?").run(expiresAt,expiresAt,reservationId,now);
      return changed.changes===1;
      };
      return this.database.inTransaction?extend():this.database.transaction(extend).immediate();
    }
    const meta=volatile.get(reservationId);if(!meta||meta.expiresAt<=now)return false;meta.expiresAt=now+ttlMs;return true;
  }
  release(reservationId:string,reason:string,now:number):void { if(!reason.trim())throw new GovernanceError('ledger_invariant_violation','Release reason is required'); this.database.transaction(()=>{ const loaded=this.load(reservationId); if(!loaded)return; for(const row of loaded.rows){ const already=this.database.prepare<[string,string,string],{n:number}>(`SELECT COUNT(*) n FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND json_extract(metadata_json,'$.reservationId')=? AND kind IN ('release','settle')`).get(loaded.tenantId,row.budget_id,reservationId)?.n??0; if(!already)this.database.prepare(`INSERT INTO budget_ledger(id,tenant_id,budget_id,usage_record_id,reservation_key,kind,amount,period_start,period_end,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),loaded.tenantId,row.budget_id,null,null,'release',row.amount,row.period_start,row.period_end,now,JSON.stringify({reservationId,reason})); }if(this.durable())this.database.prepare("UPDATE budget_reservations SET status='released',released_at=?,release_reason=? WHERE tenant_id=? AND id=? AND status='active'").run(now,reason,loaded.tenantId,reservationId); volatile.delete(reservationId); }).immediate(); }
  expireReservationIfStale(reservationId:string,now:number):boolean {
    if(!this.durable()){
      const meta=volatile.get(reservationId);if(!meta||meta.expiresAt>now)return false;this.release(reservationId,'reservation expired',now);return true;
    }
    return this.database.transaction(()=>{
      const changed=this.database.prepare("UPDATE budget_reservations SET status='released',released_at=?,release_reason='reservation expired' WHERE id=? AND status='active' AND expires_at<=?").run(now,reservationId,now);
      if(changed.changes!==1)return false;
      const loaded=this.load(reservationId);if(!loaded)throw new GovernanceError('ledger_invariant_violation','Expired reservation metadata was not found');
      for(const row of loaded.rows){
        const already=this.database.prepare<[string,string,string],{n:number}>(`SELECT COUNT(*) n FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND json_extract(metadata_json,'$.reservationId')=? AND kind IN ('release','settle')`).get(loaded.tenantId,row.budget_id,reservationId)?.n??0;
        if(!already)this.database.prepare(`INSERT INTO budget_ledger(id,tenant_id,budget_id,usage_record_id,reservation_key,kind,amount,period_start,period_end,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),loaded.tenantId,row.budget_id,null,null,'release',row.amount,row.period_start,row.period_end,now,JSON.stringify({reservationId,reason:'reservation expired'}));
      }
      volatile.delete(reservationId);return true;
    }).immediate();
  }
  expireStale(now:number,limit:number):number { const ids=this.durable()?this.database.prepare<[number,number],{id:string}>(`SELECT id FROM budget_reservations WHERE status='active' AND expires_at<=? LIMIT ?`).all(now,limit):this.database.prepare<[number,number],{id:string}>(`SELECT DISTINCT json_extract(r.metadata_json,'$.reservationId') id FROM budget_ledger r WHERE r.kind='reserve' AND json_extract(r.metadata_json,'$.expiresAt')<=? AND NOT EXISTS (SELECT 1 FROM budget_ledger t WHERE t.tenant_id=r.tenant_id AND t.budget_id=r.budget_id AND t.kind IN ('release','settle') AND json_extract(t.metadata_json,'$.reservationId')=json_extract(r.metadata_json,'$.reservationId')) LIMIT ?`).all(now,limit); let expired=0;for(const {id} of ids)if(this.expireReservationIfStale(id,now))expired++;return expired; }
}
