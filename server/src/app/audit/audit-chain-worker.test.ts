import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import type {TenantId} from '../../shared/types.js';
import {AuditChainUnavailableError,createAuditService} from '../../lib/audit/index.js';
import {runMigrations} from '../../lib/migrations/index.js';
import * as workers from './workers.js';

const AT=1_800_000_000_000;
const runVerification=(database:Database.Database,now=AT,errors:string[]=[])=>{
  const fn=(workers as unknown as {runAuditChainVerificationMaintenance:(deps:{database:Database.Database;now?:()=>number;logger?:{error(message:string):void}})=>Promise<void>}).runAuditChainVerificationMaintenance;
  return fn({database,now:()=>now,logger:{error(message){errors.push(message);}}});
};
function fixture():{database:Database.Database;tenant:TenantId;other:TenantId;audit:ReturnType<typeof createAuditService>} {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenant=randomUUID() as TenantId,other=randomUUID() as TenantId;
  for(const id of [tenant,other])database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',0,0)").run(id,id,id);
  let now=AT-100;
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:now}),now:()=>now++});
  return{database,tenant,other,audit};
}
function append(f:ReturnType<typeof fixture>,tenantId:TenantId,index:number):void {f.audit.append({tenantId,action:'chat.conversation_created',actor:{type:'user',id:null,sessionId:null,ip:null,userAgent:null,authMethod:'password'},target:{type:'conversation',id:null},outcome:'success',context:{requestId:`request-${index}`,traceId:null,source:'http'},metadata:{mode:'chat',projectId:null}});}

test('tampering marks only its tenant broken, opens one alert, logs, appends nothing, and blocks later appends',async()=>{
  const f=fixture();for(let i=0;i<8;i++){append(f,f.tenant,i);append(f,f.other,i);}
  f.database.prepare("UPDATE audit_events SET metadata_json=json_set(metadata_json,'$.mode','tampered') WHERE tenant_id=? AND sequence=5").run(f.tenant);
  const before=f.database.prepare('SELECT count(*) FROM audit_events').pluck().get();const errors:string[]=[];
  await runVerification(f.database,AT,errors);
  assert.deepEqual(f.database.prepare('SELECT status,break_sequence,break_detected_at_ms FROM audit_chain_heads WHERE tenant_id=?').get(f.tenant),{status:'broken',break_sequence:5,break_detected_at_ms:AT});
  assert.equal(f.database.prepare("SELECT status FROM audit_chain_heads WHERE tenant_id=?").pluck().get(f.other),'healthy');
  // Simulate an operator prematurely clearing only the status. The same durable incident is found
  // on the next tick, and its stable key must not create a second open alert.
  f.database.prepare("UPDATE audit_chain_heads SET status='healthy' WHERE tenant_id=?").run(f.tenant);
  await runVerification(f.database,AT+1,errors);
  assert.equal(f.database.prepare("SELECT count(*) FROM alerts WHERE tenant_id=? AND type='audit_chain_break'").pluck().get(f.tenant),1);
  assert.equal(f.database.prepare('SELECT count(*) FROM audit_events').pluck().get(),before);
  assert.equal(errors.length,2);
  assert.throws(()=>append(f,f.tenant,99),AuditChainUnavailableError);
  f.database.close();
});

test('clean verification advances its cursor and wraps after a complete sweep',async()=>{
  const f=fixture();for(let i=0;i<5_005;i++)append(f,f.tenant,i);
  await runVerification(f.database);
  assert.deepEqual(f.database.prepare('SELECT last_verified_sequence,last_verified_at_ms FROM audit_chain_heads WHERE tenant_id=?').get(f.tenant),{last_verified_sequence:5_000,last_verified_at_ms:null});
  await runVerification(f.database,AT+1);
  assert.deepEqual(f.database.prepare('SELECT status,last_verified_sequence,last_verified_hash,last_verified_at_ms FROM audit_chain_heads WHERE tenant_id=?').get(f.tenant),{status:'healthy',last_verified_sequence:0,last_verified_hash:null,last_verified_at_ms:AT+1});
  f.database.close();
});
