import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';

import { provisionTenant } from '../identity/tenant-provision.js';
import { migration001 } from './001_baseline.js';
import { runMigrations } from './index.js';

const NOW=1_800_000_000_000;

function database():Database.Database {
  const result=new Database(':memory:');
  result.pragma('foreign_keys=ON');
  return result;
}

test('the baseline applies to a fresh database with only current model seeds',()=>{
  const db=database();
  runMigrations(db);
  assert.deepEqual(db.prepare('SELECT version,name,checksum_sha256 FROM schema_version').all(),[
    {version:1,name:'baseline',checksum_sha256:migration001.checksumSha256},
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM platform_model_versions').pluck().get(),11);
  assert.equal(db.prepare('SELECT COUNT(*) FROM platform_model_versions WHERE effective_to IS NOT NULL').pluck().get(),0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='billing_plan_versions'").pluck().get(),0);
  db.close();
});

test('re-running the baseline is a no-op',()=>{
  const db=database();
  runMigrations(db);
  const before=db.prepare('SELECT * FROM schema_version').get();
  runMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM schema_version').get(),before);
  assert.equal(db.prepare('SELECT COUNT(*) FROM platform_model_versions').pluck().get(),11);
  db.close();
});

test('a changed baseline name or checksum is refused',()=>{
  for(const [column,value] of [['name','initial'],['checksum_sha256','0'.repeat(64)]] as const){
    const db=database();
    runMigrations(db);
    db.prepare(`UPDATE schema_version SET ${column}=? WHERE version=1`).run(value);
    assert.throws(()=>runMigrations(db),/Migration 1 checksum\/name mismatch/u);
    db.close();
  }
});

test('a database whose version-1 migration has a different name is refused',()=>{
  const db=database();
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
  ) STRICT;`);
  db.prepare("INSERT INTO schema_version VALUES(1,'initial',?,0,0)").run('1'.repeat(64));
  assert.throws(()=>runMigrations(db),/Migration 1 checksum\/name mismatch/u);
  db.close();
});

test('a migration ledger newer than this build is refused',()=>{
  const db=database();
  runMigrations(db);
  db.prepare("INSERT INTO schema_version VALUES(2,'future',?,0,0)").run('2'.repeat(64));
  assert.throws(()=>runMigrations(db),/database is newer than this build/u);
  db.close();
});

test('the fresh baseline passes SQLite foreign-key and integrity checks',()=>{
  const db=database();
  runMigrations(db);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').pluck().get(),'ok');
  db.close();
});

test('tenant deletion remains atomic and leaves no partial or orphaned rows',()=>{
  const db=database();
  runMigrations(db);
  const tenantId=randomUUID(),ownerUserId=randomUUID();
  const provisioned=provisionTenant(db,{tenantId,ownerUserId,slug:`delete-${tenantId.slice(0,8)}`,tenantName:'Delete fixture',
    ownerEmail:'delete@example.test',ownerDisplayName:'Delete Owner',passwordHash:'hash',now:NOW});
  const conversationId=randomUUID(),messageId=randomUUID(),projectId=randomUUID(),fileId=randomUUID(),budgetId=randomUUID();
  db.prepare("INSERT INTO sessions(id,tenant_id,user_id,token_hash,jwt_id,auth_method,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,'password',?,?,?)")
    .run(randomUUID(),tenantId,ownerUserId,'a'.repeat(64),randomUUID(),NOW,NOW,NOW+60_000);
  db.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Delete fixture','active',?,?)")
    .run(conversationId,tenantId,ownerUserId,NOW,NOW);
  db.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,'user','complete',0,?)")
    .run(messageId,tenantId,conversationId,ownerUserId,NOW);
  db.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Delete fixture',?,?)")
    .run(projectId,tenantId,ownerUserId,NOW,NOW);
  db.prepare("INSERT INTO project_files(id,tenant_id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,created_at) VALUES(?,?,?,?,? ,?,'text/plain',1,?,'ready',?)")
    .run(fileId,tenantId,projectId,ownerUserId,'delete.txt',`delete/${fileId}`,'b'.repeat(64),NOW);
  db.prepare("INSERT INTO budgets(id,tenant_id,scope_type,period,metric,hard_limit,timezone,created_at,updated_at) VALUES(?,?,'tenant','daily','tokens',100,'UTC',?,?)")
    .run(budgetId,tenantId,NOW,NOW);
  assert.ok(db.prepare('SELECT COUNT(*) FROM policies WHERE tenant_id=?').pluck().get(tenantId));

  const gateId=randomUUID(),eventId=randomUUID(),violationId=randomUUID(),approvalId=randomUUID();
  db.prepare("INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,'outbound','require_approval','pending_approval',?,'[]','[]',0,0,?)")
    .run(gateId,tenantId,ownerUserId,conversationId,messageId,'c'.repeat(64),NOW);
  db.prepare("INSERT INTO audit_chain_epochs(tenant_id,chain_epoch,genesis_hash,first_sequence,status,reason,opened_at_ms) VALUES(?,1,?,1,'open','initial',?)")
    .run(tenantId,'d'.repeat(64),NOW);
  db.prepare("INSERT INTO audit_chain_heads(tenant_id,chain_epoch,last_sequence,last_hash,genesis_hash,status,updated_at_ms) VALUES(?,1,1,?,?,'ok',?)")
    .run(tenantId,'e'.repeat(64),'d'.repeat(64),NOW);
  db.prepare("INSERT INTO audit_events(id,tenant_id,chain_epoch,sequence,occurred_at_ms,recorded_at_ms,action,category,outcome,severity,actor_type,actor_id,subject_user_id,conversation_id,message_id,target_type,target_id,request_id,source,metadata_json,metadata_text,prev_hash,event_hash) VALUES(?,?,1,1,?,?,'gate.approval_requested','gate','pending','warning','user',?,?,?,?, 'approval',?,?,'http','{}','',?,?)")
    .run(eventId,tenantId,NOW,NOW,ownerUserId,ownerUserId,conversationId,messageId,approvalId,randomUUID(),'d'.repeat(64),'e'.repeat(64));
  db.prepare("INSERT INTO policy_violations(id,tenant_id,audit_event_id,subject_user_id,conversation_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'outbound','fixture','require_approval','high','open','[]','[RESTRICTED]',?,?,?)")
    .run(violationId,tenantId,eventId,ownerUserId,conversationId,messageId,'f'.repeat(64),NOW,NOW);
  db.prepare("INSERT INTO policy_approval_requests(id,tenant_id,violation_id,gate_decision_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms) VALUES(?,?,?,?,?,'pending',X'01',X'02',1,?,1,?,?)")
    .run(approvalId,tenantId,violationId,gateId,ownerUserId,'0'.repeat(64),NOW+60_000,NOW);

  const count=(table:string)=>db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${table==='tenants'?'id':'tenant_id'}=?`).pluck().get(tenantId);
  const tables=['tenants','users','sessions','conversations','messages','project_files','policies','policy_approval_requests','budgets'];
  const before=Object.fromEntries(tables.map(table=>[table,count(table)]));
  assert.throws(()=>db.prepare('DELETE FROM tenants WHERE id=?').run(tenantId),/FOREIGN KEY constraint failed/u);
  assert.deepEqual(Object.fromEntries(tables.map(table=>[table,count(table)])),before,
    'the refused delete remains atomic');

  db.prepare('DELETE FROM policy_approval_requests WHERE tenant_id=?').run(tenantId);
  db.prepare('DELETE FROM policy_violations WHERE tenant_id=?').run(tenantId);
  db.prepare('DELETE FROM audit_events WHERE tenant_id=?').run(tenantId);
  db.prepare('DELETE FROM audit_chain_heads WHERE tenant_id=?').run(tenantId);
  db.prepare('DELETE FROM audit_chain_epochs WHERE tenant_id=?').run(tenantId);
  assert.equal(db.prepare('DELETE FROM tenants WHERE id=?').run(tenantId).changes,1);
  for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'audit_events_fts_%'").pluck().all() as string[]){
    const columns=db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).pluck().all() as string[];
    if(columns.includes('tenant_id'))assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE tenant_id=?`).pluck().get(tenantId),0,table);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM model_catalog WHERE id IN ('+provisioned.modelIds.map(()=>'?').join(',')+')').pluck().get(...provisioned.modelIds),0);
  db.close();
});
