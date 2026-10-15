import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { adminCapabilities, adminDashboardSummary, prepareConsoleStatements } from './capabilities.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { forTenant, type TenantDb } from '../../lib/db.js';
import type { TenantId } from '../../shared/types.js';

const AT=1_700_000_000_000; // 2023-11-14T22:13:20Z
const DAY=86_400_000;

function fixture() {
  const database=new Database(':memory:'); runMigrations(database);
  const statements=prepareConsoleStatements(database);
  const tenantDb=(tenantId:TenantId):TenantDb => forTenant({tenantId});
  const run=(sql:string,...params:unknown[]):void => {database.prepare(sql).run(...params)};

  const tenant=(name:string):{tenantId:TenantId;userId:string;db:TenantDb} => {
    const tenantId=randomUUID() as TenantId, userId=randomUUID();
    run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`,tenantId,name,name,AT,AT);
    run(`INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)`,tenantId,AT);
    run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)`,userId,tenantId,`owner@${name}.test`,AT,AT);
    return {tenantId,userId,db:tenantDb(tenantId)};
  };
  const grant=(tenantId:TenantId,userId:string,key:string,storageKeys:readonly string[]):void => {
    const roleId=randomUUID();
    run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,?,?,1,?)`,roleId,tenantId,key,key,AT);
    for(const storage of storageKeys){run(`INSERT OR IGNORE INTO permissions(key,description) VALUES(?,?)`,storage,storage);run(`INSERT INTO role_permissions(role_id,permission_key) VALUES(?,?)`,roleId,storage)}
    run(`INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)`,tenantId,userId,roleId,userId,AT);
  };
  const usage=(tenantId:TenantId,userId:string|null,startedAt:number,input:number,output:number,cost:number,status='success'):void =>
    run(`INSERT INTO usage_records(id,tenant_id,user_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,completed_at,status) VALUES(?,?,?,'openai','gpt-x',?,?,?,?,?,?)`,randomUUID(),tenantId,userId,input,output,cost,startedAt,startedAt,status);
  const decision=(tenantId:TenantId,action:string,decidedAt:number):void =>
    run(`INSERT INTO gate_decisions(id,tenant_id,direction,final_action,status,content_sha256,latency_ms,decided_at) VALUES(?,?,'outbound',?,'final',?,5,?)`,randomUUID(),tenantId,action,'a'.repeat(64),decidedAt);
  const approval=(tenantId:TenantId,userId:string,status:string,expiresAt:number):void => {
    const eventId=randomUUID(), violationId=randomUUID();
    run(`INSERT OR IGNORE INTO audit_chain_epochs(tenant_id,chain_epoch,genesis_hash,first_sequence,status,reason,opened_at_ms) VALUES(?,1,?,1,'open','genesis',?)`,tenantId,'0'.repeat(64),AT);
    run(`INSERT INTO audit_events(id,tenant_id,chain_epoch,sequence,occurred_at_ms,recorded_at_ms,action,category,outcome,severity,actor_type,target_type,request_id,source,metadata_json,prev_hash,event_hash) VALUES(?,?,1,(SELECT COUNT(*)+1 FROM audit_events WHERE tenant_id=?),?,?,'gate.blocked','gate','success','high','user','message',?,'http','{}',?,?)`,eventId,tenantId,tenantId,AT,AT,randomUUID(),'0'.repeat(64),randomUUID().replace(/-/gu,''));
    run(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,'outbound','pii','require_approval','high','open','[]','***',?,?,?)`,violationId,tenantId,eventId,'b'.repeat(64),AT,AT);
    run(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms) VALUES(?,?,?,?,?,?,?,1,?,1,?,?)`,randomUUID(),tenantId,violationId,userId,status,Buffer.from('x'),Buffer.from('y'),'c'.repeat(64),expiresAt,AT);
  };
  const budget=(tenantId:TenantId,period:string,hardLimit:number,timezone='UTC'):string => {
    const id=randomUUID();
    run(`INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,'tenant',NULL,?,'usd',NULL,?,?,1,?,?)`,id,tenantId,period,hardLimit,timezone,AT,AT);
    return id;
  };
  const ledger=(tenantId:TenantId,budgetId:string,kind:string,amount:number,periodStart:number,periodEnd:number):void =>
    run(`INSERT INTO budget_ledger(id,tenant_id,budget_id,kind,amount,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?)`,randomUUID(),tenantId,budgetId,kind,amount,periodStart,periodEnd,AT);

  return {database,statements,tenant,grant,usage,decision,approval,budget,ledger};
}

test('capabilities resolve permissions from role_permissions, not from the role name',()=>{
  const f=fixture(), acme=f.tenant('acme');
  // An owner whose role grants only two rows must report only those two, even though the
  // owner role notionally holds the whole vocabulary.
  f.grant(acme.tenantId,acme.userId,'owner',['model.read','admin.users','unknown.permission']);
  assert.deepEqual(adminCapabilities(acme.db,acme.userId,f.statements),{
    tenantId:acme.tenantId, userId:acme.userId, roleIds:['owner'], assignableRoles:['admin','compliance','member'], permissions:['admin:users','model:read'],
    tenantTimezone:'UTC', tenantCurrency:'USD', contentAccessReasonRequired:false,
    tenant:{id:acme.tenantId,name:'acme',slug:'acme',status:'active'},
  });
  f.database.close();
});

test('capabilities are tenant scoped and union the roles a user actually holds',()=>{
  const f=fixture(), acme=f.tenant('acme'), other=f.tenant('other');
  f.grant(acme.tenantId,acme.userId,'compliance',['audit.read']);
  f.grant(acme.tenantId,acme.userId,'member',['chat.use']);
  f.grant(other.tenantId,other.userId,'owner',['budget.write']);
  const capabilities=adminCapabilities(acme.db,acme.userId,f.statements);
  assert.deepEqual(capabilities.roleIds,['compliance','member']);
  assert.deepEqual(capabilities.assignableRoles,[]);
  assert.deepEqual(capabilities.permissions,['chat:use','audit:read']);
  assert.deepEqual(adminCapabilities(acme.db,other.userId,f.statements).permissions,[]);
  f.database.close();
});

test('dashboard summary derives every metric from tenant rows inside the window',()=>{
  const f=fixture(), acme=f.tenant('acme'), other=f.tenant('other');
  f.usage(acme.tenantId,acme.userId,AT-2*DAY,100,50,4_000);
  f.usage(acme.tenantId,acme.userId,AT-DAY,10,5,1_000,'failed');
  f.usage(acme.tenantId,null,AT-DAY,7,3,500);
  f.usage(acme.tenantId,acme.userId,AT-40*DAY,999,999,999_999);  // before the window
  f.usage(other.tenantId,other.userId,AT-DAY,999,999,999_999);   // another tenant
  f.decision(acme.tenantId,'block',AT-DAY); f.decision(acme.tenantId,'block',AT-2*DAY);
  f.decision(acme.tenantId,'allow',AT-DAY); f.decision(acme.tenantId,'block',AT-40*DAY);
  f.decision(other.tenantId,'block',AT-DAY);
  f.approval(acme.tenantId,acme.userId,'pending',AT+DAY);
  f.approval(acme.tenantId,acme.userId,'release_failed',AT+DAY);
  f.approval(acme.tenantId,acme.userId,'pending',AT-DAY);   // expired
  f.approval(acme.tenantId,acme.userId,'released',AT+DAY);  // already decided
  f.approval(other.tenantId,other.userId,'pending',AT+DAY);

  const summary=adminDashboardSummary(acme.db,{fromMs:AT-30*DAY,toMs:AT},f.statements);
  assert.equal(summary.requests,3);
  assert.equal(summary.activeUsers,1);
  assert.deepEqual(summary.tokens,{total:175,input:117,output:58});
  assert.equal(summary.spendMicroUsd,5_500);
  assert.equal(summary.blockedRequests,2);
  assert.equal(summary.pendingApprovals,2);
  assert.equal(summary.providerErrorRate,1/3);
  assert.equal(summary.dataFreshThrough,new Date(AT-DAY).toISOString());
  f.database.close();
});

test('data freshness follows the newest row from either source in the window',()=>{
  const f=fixture(), acme=f.tenant('acme');
  f.usage(acme.tenantId,acme.userId,AT-2*DAY,1,1,1);
  f.decision(acme.tenantId,'allow',AT-DAY);
  const freshThrough=(toMs:number):string|null => adminDashboardSummary(acme.db,{fromMs:AT-30*DAY,toMs},f.statements).dataFreshThrough;
  assert.equal(freshThrough(AT),new Date(AT-DAY).toISOString());
  assert.equal(freshThrough(AT-DAY-1),new Date(AT-2*DAY).toISOString());
  f.database.close();
});

test('an empty window reports zeros and nulls rather than invented numbers',()=>{
  const f=fixture(), acme=f.tenant('acme');
  f.usage(acme.tenantId,acme.userId,AT-40*DAY,10,10,10);
  const summary=adminDashboardSummary(acme.db,{fromMs:AT-7*DAY,toMs:AT},f.statements);
  assert.equal(summary.requests,0);
  assert.equal(summary.providerErrorRate,null);
  assert.equal(summary.dataFreshThrough,null);
  assert.equal(summary.budgetUsedMicroUsd,null);
  assert.equal(summary.budgetLimitMicroUsd,null);
  assert.equal(summary.usage.length,8);
  assert.ok(summary.usage.every(point=>point.value===0));
  f.database.close();
});

test('budget utilization sums the settled ledger for the window the enforcer uses',()=>{
  const f=fixture(), acme=f.tenant('acme');
  const monthly=f.budget(acme.tenantId,'monthly',50_000_000), daily=f.budget(acme.tenantId,'daily',200_000);
  const start=Date.UTC(2023,10,1), end=Date.UTC(2023,11,1);
  f.ledger(acme.tenantId,monthly,'settle',3_000_000,start,end);
  f.ledger(acme.tenantId,monthly,'adjustment',500_000,start,end);
  f.ledger(acme.tenantId,monthly,'reserve',9_000_000,start,end);              // outstanding, not spent
  f.ledger(acme.tenantId,monthly,'settle',7_000_000,Date.UTC(2023,9,1),start); // previous period
  f.ledger(acme.tenantId,daily,'settle',150_000,AT-AT%DAY,AT-AT%DAY+DAY);      // a different budget
  const summary=adminDashboardSummary(acme.db,{fromMs:AT-30*DAY,toMs:AT},f.statements);
  assert.equal(summary.budgetLimitMicroUsd,50_000_000);
  assert.equal(summary.budgetUsedMicroUsd,3_500_000);
  f.database.close();
});

test('an unusable budget timezone leaves the budget unavailable instead of failing the overview',()=>{
  const f=fixture(), acme=f.tenant('acme');
  f.budget(acme.tenantId,'monthly',50_000_000,'Mars/Olympus');
  const summary=adminDashboardSummary(acme.db,{fromMs:AT-30*DAY,toMs:AT},f.statements);
  assert.equal(summary.budgetLimitMicroUsd,null);
  assert.equal(summary.budgetUsedMicroUsd,null);
  f.database.close();
});

test('the usage series is dense and its JS bucket keys match the ones SQLite emits',()=>{
  const f=fixture(), acme=f.tenant('acme');
  f.usage(acme.tenantId,acme.userId,AT-2*DAY,10,10,700);
  f.usage(acme.tenantId,acme.userId,AT-2*DAY+60_000,5,5,300);
  f.usage(acme.tenantId,acme.userId,AT,1,1,100);
  const summary=adminDashboardSummary(acme.db,{fromMs:AT-6*DAY,toMs:AT},f.statements);
  assert.deepEqual(summary.usage.map(point=>point.label),['2023-11-08','2023-11-09','2023-11-10','2023-11-11','2023-11-12','2023-11-13','2023-11-14']);
  assert.deepEqual(summary.usage.map(point=>point.value),[0,0,0,0,2,0,0]);
  assert.deepEqual(summary.usage[4],{bucket:'2023-11-12',label:'2023-11-12',bucketStartMs:Date.parse('2023-11-12T00:00:00Z'),value:2,requests:2,totalTokens:30,spendMicroUsd:1_000});
  f.database.close();
});

test('a one-day window buckets hourly so the chart is not a single point',()=>{
  const f=fixture(), acme=f.tenant('acme');
  f.usage(acme.tenantId,acme.userId,AT-2*3_600_000,4,4,100);
  const summary=adminDashboardSummary(acme.db,{fromMs:AT-24*3_600_000,toMs:AT},f.statements);
  assert.equal(summary.usage.length,25);
  assert.equal(summary.usage[0]?.label,'2023-11-13T22:00+00:00');
  assert.equal(summary.usage.find(point=>point.value>0)?.label,'2023-11-14T20:00+00:00');
  f.database.close();
});

test('an inverted or unbounded range is rejected rather than looped over',()=>{
  const f=fixture(), acme=f.tenant('acme');
  assert.throws(()=>adminDashboardSummary(acme.db,{fromMs:AT,toMs:AT-DAY},f.statements),RangeError);
  assert.throws(()=>adminDashboardSummary(acme.db,{fromMs:0,toMs:Number.MAX_SAFE_INTEGER},f.statements),RangeError);
  f.database.close();
});
