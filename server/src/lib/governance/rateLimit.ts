import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GovernanceError } from './errors.js';
import type { RateLimitDecision, RateLimitPolicy, StreamLease } from './types.js';

export const DEFAULT_RATE_LIMIT:RateLimitPolicy={requestsPerMinute:20,requestBurst:10,concurrentStreams:2};
interface Setting { requests_per_minute:number;concurrent_streams:number }
interface Bucket { window_start:number;count:number;lease_expires_at:number|null }
export class RateLimiter {
  private readonly leases=new Map<string,StreamLease>();
  constructor(private readonly database:Database.Database) {}
  effectivePolicy(tenantId:string,userId:string,groupIds:readonly string[]):RateLimitPolicy {
    const tenant=this.database.prepare<[string],Setting>('SELECT requests_per_minute,concurrent_streams FROM tenant_settings WHERE tenant_id=?').get(tenantId);
    const policy={requestsPerMinute:tenant?.requests_per_minute??DEFAULT_RATE_LIMIT.requestsPerMinute,requestBurst:tenant?.requests_per_minute??DEFAULT_RATE_LIMIT.requestBurst,concurrentStreams:tenant?.concurrent_streams??DEFAULT_RATE_LIMIT.concurrentStreams};
    // The implemented schema stores tenant defaults; group/user overrides can be added by a future guarded migration.
    void userId; void groupIds; return policy;
  }
  consumeRequest(tenantId:string,userId:string,policy:RateLimitPolicy,now:number):RateLimitDecision { return this.database.transaction(()=>{
    const start=Math.floor(now/60_000)*60_000; const row=this.database.prepare<[string,string,number],Bucket>(`SELECT window_start,count,lease_expires_at FROM rate_limit_buckets WHERE tenant_id=? AND user_id=? AND bucket_key='requests' AND window_start=?`).get(tenantId,userId,start);
    const limit=Math.max(policy.requestsPerMinute,policy.requestBurst); const allowed=(row?.count??0)<limit;
    if(!row)this.database.prepare<[string,string,number,number]>(`INSERT INTO rate_limit_buckets(tenant_id,user_id,bucket_key,window_start,count,updated_at) VALUES(?,?,'requests',?,0,?)`).run(tenantId,userId,start,now);
    if(allowed)this.database.prepare<[number,string,string,number]>(`UPDATE rate_limit_buckets SET count=count+1,updated_at=? WHERE tenant_id=? AND user_id=? AND bucket_key='requests' AND window_start=?`).run(now,tenantId,userId,start);
    const count=(row?.count??0)+(allowed?1:0); return {allowed,remainingWholeTokens:Math.max(0,limit-count),retryAfterMs:allowed?0:start+60_000-now,limit};
  }).immediate(); }
  acquireStream(tenantId:string,userId:string,reservationId:string,policy:RateLimitPolicy,now:number):StreamLease { return this.database.transaction(()=>{
    const start=0; const row=this.database.prepare<[string,string,number],Bucket>(`SELECT window_start,count,lease_expires_at FROM rate_limit_buckets WHERE tenant_id=? AND user_id=? AND bucket_key='streams' AND window_start=?`).get(tenantId,userId,start);
    const active=row&&row.lease_expires_at!==null&&row.lease_expires_at>now?row.count:0;
    if(active>=policy.concurrentStreams)throw new GovernanceError('concurrent_stream_limit','Concurrent stream limit reached',{limit:policy.concurrentStreams,active});
    this.database.prepare(`INSERT INTO rate_limit_buckets(tenant_id,user_id,bucket_key,window_start,count,lease_expires_at,updated_at) VALUES(?,?,'streams',?,?,?,?) ON CONFLICT(tenant_id,user_id,bucket_key,window_start) DO UPDATE SET count=?,lease_expires_at=?,updated_at=?`).run(tenantId,userId,start,active+1,now+30_000,now,active+1,now+30_000,now);
    const lease={id:randomUUID(),tenantId,userId,reservationId,acquiredAt:now,heartbeatAt:now,expiresAt:now+30_000}; this.leases.set(lease.id,lease); return lease;
  }).immediate(); }
  heartbeat(leaseId:string,now:number):StreamLease { const lease=this.leases.get(leaseId); if(!lease)throw new GovernanceError('resource_not_found','Stream lease was not found'); const next={...lease,heartbeatAt:now,expiresAt:now+30_000}; this.database.prepare<[number,number,string,string]>(`UPDATE rate_limit_buckets SET lease_expires_at=?,updated_at=? WHERE tenant_id=? AND user_id=? AND bucket_key='streams' AND window_start=0`).run(next.expiresAt,now,lease.tenantId,lease.userId); this.leases.set(leaseId,next); return next; }
  releaseStream(leaseId:string,now:number):void { const lease=this.leases.get(leaseId); if(!lease)return; this.database.transaction(()=>{ this.database.prepare<[number,string,string]>(`UPDATE rate_limit_buckets SET count=MAX(0,count-1),updated_at=?,lease_expires_at=CASE WHEN count<=1 THEN NULL ELSE lease_expires_at END WHERE tenant_id=? AND user_id=? AND bucket_key='streams' AND window_start=0`).run(now,lease.tenantId,lease.userId); }).immediate(); this.leases.delete(leaseId); }
}
