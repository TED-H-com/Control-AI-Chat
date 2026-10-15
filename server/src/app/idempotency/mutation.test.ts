import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { forTenant } from '../../lib/db.js';
import type { AuditService } from '../../lib/audit/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest } from '../../routes/types.js';
import type { RequestPrincipal, TenantId } from '../../shared/types.js';
import { createDurableMutationIdempotency, MutationIdempotencyError } from './mutation.js';


test('side-effect-free async results recheck races and durably replay the first completed result',async()=>{
  const f=fixture(false),key='async-result',request=f.request(f.tenantA,f.actorA,key,{sample:'one'});
  let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve}),workStarted=new Promise<void>(resolve=>{started=resolve});
  const slower=f.service.executeSideEffectFree('rule.test',request,async()=>{calls++;started();await gate;return{body:{winner:'slow'}}});
  await workStarted;
  const faster=await f.service.executeSideEffectFree('rule.test',request,async()=>{calls++;return{body:{winner:'fast'}}});
  release();
  assert.deepEqual(await slower,faster,'the slower computation must replay the result that won the insert race');
  const replay=await f.service.executeSideEffectFree('rule.test',request,async()=>{calls++;return{body:{winner:'late'}}});
  assert.deepEqual(replay,faster);assert.equal(calls,2);
  await assert.rejects(f.service.executeSideEffectFree('rule.test',f.request(f.tenantA,f.actorA,key,{sample:'changed'}),async()=>({body:{}})),
    (error:unknown)=>error instanceof MutationIdempotencyError&&error.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM idempotency_records').pluck().get(),1);
  f.database.close();
});
const AT=1_700_000_000_000;

function fixture(encrypted:boolean) {
  const database=new Database(':memory:');runMigrations(database);
  const tenantA=randomUUID() as TenantId,tenantB=randomUUID() as TenantId;
  const actorA=randomUUID(),actorB=randomUUID(),actorC=randomUUID();
  const insertTenant=database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)");
  insertTenant.run(tenantA,'acme','Acme',AT,AT);insertTenant.run(tenantB,'bravo','Bravo',AT,AT);
  const insertUser=database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)");
  insertUser.run(actorA,tenantA,'a@acme.test','A',AT,AT);insertUser.run(actorB,tenantA,'b@acme.test','B',AT,AT);insertUser.run(actorC,tenantB,'c@bravo.test','C',AT,AT);
  const audit={transact:<T>(work:Parameters<AuditService['transact']>[0])=>database.transaction(()=>work({append:()=>{throw new Error('unused')}})).immediate()} as Pick<AuditService,'transact'>;
  const service=createDurableMutationIdempotency({database,audit,hmacKey:Buffer.alloc(32,1),...(encrypted?{responseEncryptionKey:Buffer.alloc(32,2)}:{}),namespace:'test-mutation',now:()=>AT});
  const request=(tenantId:TenantId,userId:string,key:string,body:unknown):RouteRequest=>{
    const principal:RequestPrincipal={tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set()};
    return {tenant:{principal,db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(AT)},requestId:randomUUID(),params:{},query:{},headers:new Headers({'Idempotency-Key':key}),body,rawBody:null};
  };
  return {database,service,request,tenantA,tenantB,actorA,actorB,actorC};
}

test('unencrypted durable mutation keeps the legacy response JSON and key boundary',()=>{
  const f=fixture(false),key='k'.repeat(128),request=f.request(f.tenantA,f.actorA,key,{value:1});
  let calls=0;
  const first=f.service.execute('item.create',request,()=>{calls++;return {status:201,body:{id:'one'}}});
  const replay=f.service.execute('item.create',request,()=>{calls++;return {status:202,body:{id:'two'}}});
  assert.deepEqual(replay,first);assert.equal(calls,1);
  const stored=f.database.prepare('SELECT response_json FROM idempotency_records').pluck().get();
  assert.equal(stored,JSON.stringify({status:201,body:{id:'one'}}));
  const tooLong=f.request(f.tenantA,f.actorA,'k'.repeat(129),{value:2});
  assert.throws(()=>f.service.execute('item.create',tooLong,()=>({status:201})),(error:unknown)=>error instanceof MutationIdempotencyError&&error.status===400);
  f.database.close();
});

