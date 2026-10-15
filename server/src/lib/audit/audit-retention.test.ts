import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { ApprovalStatus } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { openApprovalEnvelope, sealApprovalEnvelope, type ApprovalEnvelopePayloadV1 } from '../../app/chat/approval-envelope.js';
import { runMigrations } from '../migrations/index.js';
import { createAuditService } from './index.js';
import { IDEMPOTENCY_RETENTION_MS, purgeExpiredApprovalPayloads, purgeExpiredIdempotencyRecords, purgeExpiredTranscripts } from './audit-retention.js';

const NOW=Date.UTC(2026,7,10,12);
const DAY=24*60*60*1_000;
const TENANT='11111111-1111-4111-8111-111111111111' as TenantId;
const USER='22222222-2222-4222-8222-222222222222';
const SUBJECT='33333333-3333-4333-8333-333333333333';
const PROJECT='44444444-4444-4444-8444-444444444444';
const CONVERSATION='55555555-5555-4555-8555-555555555555';
const EVENT_AT=NOW-10*DAY;

interface Fixture {database:Database.Database;appendEvent():string;appendTranscript():string}
interface SeededApproval {id:string;violationId:string;digest:string;eventId:string;wrappedDek:Buffer}

function fixture(tenantId=TENANT,filename=':memory:'):Fixture {
  const database=new Database(filename);if(filename!==':memory:')database.pragma('journal_mode=WAL');database.pragma('foreign_keys=ON');runMigrations(database);
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Retention','active',?,?)").run(tenantId,`retention-${tenantId.slice(0,8)}`,NOW,NOW);
  const user=database.prepare("INSERT INTO users(tenant_id,id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)");
  user.run(tenantId,USER,`owner-${tenantId.slice(0,4)}@example.test`,'Owner',NOW,NOW);
  user.run(tenantId,SUBJECT,`subject-${tenantId.slice(0,4)}@example.test`,'Subject',NOW,NOW);
  database.prepare("INSERT INTO projects(tenant_id,id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Held project',?,?)").run(tenantId,PROJECT,USER,NOW,NOW);
  database.prepare("INSERT INTO conversations(tenant_id,id,owner_user_id,title,created_at,updated_at) VALUES(?,?,?,'Held conversation',?,?)").run(tenantId,CONVERSATION,USER,NOW,NOW);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:NOW}),now:()=>EVENT_AT});
  const event=(transcript=false)=>audit.append({tenantId,action:'gate.approval_requested',actor:{type:'user' as const,id:USER,sessionId:null,ip:null,userAgent:null,authMethod:'password' as const},target:{type:'approval' as const,id:null},outcome:'pending' as const,context:{requestId:randomUUID(),traceId:null,source:'http' as const,occurredAtMs:EVENT_AT},subjectUserId:SUBJECT,projectId:PROJECT,conversationId:CONVERSATION,gateAction:'require_approval' as const,metadata:{},...(transcript?{transcript:{direction:'input' as const,sanitizedContent:'governed content',sanitizedPreview:'governed content',tokenCount:2,redactionCount:0,retentionClass:'approval' as const}}:{})});
  return {database,appendEvent(){return event().id;},appendTranscript(){const receipt=event(true);return database.prepare('SELECT id FROM audit_transcripts WHERE tenant_id=? AND audit_event_id=?').pluck().get(tenantId,receipt.id) as string;}};
}

