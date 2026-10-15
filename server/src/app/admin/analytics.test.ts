import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { analyticsBreakdown, analyticsDetectors, analyticsTimeseries, prepareAnalyticsStatements, type AnalyticsBreakdownItem } from './analytics.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { TenantDb } from '../../lib/db.js';
import type { TenantId } from '../../shared/types.js';

const NOW=Date.UTC(2026,7,9,15,30,0);
const HOUR=3_600_000;

function fixture() {
  const database=new Database(':memory:'); runMigrations(database);
  const tenantId=randomUUID() as TenantId,otherTenantId=randomUUID() as TenantId;
  const ada=randomUUID(),grace=randomUUID(),turbo=randomUUID(),sonnet=randomUUID(),conversation=randomUUID();
  const flagged=randomUUID(),flaggedAssistant=randomUUID(),allowed=randomUUID(),quiet=randomUUID();
  const tenant=database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Acme','active',?,?)`);
  tenant.run(tenantId,'acme',NOW,NOW); tenant.run(otherTenantId,'rival',NOW,NOW);
  const user=database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)`);
  user.run(ada,tenantId,'ada@acme.test','Ada Lovelace',NOW,NOW); user.run(grace,tenantId,'grace@acme.test','Grace Hopper',NOW,NOW);
  const model=database.prepare(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at) VALUES(?,?,?,?,?,1000,1000,1,1,?,?)`);
  model.run(turbo,tenantId,'openai','gpt-5','GPT-5 Turbo',NOW,NOW); model.run(sonnet,tenantId,'anthropic','sonnet-4','Claude Sonnet',NOW,NOW);
  database.prepare(`INSERT INTO conversations(id,tenant_id,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)`).run(conversation,tenantId,ada,NOW,NOW);
  const message=database.prepare(`INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,?,?,'complete',?,?)`);
  message.run(flagged,tenantId,conversation,null,ada,'user',0,NOW);message.run(flaggedAssistant,tenantId,conversation,flagged,null,'assistant',1,NOW);message.run(allowed,tenantId,conversation,null,ada,'user',2,NOW);message.run(quiet,tenantId,conversation,null,ada,'user',3,NOW);
  const usage=database.prepare(`INSERT INTO usage_records(id,tenant_id,user_id,conversation_id,message_id,model_catalog_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,completed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  usage.run(randomUUID(),tenantId,ada,conversation,flaggedAssistant,turbo,'openai','gpt-5',100,50,1500,NOW-2*HOUR,NOW-2*HOUR+1200,'success');
  usage.run(randomUUID(),tenantId,ada,conversation,allowed,turbo,'openai','gpt-5',10,5,200,NOW-3*HOUR,NOW-3*HOUR+400,'failed');
  usage.run(randomUUID(),tenantId,grace,null,null,sonnet,'anthropic','sonnet-4',40,20,900,NOW-26*HOUR,NOW-26*HOUR+900,'success');
  usage.run(randomUUID(),tenantId,grace,conversation,quiet,turbo,'openai','gpt-5',7,3,70,NOW-50*HOUR,null,'success');
  usage.run(randomUUID(),otherTenantId,null,null,null,null,'openai','gpt-5',9_000,9_000,9_000_000,NOW-2*HOUR,NOW-2*HOUR+50,'success');
  const decision=database.prepare(`INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,decided_at) VALUES(?,?,?,?,?,'outbound',?,'final',?,'[]',?,12,?)`);
  decision.run(randomUUID(),tenantId,ada,conversation,flagged,'block','a'.repeat(64),'["pii"]',NOW-2*HOUR);
  decision.run(randomUUID(),tenantId,ada,conversation,flagged,'redact','b'.repeat(64),'["secret"]',NOW-2*HOUR);
  decision.run(randomUUID(),tenantId,ada,conversation,allowed,'allow','c'.repeat(64),'[]',NOW-3*HOUR);
  const scope=(id:TenantId):TenantDb=>({tenantId:id,get:(statement,...params)=>statement.get(id,...params),all:(statement,...params)=>statement.all(id,...params),run:(statement,...params)=>statement.run(id,...params)});
  return {database,statements:prepareAnalyticsStatements(database),tenant:scope(tenantId),other:scope(otherTenantId),tenantId,otherTenantId,conversation,ada,grace,turbo};
}
const at=()=>NOW;
const named=(items:AnalyticsBreakdownItem[],label:string):AnalyticsBreakdownItem=>{const found=items.find(item=>item.label===label); assert.ok(found,`missing ${label}`); return found};

test('detectors ranks bounded matches, limits results, and isolates the tenant and range',()=>{
  const f=fixture();
  const insert=f.database.prepare(`INSERT INTO gate_decisions(id,tenant_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,decided_at) VALUES(?,?,'outbound','flag','final',?,'[]',?,1,?)`);
  insert.run(randomUUID(),f.tenantId,'d'.repeat(64),JSON.stringify(['pii','secret',...Array.from({length:12},(_,index)=>`detector-${String(index).padStart(2,'0')}`)]),NOW-HOUR);
  insert.run(randomUUID(),f.tenantId,'e'.repeat(64),'[]',NOW-HOUR);
  insert.run(randomUUID(),f.tenantId,'f'.repeat(64),'["pii"]',NOW-31*24*HOUR);
  insert.run(randomUUID(),f.otherTenantId,'0'.repeat(64),'["foreign","pii"]',NOW-HOUR);
  const items=analyticsDetectors(f.tenant,{},f.statements,at).items;
  assert.equal(items.length,12);
  assert.deepEqual(items.slice(0,2),[{label:'pii',value:2},{label:'secret',value:2}]);
  assert.deepEqual(items.slice(2).map(item=>item.label),Array.from({length:10},(_,index)=>`detector-${String(index).padStart(2,'0')}`));
  assert.ok(!items.some(item=>item.label==='foreign'));
  assert.deepEqual(analyticsDetectors(f.other,{},f.statements,at).items,[{label:'foreign',value:1},{label:'pii',value:1}]);
  f.database.close();
});

test('timeseries fills every workspace day and never crosses tenants',()=>{
  const f=fixture();
  const {items}=analyticsTimeseries(f.tenant,{},f.statements,at);
  assert.equal(items.length,31);assert.equal(items[0]?.bucket,'2026-07-10');assert.equal(items.at(-1)?.bucket,'2026-08-09');
  const today=items.find(point=>point.bucket==='2026-08-09')!;
  assert.equal(today.requests,2); assert.equal(today.activeUsers,1);
  assert.equal(today.inputTokens,110); assert.equal(today.outputTokens,55); assert.equal(today.totalTokens,165);
  assert.equal(today.spendMicroUsd,1700); assert.equal(today.errors,1); assert.equal(today.errorRate,0.5);
  assert.equal(today.value,2); assert.equal(today.bucketStartMs,Date.UTC(2026,7,9));
  assert.equal(items.reduce((sum,point)=>sum+point.spendMicroUsd,0),2670);
  const empty=items.find(point=>point.bucket==='2026-07-10')!;
  assert.deepEqual({requests:empty.requests,activeUsers:empty.activeUsers,inputTokens:empty.inputTokens,outputTokens:empty.outputTokens,totalTokens:empty.totalTokens,spendMicroUsd:empty.spendMicroUsd,errors:empty.errors,errorRate:empty.errorRate,violations:empty.violations,violationRate:empty.violationRate,value:empty.value},{requests:0,activeUsers:0,inputTokens:0,outputTokens:0,totalTokens:0,spendMicroUsd:0,errors:0,errorRate:0,violations:0,violationRate:0,value:0});
  assert.equal(analyticsTimeseries(f.other,{},f.statements,at).items.find(point=>point.bucket==='2026-08-09')?.spendMicroUsd,9_000_000);
  f.database.close();
});

test('timeseries honours the granularity filter inside the requested range',()=>{
  const f=fixture();
  const response=analyticsTimeseries(f.tenant,{range:'24h',granularity:'hour'},f.statements,at),{items}=response;
  assert.equal(response.granularity,'hour');
  assert.equal(items.length,25);assert.deepEqual(items.filter(point=>point.requests>0).map(point=>[point.bucket,point.requests]),[['2026-08-09T12:00+00:00',1],['2026-08-09T13:00+00:00',1]]);
  assert.deepEqual(analyticsTimeseries(f.tenant,{granularity:'month'},f.statements,at).items.map(point=>point.bucket),['2026-07','2026-08']);
  // Sunday 2026-08-09 belongs to the week that opened on Monday 2026-08-03, not to the next one.
  assert.deepEqual(analyticsTimeseries(f.tenant,{granularity:'week'},f.statements,at).items.filter(point=>point.requests>0).map(point=>[point.bucket,point.requests]),[['2026-08-03',4]]);
  assert.throws(()=>analyticsTimeseries(f.tenant,{granularity:'fortnight'},f.statements,at),/granularity must be one of/u);
  assert.throws(()=>analyticsTimeseries(f.tenant,{range:'all'},f.statements,at),/range must be one of/u);
  f.database.close();
});

test('breakdown aggregates each dimension with real latency percentiles',()=>{
  const f=fixture();
  const {items}=analyticsBreakdown(f.tenant,{dimension:'model'},f.statements,at);
  assert.deepEqual(items.map(item=>item.dimension),['GPT-5 Turbo','Claude Sonnet']);
  const primary=items[0]!;
  assert.equal(primary.id,f.turbo); assert.equal(primary.requests,3); assert.equal(primary.activeUsers,2);
  assert.equal(primary.inputTokens,117); assert.equal(primary.outputTokens,58); assert.equal(primary.spendMicroUsd,1770);
  assert.equal(primary.value,1770); assert.equal(primary.errors,1); assert.equal(primary.errorRate,1/3);
  // The third GPT-5 request never completed, so it must not drag the average toward zero.
  assert.equal(primary.averageLatencyMs,800); assert.equal(primary.p95LatencyMs,1200);
  assert.equal(named(items,'Claude Sonnet').p95LatencyMs,900);
  const byUser=analyticsBreakdown(f.tenant,{dimension:'user'},f.statements,at).items;
  assert.deepEqual(byUser.map(item=>[item.id,item.dimension,item.requests]),[[f.ada,'Ada Lovelace',2],[f.grace,'Grace Hopper',2]]);
  f.database.close();
});

test('breakdown attributes violations through message_id and returns null when unlinked',()=>{
  const f=fixture();
  const items=analyticsBreakdown(f.tenant,{dimension:'provider'},f.statements,at).items;
  const openai=named(items,'openai');
  assert.equal(openai.violations,2); assert.equal(openai.violationRate,2/3);
  const anthropic=named(items,'anthropic');
  assert.equal(anthropic.violations,null); assert.equal(anthropic.violationRate,null);
  const days=analyticsTimeseries(f.tenant,{},f.statements,at).items;
  assert.equal(days.find(point=>point.bucket==='2026-08-08')!.violations,null); assert.equal(days.find(point=>point.bucket==='2026-08-09')!.violations,2); assert.equal(days.find(point=>point.bucket==='2026-08-09')!.violationRate,1);
  f.database.close();
});

test('assistant attribution follows only a same-tenant same-conversation user parent',()=>{
  const f=fixture(),foreignConversation=randomUUID(),foreignParent=randomUUID(),assistant=randomUUID();
  f.database.prepare("INSERT INTO conversations(id,tenant_id,title,status,created_at,updated_at) VALUES(?,?,'Other thread','active',?,?)").run(foreignConversation,f.tenantId,NOW,NOW);
  f.database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,role,status,sequence_no,created_at) VALUES(?,?,?,'user','complete',0,?)").run(foreignParent,f.tenantId,foreignConversation,NOW);
  f.database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,role,status,sequence_no,model_catalog_id,provider_key,created_at) VALUES(?,?,?,?,'assistant','complete',4,?,'openai',?)").run(assistant,f.tenantId,f.conversation,foreignParent,f.turbo,NOW);
  f.database.prepare("INSERT INTO usage_records(id,tenant_id,user_id,conversation_id,message_id,model_catalog_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,completed_at,status) VALUES(?,?,?,?,?,?,'openai','gpt-5',1,1,1,?,?,'success')").run(randomUUID(),f.tenantId,f.ada,f.conversation,assistant,f.turbo,NOW-2*HOUR,NOW-2*HOUR+1);
  f.database.prepare("INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,decided_at) VALUES(?,?,?,?,?,'outbound','block','final',?,'[]','[]',1,?)").run(randomUUID(),f.tenantId,f.ada,f.conversation,foreignParent,'d'.repeat(64),NOW-2*HOUR);
  assert.equal(named(analyticsBreakdown(f.tenant,{dimension:'provider'},f.statements,at).items,'openai').violations,2);
  f.database.close();
});

test('breakdown filters by verdict, detector, and the searched dimension label',()=>{
  const f=fixture();
  const blocked=analyticsBreakdown(f.tenant,{dimension:'model',verdict:'block'},f.statements,at).items;
  assert.deepEqual(blocked.map(item=>[item.dimension,item.requests]),[['GPT-5 Turbo',1]]);
  const secrets=analyticsBreakdown(f.tenant,{dimension:'provider',detector:'secret'},f.statements,at).items;
  assert.deepEqual(secrets.map(item=>[item.dimension,item.requests]),[['openai',1]]);
  assert.deepEqual(analyticsBreakdown(f.tenant,{search:'sonnet'},f.statements,at).items.map(item=>item.dimension),['Claude Sonnet']);
  assert.deepEqual(analyticsBreakdown(f.tenant,{dimension:'model',status:'failed'},f.statements,at).items.map(item=>item.requests),[1]);
  assert.deepEqual(analyticsBreakdown(f.tenant,{dimension:'model',model:'sonnet-4'},f.statements,at).items.map(item=>item.dimension),['Claude Sonnet']);
  f.database.close();
});

test('breakdown sorts by the requested column and direction',()=>{
  const f=fixture();
  // Latency is the one column whose order differs from both the busiest-first default and the
  // alphabetical tiebreak, so it is the only sort that can actually prove the ordering is applied.
  assert.deepEqual(analyticsBreakdown(f.tenant,{},f.statements,at).items.map(item=>item.dimension),['GPT-5 Turbo','Claude Sonnet']);
  assert.deepEqual(analyticsBreakdown(f.tenant,{sort:'averageLatencyMs'},f.statements,at).items.map(item=>item.dimension),['Claude Sonnet','GPT-5 Turbo']);
  assert.deepEqual(analyticsBreakdown(f.tenant,{sort:'averageLatencyMs',direction:'asc'},f.statements,at).items.map(item=>item.dimension),['GPT-5 Turbo','Claude Sonnet']);
  assert.throws(()=>analyticsBreakdown(f.tenant,{sort:'; DROP TABLE usage_records'},f.statements,at),/sort must be one of/u);
  f.database.close();
});

test('breakdown paginates behind a capped limit and an opaque cursor',()=>{
  const f=fixture();
  const first=analyticsBreakdown(f.tenant,{limit:'1'},f.statements,at);
  assert.equal(first.items.length,1); assert.equal(first.hasMore,true); assert.ok(first.nextCursor);
  const second=analyticsBreakdown(f.tenant,{limit:'1',cursor:first.nextCursor!},f.statements,at);
  assert.deepEqual(second.items.map(item=>item.dimension),['Claude Sonnet']);
  assert.equal(second.hasMore,false); assert.equal(second.nextCursor,null);
  assert.throws(()=>analyticsBreakdown(f.tenant,{limit:'501'},f.statements,at),/limit must be 1\.\.500/u);
  assert.throws(()=>analyticsBreakdown(f.tenant,{limit:'0'},f.statements,at),/limit must be 1\.\.500/u);
  assert.throws(()=>analyticsBreakdown(f.tenant,{cursor:'not-a-cursor'},f.statements,at),/valid analytics cursor/u);
  f.database.close();
});