test('encrypted durable mutation replays exact headers and fails closed on request or envelope changes',()=>{
  const f=fixture(true),key='sealed-response',token='A'.repeat(43),activationUrl=`https://app.gateway.test/auth/password/reset#${token}`;
  const request=f.request(f.tenantA,f.actorA,key,{email:'invite@acme.test'});
  let calls=0;
  const first=f.service.execute('invite.create',request,()=>{calls++;return {status:201,headers:{'Cache-Control':'no-store','Pragma':'no-cache'},body:{activationUrl}}});
  const replay=f.service.execute('invite.create',request,()=>{calls++;throw new Error('must not execute')});
  assert.deepEqual(replay,first);assert.deepEqual(replay.headers,{'Cache-Control':'no-store','Pragma':'no-cache'});assert.equal(calls,1);

  const stored=f.database.prepare('SELECT response_json FROM idempotency_records').pluck().get() as string;
  const envelope=JSON.parse(stored) as {version:number;algorithm:string;nonce:string;ciphertext:string};
  assert.deepEqual({version:envelope.version,algorithm:envelope.algorithm},{version:1,algorithm:'A256GCM'});
  assert.equal(Buffer.from(envelope.nonce,'base64url').byteLength,12);assert.ok(Buffer.from(envelope.ciphertext,'base64url').byteLength>16);
  assert.doesNotMatch(stored,/activationUrl|password\/reset/);assert.ok(!stored.includes(token));
  const bytes=f.database.serialize();assert.ok(!bytes.includes(token));assert.ok(!bytes.includes(activationUrl));

  const changed=f.request(f.tenantA,f.actorA,key,{email:'different@acme.test'});
  assert.throws(()=>f.service.execute('invite.create',changed,()=>{calls++;return {status:201}}),(error:unknown)=>error instanceof MutationIdempotencyError&&error.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(calls,1);

  envelope.ciphertext=`${envelope.ciphertext[0]==='A'?'B':'A'}${envelope.ciphertext.slice(1)}`;
  f.database.prepare('UPDATE idempotency_records SET response_json=?').run(JSON.stringify(envelope));
  assert.throws(()=>f.service.execute('invite.create',request,()=>{calls++;return {status:201}}),(error:unknown)=>error instanceof MutationIdempotencyError&&error.status===409&&error.message==='The original idempotent response is unavailable');
  assert.equal(calls,1);f.database.close();
});

test('the same idempotency key is isolated by both actor and tenant',()=>{
  const f=fixture(true),key='shared-key';let calls=0;
  const execute=(tenantId:TenantId,actorId:string)=>f.service.execute('item.create',f.request(tenantId,actorId,key,{value:1}),()=>({status:201,body:{call:++calls}}));
  assert.deepEqual(execute(f.tenantA,f.actorA),{status:201,body:{call:1}});
  assert.deepEqual(execute(f.tenantA,f.actorA),{status:201,body:{call:1}});
  assert.deepEqual(execute(f.tenantA,f.actorB),{status:201,body:{call:2}});
  assert.deepEqual(execute(f.tenantB,f.actorC),{status:201,body:{call:3}});
  assert.equal(calls,3);assert.equal(f.database.prepare('SELECT COUNT(*) FROM idempotency_records').pluck().get(),3);
  const actorAEnvelope=f.database.prepare('SELECT response_json FROM idempotency_records WHERE tenant_id=? AND actor_user_id=?').pluck().get(f.tenantA,f.actorA) as string;
  f.database.prepare('UPDATE idempotency_records SET response_json=? WHERE tenant_id=? AND actor_user_id=?').run(actorAEnvelope,f.tenantA,f.actorB);
  assert.throws(()=>execute(f.tenantA,f.actorB),(error:unknown)=>error instanceof MutationIdempotencyError&&error.message==='The original idempotent response is unavailable','AAD must reject an envelope copied to another actor');
  assert.equal(calls,3);
  f.database.close();
});

test('response encryption requires an AES-256 key',()=>{
  const f=fixture(false);
  assert.throws(()=>createDurableMutationIdempotency({database:f.database,audit:{transact:work=>work({append:()=>{throw new Error('unused')}})},hmacKey:Buffer.alloc(32),responseEncryptionKey:Buffer.alloc(31),namespace:'invalid-key'}),/must be 32 bytes/);
  f.database.close();
});

test('durable mutation samples the clock after acquiring the write lock and not at all on replay',()=>{
  const f=fixture(false);
  let clock=AT,nowCalls=0;
  const now=()=>{nowCalls+=1;clock+=1;return clock;};
  const lockWait=5_000;
  const audit={transact:<T>(work:Parameters<AuditService['transact']>[0])=>{
    clock+=lockWait;
    return f.database.transaction(()=>work({append:()=>{throw new Error('unused')}})).immediate();
  }} as Pick<AuditService,'transact'>;
  const service=createDurableMutationIdempotency({database:f.database,audit,hmacKey:Buffer.alloc(32,1),namespace:'test-mutation',now});
  const request=f.request(f.tenantA,f.actorA,'lock-clock',{value:1});
  const preLock=clock+1;
  let observedAt=0;
  const first=service.execute('item.create',request,(_tx,at)=>{observedAt=at;return {status:201,body:{id:'one'}}});
  const postLock=preLock+lockWait;
  assert.equal(observedAt,postLock);
  assert.notEqual(observedAt,preLock);
  assert.equal(nowCalls,1);
  const stored=f.database.prepare('SELECT created_at,updated_at,completed_at FROM idempotency_records').get() as {created_at:number;updated_at:number;completed_at:number};
  assert.deepEqual(stored,{created_at:postLock,updated_at:postLock,completed_at:postLock});
  const replay=service.execute('item.create',request,(_tx,at)=>{observedAt=at;return {status:202,body:{id:'two'}}});
  assert.deepEqual(replay,first);
  assert.equal(nowCalls,1,'replay must not sample the clock');
  f.database.close();
});

test('dispatched prepare claims before work so another instance cannot start a second dispatch',async()=>{
  const f=fixture(false),request=f.request(f.tenantA,f.actorA,'dispatch-once',{url:'https://example.test'});
  const other=createDurableMutationIdempotency({database:f.database,audit:{transact:work=>f.database.transaction(()=>work({append:()=>{throw new Error('unused')}})).immediate()} as Pick<AuditService,'transact'>,hmacKey:Buffer.alloc(32,1),namespace:'test-mutation',now:()=>AT});
  let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve}),workStarted=new Promise<void>(resolve=>{started=resolve});
  const first=f.service.executeDispatched('item.dispatch',request,async()=>{calls++;started();await gate;return()=>({status:200,body:{id:'one'}})});
  await workStarted;
  await assert.rejects(other.executeDispatched('item.dispatch',request,async()=>{calls++;return()=>({status:200,body:{id:'two'}})}),
    (error:unknown)=>error instanceof MutationIdempotencyError&&error.code==='CONFLICT');
  assert.equal(calls,1);
  assert.equal(f.database.prepare("SELECT status FROM idempotency_records").pluck().get(),'claimed');
  release();
  assert.deepEqual(await first,{status:200,body:{id:'one'}});
  const replay=await other.executeDispatched('item.dispatch',request,async()=>{calls++;return()=>({status:200,body:{id:'late'}})});
  assert.deepEqual(replay,{status:200,body:{id:'one'}});assert.equal(calls,1);
  f.database.close();
});

