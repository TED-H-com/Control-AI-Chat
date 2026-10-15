import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import { budgetWindowBounds } from '../../lib/governance/windows.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest } from '../../routes/types.js';
import type { RequestPrincipal, TenantId } from '../../shared/api.js';
import { createMyBudgetReader, type MyBudget } from './me.js';

const AT=Date.UTC(2026,7,9,12,0,0);

function fixture(){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,otherTenantId=randomUUID() as TenantId,user=randomUUID(),outsider=randomUUID(),groupId=randomUUID();
  for(const [id,slug] of [[tenantId,'budget-test'],[otherTenantId,'budget-other']] as const)
    database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(id,slug,slug,AT,AT);
  for(const [id,tenant] of [[user,tenantId],[outsider,tenantId]] as const)
    database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'h','active',?,?)").run(id,tenant,`${id}@example.test`,'Person',AT,AT);
  database.prepare("INSERT INTO groups(id,tenant_id,name,is_system,created_at,updated_at) VALUES(?,?,'Engineering',0,?,?)").run(groupId,tenantId,AT,AT);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,user,AT);
  const budget=(tenant:string,scope:'tenant'|'group'|'user',scopeId:string|null,period:'daily'|'monthly',soft:number|null,hard:number):string=>{
    const id=randomUUID();
    database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,?,?,?,'usd',?,?,'UTC',1,?,?)")
      .run(id,tenant,scope,scopeId,period,soft,hard,AT,AT);
    return id;
  };
  const ledger=(tenant:string,budgetId:string,kind:'settle'|'reserve'|'release',amount:number,period:'daily'|'monthly'):void=>{
    const bounds=budgetWindowBounds(AT,period,'UTC');
    database.prepare("INSERT INTO budget_ledger(id,tenant_id,budget_id,usage_record_id,reservation_key,kind,amount,period_start,period_end,created_at) VALUES(?,?,?,NULL,NULL,?,?,?,?,?)")
      .run(randomUUID(),tenant,budgetId,kind,amount,bounds.start,bounds.end,AT);
  };
  const reader=createMyBudgetReader({database,now:()=>AT});
  const request=(userId:string,tenant=tenantId):RouteRequest=>{
    const principal:RequestPrincipal={tenantId:tenant,userId,membershipId:userId,roles:['member'],permissions:new Set(['chat:use']),sessionId:randomUUID()};
    return {tenant:{principal,db:forTenant({tenantId:tenant}),requestId:randomUUID(),now:new Date(AT)},requestId:randomUUID(),params:{},query:{},headers:new Headers(),body:null,rawBody:null};
  };
  return {database,reader,request,budget,ledger,tenantId,otherTenantId,user,outsider,groupId};
}

const items=(result:{body?:unknown}):MyBudget[]=>(result.body as {items:MyBudget[]}).items;

test('a user sees the tenant, group and personal caps that apply to them, worst first',()=>{
  const f=fixture();
  const tenantBudget=f.budget(f.tenantId,'tenant',null,'monthly',null,1_000_000);
  const groupBudget=f.budget(f.tenantId,'group',f.groupId,'monthly',null,500_000);
  const mine=f.budget(f.tenantId,'user',f.user,'daily',80_000,100_000);
  const someoneElse=f.budget(f.tenantId,'user',f.outsider,'daily',null,100_000);
  const otherGroup=f.budget(f.tenantId,'group',randomUUID(),'monthly',null,100_000);
  f.ledger(f.tenantId,tenantBudget,'settle',100_000,'monthly');
  f.ledger(f.tenantId,groupBudget,'settle',250_000,'monthly');
  f.ledger(f.tenantId,mine,'settle',85_000,'daily');
  const rows=items(f.reader.execute('budgets.me',f.request(f.user)));
  assert.deepEqual(rows.map(row=>row.id),[mine,groupBudget,tenantBudget],'85%, 50% then 10% -- and neither the outsider\'s cap nor a group they are not in');
  assert.ok(!rows.some(row=>row.id===someoneElse||row.id===otherGroup));
  assert.deepEqual(rows.map(row=>row.utilizationBasisPoints),[8500,5000,1000]);
  assert.deepEqual(rows.map(row=>row.state),['warning','ok','ok']);
  assert.deepEqual(rows.map(row=>row.remaining),[15_000,250_000,900_000]);
  f.database.close();
});

test('an outstanding reservation is spent, not headroom',()=>{
  const f=fixture();
  const mine=f.budget(f.tenantId,'user',f.user,'daily',null,100_000);
  f.ledger(f.tenantId,mine,'settle',40_000,'daily');
  f.ledger(f.tenantId,mine,'reserve',50_000,'daily');
  const [row]=items(f.reader.execute('budgets.me',f.request(f.user)));
  assert.equal(row!.used,40_000);assert.equal(row!.reserved,50_000);
  assert.equal(row!.remaining,10_000,'a run already holding 50,000 must not be offered as headroom');
  assert.equal(row!.utilizationBasisPoints,9000);
  // Release the reservation and the headroom comes back: the ledger nets reserve against release.
  f.ledger(f.tenantId,mine,'release',50_000,'daily');
  const [after]=items(f.reader.execute('budgets.me',f.request(f.user)));
  assert.equal(after!.reserved,0);assert.equal(after!.remaining,60_000);
  f.database.close();
});

test('an exhausted budget reports no negative headroom',()=>{
  const f=fixture();
  const mine=f.budget(f.tenantId,'user',f.user,'daily',null,100_000);
  f.ledger(f.tenantId,mine,'settle',140_000,'daily');
  const [row]=items(f.reader.execute('budgets.me',f.request(f.user)));
  assert.equal(row!.state,'exhausted');
  assert.equal(row!.remaining,0,'an over-spent window is a real state; negative headroom reads as a bug');
  assert.equal(row!.utilizationBasisPoints,10_000,'utilisation is capped so a progress bar cannot overflow');
  f.database.close();
});

test('budgets do not cross tenants',()=>{
  const f=fixture();
  f.budget(f.tenantId,'tenant',null,'monthly',null,1_000_000);
  const stranger=randomUUID();
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Stranger','h','active',?,?)").run(stranger,f.otherTenantId,'stranger@example.test',AT,AT);
  assert.deepEqual(items(f.reader.execute('budgets.me',f.request(stranger,f.otherTenantId))),[]);
  f.database.close();
});

test('a disabled budget stops applying without being deleted',()=>{
  const f=fixture();
  const mine=f.budget(f.tenantId,'user',f.user,'daily',null,100_000);
  assert.equal(items(f.reader.execute('budgets.me',f.request(f.user))).length,1);
  f.database.prepare('UPDATE budgets SET enabled=0 WHERE id=?').run(mine);
  assert.deepEqual(items(f.reader.execute('budgets.me',f.request(f.user))),[]);
  f.database.close();
});