function seedApproval(f:Fixture,status:ApprovalStatus,terminalAt:number|null=NOW-2*DAY,withResult=false,scheme:'dek_v2'|'legacy_v1'='dek_v2'):SeededApproval {
  const id=randomUUID(),violationId=randomUUID(),eventId=f.appendEvent(),ciphertext=Buffer.from(`protected-${id}`),digest=createHash('sha256').update(ciphertext).digest('hex'),wrappedDek=randomBytes(48);
  f.database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,conversation_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,?,'outbound','secret','require_approval','high','open','[]','[REQUIRE_APPROVAL]',?,?,?)`)
    .run(violationId,TENANT,eventId,id,SUBJECT,CONVERSATION,randomUUID(),createHash('sha256').update(id).digest('hex'),EVENT_AT,EVENT_AT);
  const tail=[NOW+DAY,EVENT_AT,terminalAt,status==='released'?terminalAt:null,terminalAt,
    withResult?Buffer.from('checkpoint'):null,withResult?Buffer.alloc(12,4):null,withResult?createHash('sha256').update('checkpoint').digest('hex'):null];
  if(scheme==='dek_v2')f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,policy_revision,
      expires_at_ms,created_at_ms,decided_at_ms,released_at_ms,payload_terminal_at_ms,result_ciphertext,result_nonce,result_digest)
      VALUES(?,?,?,?,?,?,?,2,?,'dek_v2','available',?,?,1,1,?,?,?,?,?,?,?,?)`)
    .run(id,TENANT,violationId,USER,status,ciphertext,Buffer.alloc(12,3),digest,wrappedDek,Buffer.alloc(12,5),...tail);
  else f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,
      expires_at_ms,created_at_ms,decided_at_ms,released_at_ms,payload_terminal_at_ms,result_ciphertext,result_nonce,result_digest)
      VALUES(?,?,?,?,?,?,?,1,?,1,?,?,?,?,?,?,?,?)`)
    .run(id,TENANT,violationId,USER,status,ciphertext,Buffer.alloc(12,3),digest,...tail);
  return {id,violationId,digest,eventId,wrappedDek};
}

test('due terminal approval envelopes destroy the wrapped DEK without deleting evidence',()=>{
  const f=fixture(),approval=seedApproval(f,'released',NOW-2*DAY,true);
  assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1),{purged:1,ids:[approval.id]});
  const row=f.database.prepare(`SELECT status,length(payload_ciphertext) ciphertext_bytes,length(payload_nonce) nonce_bytes,key_version,payload_digest,
    payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,payload_key_destroyed_at_ms,
    payload_terminal_at_ms,payload_purged_at_ms,result_ciphertext,result_nonce,result_digest,violation_id,decision_note
    FROM policy_approval_requests WHERE tenant_id=? AND id=?`).get(TENANT,approval.id);
  assert.deepEqual(row,{status:'released',ciphertext_bytes:Buffer.from(`protected-${approval.id}`).length,nonce_bytes:12,key_version:2,payload_digest:approval.digest,
    payload_crypto_scheme:'dek_v2',payload_crypto_state:'key_destroyed',payload_wrapped_dek:null,payload_wrap_nonce:null,payload_kek_version:null,payload_key_destroyed_at_ms:NOW,
    payload_terminal_at_ms:NOW-2*DAY,payload_purged_at_ms:NOW,result_ciphertext:null,result_nonce:null,result_digest:null,
    violation_id:approval.violationId,decision_note:null});
  assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW+DAY,1),{purged:0,ids:[]});
  assert.throws(()=>f.database.prepare("UPDATE policy_approval_requests SET payload_purged_at_ms=NULL,payload_ciphertext=?,payload_nonce=?,key_version=1 WHERE id=?").run(Buffer.from('restored'),Buffer.alloc(12),approval.id),/irreversible|invalid/);
  assert.throws(()=>f.database.prepare('UPDATE policy_approval_requests SET payload_digest=? WHERE id=?').run('0'.repeat(64),approval.id),/irreversible/);
  assert.throws(()=>f.database.prepare('UPDATE policy_approval_requests SET payload_wrapped_dek=?,payload_wrap_nonce=?,payload_kek_version=1 WHERE id=?').run(approval.wrappedDek,Buffer.alloc(12),approval.id),/irreversible|invalid/);
  assert.throws(()=>f.database.prepare('UPDATE policy_approval_requests SET result_ciphertext=?,result_nonce=?,result_digest=? WHERE id=?').run(Buffer.from('result'),Buffer.alloc(12),'1'.repeat(64),approval.id),/irreversible/);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(),[]);f.database.close();
});

test('an interrupted pending scrub is completed before new retention eligibility is considered',()=>{
  const f=fixture(),approval=seedApproval(f,'cancelled',NOW-2*DAY);
  f.database.prepare(`UPDATE policy_approval_requests SET payload_wrapped_dek=NULL,payload_wrap_nonce=NULL,payload_kek_version=NULL,
    payload_crypto_state='key_destroy_pending_scrub',payload_key_destroyed_at_ms=? WHERE id=?`).run(NOW-1,approval.id);
  assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,365),{purged:1,ids:[approval.id]});
  assert.deepEqual(f.database.prepare('SELECT payload_crypto_state,payload_key_destroyed_at_ms,payload_purged_at_ms FROM policy_approval_requests WHERE id=?').get(approval.id),
    {payload_crypto_state:'key_destroyed',payload_key_destroyed_at_ms:NOW-1,payload_purged_at_ms:NOW});
  f.database.close();
});

test('legacy stable-key rows remain explicitly maintenance-required and are never auto-purged',()=>{
  const f=fixture(),approval=seedApproval(f,'released',NOW-10*DAY,false,'legacy_v1');
  assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1),{purged:0,ids:[]});
  assert.deepEqual(f.database.prepare('SELECT payload_crypto_scheme,payload_crypto_state,payload_purged_at_ms,length(payload_ciphertext) bytes FROM policy_approval_requests WHERE id=?').get(approval.id),
    {payload_crypto_scheme:'legacy_v1',payload_crypto_state:'legacy_maintenance_required',payload_purged_at_ms:null,bytes:Buffer.from(`protected-${approval.id}`).length});
  f.database.close();
});

test('wrapped-DEK purge scrubs main/WAL bytes while pre-purge backups remain decryptable',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gateway-approval-shred-')),source=join(directory,'source.db'),before=join(directory,'before.db'),after=join(directory,'after.db');
  const key=randomBytes(32),f=fixture(TENANT,source);let historical:Database.Database|undefined,compact:Database.Database|undefined;
  try{
    const approval=seedApproval(f,'released',NOW-2*DAY),payload:ApprovalEnvelopePayloadV1={schemaVersion:1,tenantId:TENANT,approvalId:approval.id,violationId:approval.violationId,evaluationId:randomUUID(),runId:randomUUID(),requestingUserId:USER,conversationId:CONVERSATION,sourceMessageId:randomUUID(),assistantMessageId:randomUUID(),pass:'preflight',messages:[{role:'user',content:[{type:'text',text:'employee content retained only through the wrapped DEK'}]}],attachments:[],model:{catalogId:randomUUID(),provider:'openai',modelKey:'test-model',maxOutputTokens:100,reasoningEffort:'none'},policy:{snapshotId:randomUUID(),fingerprint:'c'.repeat(64),revision:1},createdAtMs:EVENT_AT};
    const sealed=sealApprovalEnvelope(key,payload);
    f.database.prepare(`UPDATE policy_approval_requests SET payload_ciphertext=?,payload_nonce=?,key_version=?,payload_digest=?,
      payload_wrapped_dek=?,payload_wrap_nonce=?,payload_kek_version=? WHERE id=?`)
      .run(sealed.ciphertext,sealed.nonce,sealed.keyVersion,sealed.digest,sealed.wrappedDek,sealed.wrapNonce,sealed.kekVersion,approval.id);
    f.database.pragma('wal_checkpoint(TRUNCATE)');
    const contains=(base:string,needle:Buffer):boolean=>['','-wal','-journal'].some(suffix=>existsSync(`${base}${suffix}`)&&readFileSync(`${base}${suffix}`).includes(needle));
    assert.equal(readFileSync(source).includes(sealed.wrappedDek),true,'precondition: the exact wrapped key must be present in the main database');
    await f.database.backup(before);

    assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1),{purged:1,ids:[approval.id]});
    assert.equal(contains(source,sealed.wrappedDek),false,'the destroyed wrapped key must be absent from main, WAL and rollback journal');
    const current=f.database.prepare(`SELECT payload_ciphertext,payload_nonce,key_version,payload_crypto_scheme,payload_crypto_state,
      payload_wrapped_dek,payload_wrap_nonce,payload_kek_version FROM policy_approval_requests WHERE id=?`).get(approval.id) as {payload_ciphertext:Buffer;payload_nonce:Buffer;key_version:number;payload_crypto_scheme:'dek_v2';payload_crypto_state:string;payload_wrapped_dek:Buffer|null;payload_wrap_nonce:Buffer|null;payload_kek_version:number|null};
    assert.ok(current.payload_ciphertext.length>16,'ciphertext evidence remains even though no live DEK can open it');
    assert.equal(current.payload_crypto_state,'key_destroyed');
    assert.throws(()=>openApprovalEnvelope(key,{tenantId:TENANT,approvalId:approval.id,violationId:approval.violationId,ciphertext:current.payload_ciphertext,nonce:current.payload_nonce,keyVersion:current.key_version,cryptoScheme:current.payload_crypto_scheme,wrappedDek:current.payload_wrapped_dek,wrapNonce:current.payload_wrap_nonce,kekVersion:current.payload_kek_version}),/Corrupt approval wrapped key/);

    historical=new Database(before);
    assert.equal(historical.pragma('quick_check',{simple:true}),'ok');
    const old=historical.prepare(`SELECT payload_ciphertext,payload_nonce,key_version,payload_crypto_scheme,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version FROM policy_approval_requests WHERE id=?`).get(approval.id) as {payload_ciphertext:Buffer;payload_nonce:Buffer;key_version:number;payload_crypto_scheme:'dek_v2';payload_wrapped_dek:Buffer;payload_wrap_nonce:Buffer;payload_kek_version:number};
    assert.equal(readFileSync(before).includes(sealed.wrappedDek),true);
    assert.deepEqual(openApprovalEnvelope(key,{tenantId:TENANT,approvalId:approval.id,violationId:approval.violationId,ciphertext:old.payload_ciphertext,nonce:old.payload_nonce,keyVersion:old.key_version,cryptoScheme:old.payload_crypto_scheme,wrappedDek:old.payload_wrapped_dek,wrapNonce:old.payload_wrap_nonce,kekVersion:old.payload_kek_version}),payload,
      'a backup made before purge remains decryptable while its KEK is retained');

    f.database.prepare('VACUUM INTO ?').run(after);
    assert.equal(contains(after,sealed.wrappedDek),false,'a compact backup made after purge must not regain the destroyed key');
    compact=new Database(after,{readonly:true});assert.equal(compact.pragma('quick_check',{simple:true}),'ok');
    assert.deepEqual(compact.prepare('SELECT payload_crypto_state,payload_wrapped_dek FROM policy_approval_requests WHERE id=?').get(approval.id),{payload_crypto_state:'key_destroyed',payload_wrapped_dek:null});
  }finally{
    compact?.close();historical?.close();if(f.database.open)f.database.close();rmSync(directory,{recursive:true,force:true});
  }
});

test('transcript hold eligibility and destructive update share the immediate transaction',()=>{
  const f=fixture(),transcript=f.appendTranscript(),hold=randomUUID();
  f.database.prepare('UPDATE audit_transcripts SET purge_after_ms=? WHERE id=?').run(NOW-1,transcript);
  f.database.prepare(`INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms)
    VALUES(?,?,'conversation',?,'litigation',?,?)`).run(hold,TENANT,CONVERSATION,USER,NOW);
  assert.deepEqual(purgeExpiredTranscripts(f.database,TENANT,NOW),{purged:0,ids:[]});
  f.database.prepare("UPDATE audit_legal_holds SET released_by_user_id=?,released_at_ms=?,release_reason='closed' WHERE id=?").run(USER,NOW,hold);
  assert.deepEqual(purgeExpiredTranscripts(f.database,TENANT,NOW),{purged:1,ids:[transcript]});
  assert.deepEqual(f.database.prepare('SELECT content_state,content_ciphertext,content_nonce,key_version,purged_at_ms FROM audit_transcripts WHERE id=?').get(transcript),
    {content_state:'purged',content_ciphertext:null,content_nonce:null,key_version:null,purged_at_ms:NOW});
  f.database.close();
});

test('preterminal approvals never purge and cannot carry a terminal timestamp',()=>{
  const f=fixture(),statuses=['pending','claimed','approved','releasing','release_failed'] as const;
  const approvals=statuses.map(status=>seedApproval(f,status,null));
  assert.equal(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1,500).purged,0);
  for(const approval of approvals){
    assert.ok((f.database.prepare('SELECT length(payload_ciphertext) FROM policy_approval_requests WHERE id=?').pluck().get(approval.id) as number)>0);
    assert.throws(()=>f.database.prepare('UPDATE policy_approval_requests SET payload_terminal_at_ms=? WHERE id=?').run(NOW-100*DAY,approval.id),/nonterminal approval|terminal timestamp/);
  }
  f.database.close();
});

for(const scope of ['tenant','user','conversation','project','date_range'] as const){
  test(`${scope} legal hold blocks approval purge and release resumes it`,()=>{
    const f=fixture(),approval=seedApproval(f,'rejected'),hold=randomUUID();
    const scopeId=scope==='tenant'||scope==='date_range'?null:scope==='user'?SUBJECT:scope==='conversation'?CONVERSATION:PROJECT;
    f.database.prepare(`INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(hold,TENANT,scope,scopeId,scope==='date_range'?EVENT_AT-1:null,scope==='date_range'?EVENT_AT+1:null,'litigation',USER,NOW);
    assert.equal(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1).purged,0);
    assert.ok((f.database.prepare('SELECT length(payload_ciphertext) FROM policy_approval_requests WHERE id=?').pluck().get(approval.id) as number)>0);
    f.database.prepare('UPDATE audit_legal_holds SET released_by_user_id=?,released_at_ms=?,release_reason=? WHERE id=?').run(USER,NOW,'matter closed',hold);
    assert.deepEqual(purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1),{purged:1,ids:[approval.id]});
    f.database.close();
  });
}

