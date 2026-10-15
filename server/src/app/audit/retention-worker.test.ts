import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService, createTenantRetentionPolicy, purgeExpiredConversations, purgeExpiredProjectFiles, type AuditService } from '../../lib/audit/index.js';
import { runRetentionMaintenance } from './workers.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { TenantId } from '../../shared/types.js';
import { createDirectoryReader } from '../admin/directory.js';
import { forTenant } from '../../lib/db.js';

const NOW=Date.UTC(2026,7,10,12),DAY=24*60*60*1_000;
const TENANTS=[
  '11111111-1111-4111-8111-111111111111' as TenantId,
  '22222222-2222-4222-8222-222222222222' as TenantId,
] as const;
// Every runRetentionMaintenance call needs one, so the removals are recorded rather than dropped:
// a test that let the file purge mark rows without touching a blob store would be asserting the
// exact failure this worker must not have.
const blobRecorder=()=>{const removed:string[]=[];return{removed,store:{put:async()=>{},read:async()=>null,remove:async(key:string)=>{removed.push(key)},existsSync:()=>true,removeSync:(key:string)=>{removed.push(key)}}}};
const workerAudit=(database:Database.Database)=>createAuditService({database,ipHmacKey:Buffer.alloc(32,7),transcriptKey:()=>Buffer.alloc(32,8),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW});

function seedTenant(database:Database.Database,tenantId:TenantId,index:number):{approvalId:string;replayId:string} {
  const userId=`${index+3}${String(index+3).repeat(7)}-${String(index+3).repeat(4)}-4${String(index+3).repeat(3)}-8${String(index+3).repeat(3)}-${String(index+3).repeat(12)}`;
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,`tenant-${index}`,`Tenant ${index}`,NOW,NOW);
  database.prepare("INSERT INTO users(tenant_id,id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)").run(tenantId,userId,`user-${index}@example.test`,`User ${index}`,NOW,NOW);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW-10*DAY});
  const event=audit.append({tenantId,action:'gate.approval_requested',actor:{type:'user',id:userId,sessionId:null,ip:null,userAgent:null,authMethod:'password'},target:{type:'approval',id:null},outcome:'pending',context:{requestId:randomUUID(),traceId:null,source:'http',occurredAtMs:NOW-10*DAY},subjectUserId:userId,gateAction:'require_approval',metadata:{}});
  const approvalId=randomUUID(),violationId=randomUUID(),ciphertext=Buffer.from(`payload-${index}`),digest=createHash('sha256').update(ciphertext).digest('hex');
  database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,'outbound','secret','require_approval','high','approved','[]','[REQUIRE_APPROVAL]',?,?,?)`).run(violationId,tenantId,event.id,approvalId,userId,digest,NOW-2*DAY,NOW-2*DAY);
  database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,policy_revision,expires_at_ms,created_at_ms,decided_at_ms,released_at_ms,payload_terminal_at_ms)
    VALUES(?,?,?,?,'released',?,?,2,?,'dek_v2','available',?,?,1,1,?,?,?,?,?)`).run(approvalId,tenantId,violationId,userId,ciphertext,Buffer.alloc(12),digest,Buffer.alloc(48,index+1),Buffer.alloc(12,index+1),NOW-DAY,NOW-3*DAY,NOW-2*DAY,NOW-2*DAY,NOW-2*DAY);
  const replayId=randomUUID();
  database.prepare(`INSERT INTO idempotency_records(id,tenant_id,actor_user_id,method,path,idempotency_key,request_sha256,status,response_json,created_at,updated_at,completed_at)
    VALUES(?,?,?,'POST','/chat/runs',?,?,'completed','{}',?,?,?)`).run(replayId,tenantId,userId,randomUUID(),digest,NOW-2*DAY,NOW-2*DAY,NOW-2*DAY);
  return {approvalId,replayId};
}

