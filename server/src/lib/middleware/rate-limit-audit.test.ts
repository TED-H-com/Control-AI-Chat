import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {Hono} from 'hono';
import {createAuditService} from '../audit/index.js';
import {GovernanceError} from '../governance/errors.js';
import {runMigrations} from '../migrations/index.js';
import type {TenantId} from '../../shared/types.js';
import type {AppVariables} from '../http/index.js';
import {governanceRateLimit,type GovernanceRateLimiter} from './rate-limit.js';

const at=Date.UTC(2026,7,9);
function fixture(kind:'rate'|'stream'|'allowed'){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),sessionId=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,tenantId,tenantId,at,at);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)").run(userId,tenantId,`${userId}@test.invalid`,userId,at,at);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:at}),now:()=>at});
  const limiter:GovernanceRateLimiter={effectivePolicy:()=>({requestsPerMinute:20,requestBurst:10,concurrentStreams:2}),consumeRequest:()=>kind==='rate'?{allowed:false,remainingWholeTokens:0,retryAfterMs:1250,limit:20}:{allowed:true,remainingWholeTokens:19,retryAfterMs:0,limit:20},acquireStream(){if(kind==='stream')throw new GovernanceError('concurrent_stream_limit','full',{limit:2,active:2});return{id:'lease',tenantId,userId,reservationId:'request-audit',acquiredAt:at,heartbeatAt:at,expiresAt:at+30_000}},heartbeat(){throw new Error('unused')},releaseStream(){}};
  const app=new Hono<{Variables:AppVariables}>();app.use('*',async(c,next)=>{c.set('requestId','request-audit');c.set('verifiedClientIp','203.0.113.4');c.set('principal',{tenantId,userId,membershipId:userId,sessionId,roles:['member'],permissions:new Set()});await next()});app.use('*',governanceRateLimit(limiter,audit));app.post('/ordinary',c=>c.json({ok:true}));app.post('/chat/runs',c=>c.json({ok:true}));
  return {database,app,tenantId,userId};
}

test('request rate denial is audited without changing its 429 response',async()=>{const f=fixture('rate'),response=await f.app.request('/ordinary',{method:'POST'});assert.equal(response.status,429);assert.deepEqual(await response.json(),{error:{code:'RATE_LIMITED',message:'Request rate limit exceeded',retryable:true}});assert.equal(response.headers.get('Retry-After'),'2');assert.equal(response.headers.get('X-RateLimit-Limit'),'20');assert.equal(response.headers.get('X-RateLimit-Remaining'),'0');const row=f.database.prepare("SELECT action,outcome,request_id,metadata_json FROM audit_events WHERE action='billing.rate_limit_denied'").get() as {action:string;outcome:string;request_id:string;metadata_json:string};assert.deepEqual({...row,metadata_json:JSON.parse(row.metadata_json)},{action:'billing.rate_limit_denied',outcome:'denied',request_id:'request-audit',metadata_json:{limitKind:'requests',limit:20,windowSeconds:60,retryAfterMs:1250}});f.database.close()});
test('an allowed request writes no rate-limit audit event',async()=>{const f=fixture('allowed'),response=await f.app.request('/ordinary',{method:'POST'});assert.equal(response.status,200);assert.equal(f.database.prepare("SELECT COUNT(*) FROM audit_events WHERE action LIKE 'billing.%'").pluck().get(),0);f.database.close()});
test('concurrent stream denial audits the real active count',async()=>{const f=fixture('stream'),response=await f.app.request('/chat/runs',{method:'POST'});assert.equal(response.status,429);assert.deepEqual(await response.json(),{error:{code:'CONCURRENT_STREAM_LIMIT',message:'Concurrent stream limit reached',retryable:true}});assert.equal(response.headers.get('Retry-After'),'30');const row=f.database.prepare("SELECT action,outcome,metadata_json FROM audit_events WHERE action='billing.concurrent_stream_denied'").get() as {action:string;outcome:string;metadata_json:string};assert.deepEqual({...row,metadata_json:JSON.parse(row.metadata_json)},{action:'billing.concurrent_stream_denied',outcome:'denied',metadata_json:{limit:2,active:2}});f.database.close()});