test('approval payload cleanup is bounded and idempotent across batches',()=>{
  const f=fixture(),ids=Array.from({length:3},()=>seedApproval(f,'cancelled').id).sort();
  const first=purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1,2),second=purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1,2),third=purgeExpiredApprovalPayloads(f.database,TENANT,NOW,1,2);
  assert.deepEqual([...first.ids,...second.ids],ids);assert.equal(first.purged,2);assert.equal(second.purged,1);assert.deepEqual(third,{purged:0,ids:[]});
  f.database.close();
});

function insertReplay(database:Database.Database,input:{status:'claimed'|'dispatching'|'completed'|'failed';at:number;runId?:string;userMessageId?:string}):string {
  const id=randomUUID();
  database.prepare(`INSERT INTO idempotency_records(id,tenant_id,actor_user_id,method,path,idempotency_key,request_sha256,status,run_id,user_message_id,response_json,created_at,updated_at,completed_at)
    VALUES(?,?,?,'POST','/chat/runs',?,?,?, ?,?, '{}',?,?,?)`)
    .run(id,TENANT,USER,randomUUID(),createHash('sha256').update(id).digest('hex'),input.status,input.runId??randomUUID(),input.userMessageId??randomUUID(),input.at,input.at,['completed','failed'].includes(input.status)?input.at:null);
  return id;
}