function seedConversation(database:Database.Database,tenantId:TenantId,index:number,updatedAt:number,createdAt=updatedAt):{userId:string;conversationId:string;messageId:string} {
  const userId=`${index+5}${String(index+5).repeat(7)}-${String(index+5).repeat(4)}-4${String(index+5).repeat(3)}-8${String(index+5).repeat(3)}-${String(index+5).repeat(12)}`;
  database.prepare("INSERT INTO users(tenant_id,id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)").run(tenantId,userId,`chat-${index}@example.test`,`Chat ${index}`,NOW,NOW);
  const conversationId=randomUUID(),messageId=randomUUID();
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,created_at,updated_at) VALUES(?,?,?,'Customer secret',?,?)").run(conversationId,tenantId,userId,createdAt,updatedAt);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,'user','complete',0,?)").run(messageId,tenantId,conversationId,userId,updatedAt);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','message secret','{}',?)").run(randomUUID(),tenantId,messageId,updatedAt);
  return {userId,conversationId,messageId};
}

function seedFile(database:Database.Database,tenantId:TenantId,userId:string,storageKey:string,createdAt:number,contentPurgedAt:number|null=null):string {
  const project=randomUUID(),file=randomUUID();database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,tenantId,userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt',?,'text/plain',3,?,'ready','file secret',?,?)").run(file,tenantId,project,userId,storageKey,'a'.repeat(64),createdAt,contentPurgedAt);
  return file;
}

test('retention worker uses each tenant policy and cleans final replay records across tenants',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const rows=TENANTS.map((tenant,index)=>seedTenant(database,tenant,index)),seen:TenantId[]=[];
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:tenantId=>{
    seen.push(tenantId);return {tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:tenantId===TENANTS[0]?1:3,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW};
  }});
  assert.deepEqual(seen,[...TENANTS]);
  assert.equal(database.prepare('SELECT payload_purged_at_ms FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(TENANTS[0],rows[0]!.approvalId),NOW);
  assert.equal(database.prepare('SELECT payload_purged_at_ms FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(TENANTS[1],rows[1]!.approvalId),null);
  for(const [index,row] of rows.entries())assert.equal(database.prepare('SELECT 1 FROM idempotency_records WHERE tenant_id=? AND id=?').get(TENANTS[index],row.replayId),undefined);
  database.close();
});

test('conversation retention purges only expired content, preserves rows and foreign keys, and is idempotent',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const expired=seedConversation(database,TENANTS[0],0,NOW-31*DAY),fresh=seedConversation(database,TENANTS[0],1,NOW-29*DAY);
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.deepEqual(database.prepare('SELECT title,content_purged_at FROM conversations WHERE id=?').get(expired.conversationId),{title:'Content purged by retention',content_purged_at:NOW});
  assert.equal(database.prepare('SELECT text_content FROM message_parts WHERE message_id=?').pluck().get(expired.messageId),null);
  assert.deepEqual(database.prepare('SELECT title,content_purged_at FROM conversations WHERE id=?').get(fresh.conversationId),{title:'Customer secret',content_purged_at:null});
  assert.equal(database.prepare('SELECT COUNT(*) FROM conversations WHERE id=?').pluck().get(expired.conversationId),1);
  assert.equal(database.prepare('SELECT COUNT(*) FROM messages WHERE conversation_id=?').pluck().get(expired.conversationId),1);
  assert.deepEqual(database.pragma('foreign_key_check'),[],'every surviving foreign-key reference remains valid');
  const events=()=>database.prepare("SELECT metadata_json FROM audit_events WHERE action='system.retention_purged'").pluck().all() as string[];
  assert.deepEqual(events().map(value=>JSON.parse(value)),[{dataClass:'conversations',purgedCount:1,cutoffAtMs:NOW-30*DAY}]);
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.equal(events().length,1);database.close();
});

test('a broken audit chain pauses every new retention mutation and blob deletion',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);const seeded=seedTenant(database,TENANTS[0],0),conversation=seedConversation(database,TENANTS[0],0,NOW-31*DAY),file=seedFile(database,TENANTS[0],conversation.userId,'broken-key',NOW-31*DAY),removed:string[]=[],logged:string[]=[];
  database.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(TENANTS[0]);
  await runRetentionMaintenance({database,blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{},existsSync:()=>true,removeSync:key=>{removed.push(key)}},audit:workerAudit(database),now:()=>NOW,logger:{error:message=>logged.push(message)},retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:1,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.deepEqual(database.prepare('SELECT title,content_purged_at FROM conversations WHERE id=?').get(conversation.conversationId),{title:'Customer secret',content_purged_at:null});
  assert.equal(database.prepare('SELECT text_content FROM message_parts WHERE message_id=?').pluck().get(conversation.messageId),'message secret');
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'ready',extracted_text:'file secret',content_purged_at:null});
  assert.equal(database.prepare('SELECT payload_purged_at_ms FROM policy_approval_requests WHERE id=?').pluck().get(seeded.approvalId),null);
  assert.equal(database.prepare('SELECT count(*) FROM idempotency_records WHERE id=?').pluck().get(seeded.replayId),1);
  assert.deepEqual(removed,[]);assert.ok(logged.some(message=>message.includes('audit chain is unavailable')));database.close();
});

