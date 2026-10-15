import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {runMigrations} from '../../lib/migrations/index.js';
import {forTenant} from '../../lib/db.js';
import type {TenantId} from '../../shared/types.js';
import {analyticsTimeseries,prepareAnalyticsStatements} from './analytics.js';
import {adminDashboardSummary,prepareConsoleStatements} from './capabilities.js';

test('analytics and dashboard assign one instant to the workspace calendar day',()=>{
 const database=new Database(':memory:');runMigrations(database);const at=Date.parse('2026-09-27T17:00:00Z'),now=Date.parse('2026-09-29T00:00:00Z');
 const insertTenant=database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)"),insertSettings=database.prepare('INSERT INTO tenant_settings(tenant_id,timezone,updated_at) VALUES(?,?,?)'),insertUsage=database.prepare("INSERT INTO usage_records(id,tenant_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,status) VALUES(?,?,'openai','gpt-5',10,5,100,?,'success')");
 const cases=[['Asia/Taipei','2026-09-28'],['America/New_York','2026-09-27']] as const;
 const analytics=prepareAnalyticsStatements(database),consoleStatements=prepareConsoleStatements(database);
 for(const [index,[timeZone,expected]] of cases.entries()){
  const tenantId=randomUUID() as TenantId;insertTenant.run(tenantId,`tenant-${index}`,`Tenant ${index}`,now,now);insertSettings.run(tenantId,timeZone,now);insertUsage.run(randomUUID(),tenantId,at);const tenant=forTenant({tenantId});
  const analyticsPoint=analyticsTimeseries(tenant,{range:'7d'},analytics,()=>now).items.find(point=>point.requests===1);assert.equal(analyticsPoint?.bucket,expected);
  const dashboardPoint=adminDashboardSummary(tenant,{fromMs:now-7*86_400_000,toMs:now,nowMs:now},consoleStatements).usage.find(point=>point.requests===1);assert.equal(dashboardPoint?.bucket,expected);
 }
 database.close();
});