test('idempotency cleanup deletes only 24-hour-old final rows and preserves active approval references',()=>{
  const f=fixture(),old=NOW-IDEMPOTENCY_RETENTION_MS-1,fresh=NOW-IDEMPOTENCY_RETENTION_MS+1;
  const completed=insertReplay(f.database,{status:'completed',at:old}),failed=insertReplay(f.database,{status:'failed',at:old});
  const freshCompleted=insertReplay(f.database,{status:'completed',at:fresh}),claimed=insertReplay(f.database,{status:'claimed',at:old}),dispatching=insertReplay(f.database,{status:'dispatching',at:old});
  const approval=seedApproval(f,'approved',null),source=f.database.prepare('SELECT message_id FROM policy_violations WHERE id=?').pluck().get(approval.violationId) as string;
  const referenced=insertReplay(f.database,{status:'completed',at:old,userMessageId:source});

  const first=purgeExpiredIdempotencyRecords(f.database,TENANT,NOW);
  assert.deepEqual(new Set(first.ids),new Set([completed,failed]));
  for(const id of [freshCompleted,claimed,dispatching,referenced])assert.ok(f.database.prepare('SELECT 1 FROM idempotency_records WHERE id=?').get(id),id);
  f.database.prepare("UPDATE policy_approval_requests SET status='released',payload_terminal_at_ms=? WHERE id=?").run(NOW,approval.id);
  assert.deepEqual(purgeExpiredIdempotencyRecords(f.database,TENANT,NOW),{purged:1,ids:[referenced]});
  assert.deepEqual(purgeExpiredIdempotencyRecords(f.database,TENANT,NOW),{purged:0,ids:[]});
  f.database.close();
});