test('broken-chain recovery releases surviving prepared bytes and honestly finalizes bytes already missing',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const owner=seedConversation(database,TENANTS[0],0,NOW),present=seedFile(database,TENANTS[0],owner.userId,'present-key',NOW-31*DAY,0),missing=seedFile(database,TENANTS[0],owner.userId,'missing-key',NOW-31*DAY,0);let policyRead=false;
  database.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(TENANTS[0]);
  await runRetentionMaintenance({database,blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{},existsSync:key=>key==='present-key',removeSync:()=>{throw new Error('recovery must not start a new unlink')}},audit:workerAudit(database),now:()=>NOW,logger:{error(){}},retentionPolicy:tenantId=>{policyRead=true;return{tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}}});
  assert.equal(policyRead,false);assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(present),{extraction_status:'ready',extracted_text:'file secret',content_purged_at:null});assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(missing),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});assert.equal(database.prepare("SELECT count(*) FROM audit_events WHERE action='system.retention_purged'").pluck().get(),0);database.close();
});

test('conversation content and its audit event share one rollback boundary',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const conversation=seedConversation(database,TENANTS[0],0,NOW-31*DAY),base=workerAudit(database),failing:Pick<AuditService,'append'|'transact'>={append:base.append,transact(work){return base.transact(()=>work({append(){throw new Error('audit unavailable')}}))}};
  await assert.rejects(()=>runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:failing,now:()=>NOW,retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})}),/audit unavailable/);
  assert.deepEqual(database.prepare('SELECT title,content_purged_at FROM conversations WHERE id=?').get(conversation.conversationId),{title:'Customer secret',content_purged_at:null});assert.equal(database.prepare('SELECT text_content FROM message_parts WHERE message_id=?').pluck().get(conversation.messageId),'message secret');database.close();
});

test('file audit failure leaves a durable unavailable marker and recovery records the completed unlink',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const owner=seedConversation(database,TENANTS[0],0,NOW),file=seedFile(database,TENANTS[0],owner.userId,'audit-failure-key',NOW-31*DAY),base=workerAudit(database),logged:string[]=[];let exists=true;
  const blobs={put:async()=>{},read:async()=>null,remove:async()=>{},existsSync:()=>exists,removeSync:()=>{exists=false}};
  await runRetentionMaintenance({database,blobStore:blobs,audit:{transact:base.transact,append(){throw new Error('audit unavailable')}},now:()=>NOW,logger:{error:message=>logged.push(message)},retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.equal(exists,false);assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'ready',extracted_text:'file secret',content_purged_at:0});assert.ok(logged.some(message=>message.includes('will be retried')));
  await runRetentionMaintenance({database,blobStore:blobs,audit:base,now:()=>NOW,retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});const metadata=JSON.parse(database.prepare("SELECT metadata_json FROM audit_events WHERE action='system.retention_purged' AND json_extract(metadata_json,'$.fileId')=?").pluck().get(file) as string);assert.equal(metadata.preparedRecovery,true);database.close();
});