test('dispatched same-instance retries share one prepare and replay the completed receipt',async()=>{
  const f=fixture(false),request=f.request(f.tenantA,f.actorA,'dispatch-share',{url:'https://example.test'});
  let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve}),workStarted=new Promise<void>(resolve=>{started=resolve});
  const first=f.service.executeDispatched('item.dispatch',request,async()=>{calls++;started();await gate;return()=>({status:200,body:{id:'shared'}})});
  await workStarted;
  const joined=f.service.executeDispatched('item.dispatch',request,async()=>{calls++;return()=>({status:200,body:{id:'other'}})});
  release();
  assert.deepEqual(await first,await joined);assert.equal(calls,1);
  f.database.close();
});

test('a stale dispatched claim can be reclaimed and a refusal does not keep the key',async()=>{
  let clock=AT;
  const f=fixture(false);
  const audit={transact:work=>f.database.transaction(()=>work({append:()=>{throw new Error('unused')}})).immediate()} as Pick<AuditService,'transact'>;
  const service=createDurableMutationIdempotency({database:f.database,audit,hmacKey:Buffer.alloc(32,1),namespace:'test-mutation',now:()=>clock,claimTtlMs:1_000});
  const request=f.request(f.tenantA,f.actorA,'stale-claim',{url:'https://example.test'});
  service.execute('item.dispatch',request,()=>({status:200,body:{id:'seed'}}));
  f.database.prepare("UPDATE idempotency_records SET status='claimed',response_json=NULL,completed_at=NULL,updated_at=? WHERE tenant_id=? AND idempotency_key='stale-claim'").run(AT,f.tenantA);
  clock=AT+1_001;let calls=0;
  const recovered=await service.executeDispatched('item.dispatch',request,async()=>{calls++;return()=>({status:200,body:{id:'reclaimed'}})});
  assert.deepEqual(recovered,{status:200,body:{id:'reclaimed'}});assert.equal(calls,1);
  const refused=await service.executeDispatched('item.dispatch',f.request(f.tenantA,f.actorA,'refused',{url:'https://example.test/other'}),async()=>(()=>({status:422,body:{error:'no'}})));
  assert.equal(refused.status,422);
  assert.equal(f.database.prepare("SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key='refused'").pluck().get(),0);
  f.database.close();
});
