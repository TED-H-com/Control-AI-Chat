import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { TenantId } from '../../shared/types.js';
import { generateNudges, prepareNudgeStatements, warnProceededCount, type NudgeInputs } from './nudges.js';

const empty=(overrides:Partial<NudgeInputs>={}):NudgeInputs=>({pendingApprovals:0,blockedRequests:0,budgetUsedMicroUsd:null,budgetLimitMicroUsd:null,warnProceeded:0,...overrides});

test('approval nudges cross the medium and high thresholds exactly',()=>{
  assert.deepEqual(generateNudges(empty({pendingApprovals:0})),[]);
  assert.deepEqual(generateNudges(empty({pendingApprovals:1})),[{key:'approvalsPending:medium',ruleId:'approvalsPending',category:'governance',priority:'medium',count:1}]);
  assert.equal(generateNudges(empty({pendingApprovals:9}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({pendingApprovals:10}))[0]?.priority,'high');
});

test('blocked-volume nudges cross the medium and high thresholds exactly',()=>{
  assert.deepEqual(generateNudges(empty({blockedRequests:4})),[]);
  assert.equal(generateNudges(empty({blockedRequests:5}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({blockedRequests:24}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({blockedRequests:25}))[0]?.priority,'high');
});

test('budget nudges require a positive limit and cross both ratio thresholds',()=>{
  assert.deepEqual(generateNudges(empty({budgetUsedMicroUsd:75,budgetLimitMicroUsd:null})),[]);
  assert.deepEqual(generateNudges(empty({budgetUsedMicroUsd:75,budgetLimitMicroUsd:0})),[]);
  assert.deepEqual(generateNudges(empty({budgetUsedMicroUsd:74,budgetLimitMicroUsd:100})),[]);
  assert.equal(generateNudges(empty({budgetUsedMicroUsd:75,budgetLimitMicroUsd:100}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({budgetUsedMicroUsd:89,budgetLimitMicroUsd:100}))[0]?.priority,'medium');
  assert.deepEqual(generateNudges(empty({budgetUsedMicroUsd:90,budgetLimitMicroUsd:100}))[0],{key:'budgetUtilization:high',ruleId:'budgetUtilization',category:'cost',priority:'high',percent:.9});
});

test('warn-proceed nudges cross the medium and high thresholds exactly',()=>{
  assert.deepEqual(generateNudges(empty({warnProceeded:4})),[]);
  assert.equal(generateNudges(empty({warnProceeded:5}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({warnProceeded:24}))[0]?.priority,'medium');
  assert.equal(generateNudges(empty({warnProceeded:25}))[0]?.priority,'high');
});

test('nudges order high before medium and use the fixed rule order within each band',()=>{
  const items=generateNudges(empty({pendingApprovals:10,blockedRequests:5,budgetUsedMicroUsd:80,budgetLimitMicroUsd:100,warnProceeded:25}));
  assert.deepEqual(items.map(item=>`${item.priority}:${item.ruleId}`),['high:approvalsPending','high:warnProceed','medium:budgetUtilization','medium:blockedVolume']);
});

test('warn-proceed aggregate is tenant scoped, approved-only, and half-open range bounded',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const tenantId=randomUUID() as TenantId,other=randomUUID() as TenantId,from=100,to=200;
  const insertTenant=database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',0,0)`);
  insertTenant.run(tenantId,'acme','Acme');insertTenant.run(other,'other','Other');
  const insert=database.prepare(`INSERT INTO gate_decisions(id,tenant_id,direction,final_action,status,content_sha256,latency_ms,decided_at) VALUES(?,?,'outbound',?,?,?,0,?)`);
  const decision=(tenant:string,action:string,status:string,at:number)=>insert.run(randomUUID(),tenant,action,status,'a'.repeat(64),at);
  decision(tenantId,'warn','approved',from);decision(tenantId,'warn','approved',to-1);
  decision(tenantId,'warn','approved',from-1);decision(tenantId,'warn','approved',to);
  decision(tenantId,'warn','awaiting_confirmation',150);decision(tenantId,'block','approved',150);
  decision(other,'warn','approved',150);
  assert.equal(warnProceededCount(forTenant({tenantId}),from,to,prepareNudgeStatements(database)),2);
  database.close();
});