for(const scope of ['tenant','user','conversation','project','date_range'] as const)test(`a ${scope} legal hold blocks conversation purge until release`,async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW-31*DAY),hold=randomUUID(),projectId=randomUUID(),scopeId=scope==='user'?row.userId:scope==='conversation'?row.conversationId:scope==='project'?projectId:null;
  if(scope==='project'){
    database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Held project',?,?)").run(projectId,TENANTS[0],row.userId,NOW,NOW);
    database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)').run(projectId,row.conversationId,row.userId,NOW);
  }
  database.prepare('INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)').run(hold,TENANTS[0],scope,scopeId,scope==='date_range'?NOW-32*DAY:null,scope==='date_range'?NOW-30*DAY:null,'matter',row.userId,NOW);
  const policy=(tenantId:TenantId)=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW});
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:policy});assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(row.conversationId),null);
  database.prepare("UPDATE audit_legal_holds SET released_at_ms=?,released_by_user_id=?,release_reason='closed' WHERE id=?").run(NOW,row.userId,hold);
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:policy});assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(row.conversationId),NOW);database.close();
});

test('a date-range hold includes the final millisecond but excludes its end instant',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const endsAt=NOW-31*DAY,held=seedConversation(database,TENANTS[0],0,endsAt-1),outside=seedConversation(database,TENANTS[0],1,endsAt);
  database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,ends_at_ms,reason,created_by_user_id,created_at_ms) VALUES(?,?,'date_range',?,'inclusive last day',?,?)").run(randomUUID(),TENANTS[0],endsAt,held.userId,NOW);
  assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,30),{purged:1,ids:[outside.conversationId]});
  assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(held.conversationId),null);
  assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(outside.conversationId),NOW);
  database.close();
});

test('a date-range hold preserves every expired conversation whose lifetime overlaps its half-open range',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const instant=(month:number,day:number)=>Date.UTC(2026,month-1,day);
  const startsAt=instant(2,1),endsAt=instant(3,1),april5=instant(4,5);
  const startedInside=seedConversation(database,TENANTS[0],0,april5,instant(2,10));
  const spansRange=seedConversation(database,TENANTS[0],1,april5,instant(1,10));
  const endsAtStart=seedConversation(database,TENANTS[0],2,startsAt,instant(1,10));
  const endsBeforeStart=seedConversation(database,TENANTS[0],3,instant(1,20),instant(1,10));
  const startsAtEnd=seedConversation(database,TENANTS[0],4,april5,endsAt);
  database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms) VALUES(?,?,'date_range',?,?,'February matter',?,?)").run(randomUUID(),TENANTS[0],startsAt,endsAt,startedInside.userId,NOW);
  assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,30),{purged:2,ids:[endsBeforeStart.conversationId,startsAtEnd.conversationId]});
  for(const row of [startedInside,spansRange,endsAtStart])assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(row.conversationId),null);
  database.close();
});

test('open-ended date-range holds preserve expired conversations on their bounded side',()=>{
  for(const bound of ['start','end'] as const){
    const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
    const startsAt=Date.UTC(2026,1,1),endsAt=Date.UTC(2026,2,1);
    const row=bound==='start'
      ?seedConversation(database,TENANTS[0],0,startsAt,Date.UTC(2026,0,10))
      :seedConversation(database,TENANTS[0],0,Date.UTC(2026,3,5),Date.UTC(2026,1,10));
    database.prepare('INSERT INTO audit_legal_holds(id,tenant_id,scope_type,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),TENANTS[0],'date_range',bound==='start'?startsAt:null,bound==='end'?endsAt:null,`${bound} bound`,row.userId,NOW);
    assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,30),{purged:0,ids:[]},`${bound}-only hold`);
    database.close();
  }
});

test('tenant scoping prevents a purge from crossing tenants',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);seedTenant(database,TENANTS[1],1);
  const other=seedConversation(database,TENANTS[1],1,NOW-31*DAY);
  await runRetentionMaintenance({database,blobStore:blobRecorder().store,audit:workerAudit(database),now:()=>NOW,retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:tenantId===TENANTS[0]?30:365,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(other.conversationId),null);database.close();
});

test('NULL retention purges nothing',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const row=seedConversation(database,TENANTS[0],0,NOW-100*DAY);
  assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,null),{purged:0,ids:[]});assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(row.conversationId),null);database.close();
});

test('a hold inserted between selection and update wins the destructive re-check',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const row=seedConversation(database,TENANTS[0],0,NOW-31*DAY);
  const result=purgeExpiredConversations(database,TENANTS[0],NOW,30,100,{beforeUpdate:()=>database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'conversation',?,'race',?,?)").run(randomUUID(),TENANTS[0],row.conversationId,row.userId,NOW)});
  assert.equal(result.purged,0);assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(row.conversationId),null);database.close();
});

test('file retention clears extracted content, marks the row, and removes its blob',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);const row=seedConversation(database,TENANTS[0],0,NOW);
  const project=randomUUID(),file=randomUUID();database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?)").run(file,TENANTS[0],project,row.userId,'a'.repeat(64),NOW-31*DAY);
  const removed:string[]=[];const result=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>true,removeSync:key=>{
    assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW},'the row must stop claiming content is present before unlink');
    removed.push(key);
  }});
  assert.deepEqual(result.ids,[file]);assert.deepEqual(removed,['key']);assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});database.close();
});

test('a conversation hold preserves its message and attached file until release',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW-31*DAY),file=seedFile(database,TENANTS[0],row.userId,'held-conversation-file',NOW-31*DAY),hold=randomUUID();
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,file_id,metadata_json,created_at) VALUES(?,?,?,1,'file_ref',?,'{}',?)").run(randomUUID(),TENANTS[0],row.messageId,file,NOW-31*DAY);
  database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'conversation',?,'matter',?,?)").run(hold,TENANTS[0],row.conversationId,row.userId,NOW);
  const removed:string[]=[],blobs={remove:async()=>{},existsSync:()=>true,removeSync:(key:string)=>{removed.push(key)}};
  assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,30),{purged:0,ids:[]});assert.deepEqual(await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,blobs),{purged:0,ids:[]});
  assert.equal(database.prepare('SELECT text_content FROM message_parts WHERE message_id=? AND ordinal=0').pluck().get(row.messageId),'message secret');assert.equal(database.prepare('SELECT extracted_text FROM project_files WHERE id=?').pluck().get(file),'file secret');assert.deepEqual(removed,[]);
  database.prepare("UPDATE audit_legal_holds SET released_at_ms=?,released_by_user_id=?,release_reason='closed' WHERE id=?").run(NOW,row.userId,hold);
  assert.deepEqual(purgeExpiredConversations(database,TENANTS[0],NOW,30),{purged:1,ids:[row.conversationId]});assert.deepEqual(await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,blobs),{purged:1,ids:[file]});
  assert.equal(database.prepare('SELECT text_content FROM message_parts WHERE message_id=? AND ordinal=0').pluck().get(row.messageId),null);assert.equal(database.prepare('SELECT extracted_text FROM project_files WHERE id=?').pluck().get(file),null);assert.deepEqual(removed,['held-conversation-file']);database.close();
});

test('tenant retention policy reads settings and retain_full_transcripts=0 disables capture',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  database.prepare('INSERT INTO tenant_settings(tenant_id,conversation_retention_days,audit_retention_days,retain_full_transcripts,updated_at) VALUES(?,30,NULL,0,?)').run(TENANTS[0],NOW);
  const policy=createTenantRetentionPolicy(database,()=>NOW);assert.deepEqual(policy(TENANTS[0]),{tenantId:TENANTS[0],chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW});
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:policy,now:()=>NOW});audit.append({tenantId:TENANTS[0],action:'chat.message_submitted',actor:{type:'service',id:'test',sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'message',id:null},outcome:'success',context:{requestId:'capture-off',traceId:null,source:'worker'},metadata:{},transcript:{direction:'input',sanitizedContent:'not retained',sanitizedPreview:'not retained',tokenCount:null,redactionCount:0,retentionClass:'chat'}});
  assert.equal(database.prepare('SELECT COUNT(*) FROM audit_transcripts WHERE tenant_id=?').pluck().get(TENANTS[0]),0);database.close();
});

test('tenant retention policy falls back to existing defaults when settings are absent',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  assert.deepEqual(createTenantRetentionPolicy(database,()=>NOW)(TENANTS[0]),{tenantId:TENANTS[0],chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:NOW});database.close();
});

test('a file whose blob cannot be removed is not marked purged, and the next pass retries it',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),file=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?)").run(file,TENANTS[0],project,row.userId,'a'.repeat(64),NOW-31*DAY);
  const failures:string[]=[];
  const blocked=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>true,removeSync:()=>{throw new Error('EACCES')}},100,{onBlobError:id=>{failures.push(id)}});
  assert.deepEqual(blocked,{purged:0,ids:[]},'a file whose bytes survive must not be reported as purged');
  assert.deepEqual(failures,[file]);
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'ready',extracted_text:'abc',content_purged_at:null});
  const removed:string[]=[];
  assert.deepEqual((await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>true,removeSync:key=>{removed.push(key)}})).ids,[file]);
  assert.deepEqual(removed,['key']);database.close();
});

test('one unremovable blob does not cost the tenants after it their own purge',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);seedTenant(database,TENANTS[1],1);
  const first=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],first.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?)").run(randomUUID(),TENANTS[0],project,first.userId,'a'.repeat(64),NOW-31*DAY);
  const later=seedConversation(database,TENANTS[1],1,NOW-31*DAY);
  const logged:string[]=[];
  await runRetentionMaintenance({database,blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{throw new Error('EACCES')},existsSync:()=>true,removeSync:()=>{throw new Error('EACCES')}},audit:workerAudit(database),now:()=>NOW,
    logger:{error:message=>{logged.push(message)}},
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW})});
  assert.equal(database.prepare('SELECT content_purged_at FROM conversations WHERE id=?').pluck().get(later.conversationId),NOW,'the sweep stopped at the bad blob and never reached the next tenant');
  assert.equal(logged.length,1,'a file whose bytes could not be removed must not fail silently');
  assert.match(logged[0]!,/will be retried/);
  database.close();
});

test('the retention screen reports the window the worker will actually enforce',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const shown=createDirectoryReader(database,()=>NOW).listRetention(forTenant({tenantId:TENANTS[0]}),{}).items.find(item=>item.dataClass==='conversations');
  assert.equal(shown?.retentionDays,createTenantRetentionPolicy(database,()=>NOW)(TENANTS[0]).chatTranscriptDays);
  database.close();
});

test('a hold created after prepare but before irreversible blob deletion preserves the row and bytes',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),file=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?)").run(file,TENANTS[0],project,row.userId,'a'.repeat(64),NOW-31*DAY);
  const removed:string[]=[];
  const result=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>true,removeSync:key=>{removed.push(key)}},100,
    {beforeUpdate:()=>database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'project',?,'race',?,?)").run(randomUUID(),TENANTS[0],project,row.userId,NOW)});
  assert.deepEqual(result,{purged:0,ids:[]},'the destructive re-check must let the hold win');
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'ready',extracted_text:'abc',content_purged_at:null});
  assert.deepEqual(removed,[],'the irreversible unlink must not run after a hold lands');
  database.close();
});

test('a prepared file left by an interrupted pass resumes without returning to present',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),file=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?,0)").run(file,TENANTS[0],project,row.userId,'a'.repeat(64),NOW-31*DAY);
  const removed:string[]=[];
  assert.deepEqual(await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>true,removeSync:key=>{removed.push(key)}}),{purged:1,ids:[file]});
  assert.deepEqual(removed,['key']);
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});
  database.close();
});

test('a prepared file is recovered even when the retention window changes after the crash',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),present=randomUUID(),missing=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  const insert=database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt',?,'text/plain',3,?,'ready','abc',?,0)");
  insert.run(present,TENANTS[0],project,row.userId,'present-key','a'.repeat(64),NOW-31*DAY);
  insert.run(missing,TENANTS[0],project,row.userId,'missing-key','b'.repeat(64),NOW-31*DAY);
  const removed:string[]=[];
  const result=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,365,{remove:async()=>{},existsSync:key=>key==='present-key',removeSync:key=>{removed.push(key)}});
  assert.deepEqual(result,{purged:1,ids:[missing]},'missing bytes must stay purged while surviving bytes follow the longer policy');
  assert.deepEqual(removed,[]);
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(present),{extraction_status:'ready',extracted_text:'abc',content_purged_at:null});
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(missing),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});
  database.close();
});

test('a prepared file is reconciled even when retention is disabled after the crash',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),present=randomUUID(),missing=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  const insert=database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt',?,'text/plain',3,?,'ready','abc',?,0)");
  insert.run(present,TENANTS[0],project,row.userId,'present-key','a'.repeat(64),NOW-31*DAY);
  insert.run(missing,TENANTS[0],project,row.userId,'missing-key','b'.repeat(64),NOW-31*DAY);
  const result=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,null,{remove:async()=>{},existsSync:key=>key==='present-key',removeSync:()=>{throw new Error('disabled policy must not unlink surviving bytes')}});
  assert.deepEqual(result,{purged:1,ids:[missing]});
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(present),{extraction_status:'ready',extracted_text:'abc',content_purged_at:null});
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(missing),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW});
  database.close();
});

test('the global upgrade guard blocks new purges but still reconciles an interrupted file deletion',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),fresh=randomUUID(),prepared=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  const insert=database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt',?,'text/plain',3,?,'ready','abc',?,?)");
  insert.run(fresh,TENANTS[0],project,row.userId,'fresh-key','a'.repeat(64),NOW-31*DAY,null);
  insert.run(prepared,TENANTS[0],project,row.userId,'missing-key','b'.repeat(64),NOW-31*DAY,0);
  let policyRead=false;
  await runRetentionMaintenance({database,blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{},existsSync:key=>key==='fresh-key',removeSync:()=>{throw new Error('disabled retention must not unlink')}},audit:workerAudit(database),now:()=>NOW,enforcementEnabled:false,
    retentionPolicy:tenantId=>{policyRead=true;return{tenantId,chatTranscriptDays:30,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}}});
  assert.equal(policyRead,false,'the disabled worker must not consult or enforce tenant policy');
  assert.deepEqual(database.prepare('SELECT id,content_purged_at FROM project_files ORDER BY id').all(),[
    {id:fresh,content_purged_at:null},{id:prepared,content_purged_at:NOW},
  ].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(database.prepare("SELECT count(*) FROM audit_events WHERE action='system.retention_purged' AND json_extract(metadata_json,'$.preparedRecovery')=1").pluck().get(),1);
  database.close();
});

test('a hold after a crash-completed unlink cannot restore a missing blob to present',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);seedTenant(database,TENANTS[0],0);
  const row=seedConversation(database,TENANTS[0],0,NOW),project=randomUUID(),file=randomUUID();
  database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'P',?,?)").run(project,TENANTS[0],row.userId,NOW,NOW);
  database.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,created_at,content_purged_at) VALUES(?,?,?,?,'a.txt','key','text/plain',3,?,'ready','abc',?,0)").run(file,TENANTS[0],project,row.userId,'a'.repeat(64),NOW-31*DAY);
  let removeCalled=false;
  const result=await purgeExpiredProjectFiles(database,TENANTS[0],NOW,30,{remove:async()=>{},existsSync:()=>false,removeSync:()=>{removeCalled=true}},100,
    {beforeUpdate:()=>database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'project',?,'after unlink',?,?)").run(randomUUID(),TENANTS[0],project,row.userId,NOW)});
  assert.deepEqual(result,{purged:1,ids:[file]});
  assert.equal(removeCalled,false,'an already-missing blob needs no second unlink');
  assert.deepEqual(database.prepare('SELECT extraction_status,extracted_text,content_purged_at FROM project_files WHERE id=?').get(file),{extraction_status:'purged',extracted_text:null,content_purged_at:NOW},'the later hold must not make missing bytes present again');
  database.close();
});
