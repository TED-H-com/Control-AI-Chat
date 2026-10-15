import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_CONVERSATION_RETENTION_DAYS } from '../../lib/audit/tenant-retention-policy.js';
import { createDirectoryReader } from './directory.js';
import { forTenant } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { TenantId } from '../../shared/types.js';

const AT=1_700_000_000_000, DAY=86_400_000;
const ids={ownerRole:randomUUID(),auditorRole:randomUUID(),globalRole:randomUUID(),bravoRole:randomUUID(),owner:randomUUID(),departed:randomUUID(),bravoUser:randomUUID()};

function fixture() {
  const database=new Database(':memory:'); runMigrations(database);
  const acme=randomUUID() as TenantId, bravo=randomUUID() as TenantId;
  const run=(sql:string,...params:unknown[])=>database.prepare(sql).run(...params);
  for (const [id,slug] of [[acme,'acme'],[bravo,'bravo']] as const) run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`,id,slug,slug,AT,AT);
  run(`INSERT INTO tenant_settings(tenant_id,conversation_retention_days,audit_retention_days,updated_at) VALUES(?,30,400,?)`,acme,AT);
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@acme.test','Owner One','hash','active',?,?)`,ids.owner,acme,AT,AT);
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at,deleted_at) VALUES(?,?,'gone@acme.test','Departed','hash','deprovisioned',?,?,?)`,ids.departed,acme,AT,AT,AT);
  run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@bravo.test','Bravo Owner','hash','active',?,?)`,ids.bravoUser,bravo,AT,AT);

  for (const key of ['admin.users','admin.groups','model.read','audit.read']) run(`INSERT INTO permissions(key,description) VALUES(?,?)`,key,key);
  run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'owner','Owner',1,?)`,ids.ownerRole,acme,AT);
  run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'auditor','Auditor',0,?)`,ids.auditorRole,acme,AT-DAY);
  run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,NULL,'support','Support',1,?)`,ids.globalRole,AT);
  run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,'auditor','Bravo Auditor',0,?)`,ids.bravoRole,bravo,AT);
  for (const key of ['admin.users','admin.groups','model.read']) run(`INSERT INTO role_permissions(role_id,permission_key) VALUES(?,?)`,ids.ownerRole,key);
  run(`INSERT INTO role_permissions(role_id,permission_key) VALUES(?,'audit.read')`,ids.auditorRole);
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)`,acme,ids.owner,ids.ownerRole,ids.owner,AT-2*DAY);
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)`,acme,ids.departed,ids.ownerRole,ids.owner,AT-DAY);
  run(`INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) VALUES(?,?,?,?,?)`,bravo,ids.bravoUser,ids.globalRole,ids.bravoUser,AT);

  const conversation=randomUUID(), project=randomUUID(), message=randomUUID(), event=randomUUID();
  run(`INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Quarterly plan','active',?,?)`,conversation,acme,ids.owner,AT-10*DAY,AT-5*DAY);
  run(`INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Bravo chat','active',?,?)`,randomUUID(),bravo,ids.bravoUser,AT-40*DAY,AT-40*DAY);
  run(`INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,'user','complete',0,?)`,message,acme,conversation,ids.owner,AT-5*DAY);
  run(`INSERT INTO messages(id,tenant_id,conversation_id,role,status,sequence_no,created_at) VALUES(?,?,?,'assistant','complete',1,?)`,randomUUID(),acme,conversation,AT-5*DAY);
  run(`INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,created_at) VALUES(?,?,?,0,'text','hello',?)`,randomUUID(),acme,message,AT-5*DAY);
  run(`INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,created_at) VALUES(?,?,?,1,'text','wörld',?)`,randomUUID(),acme,message,AT-5*DAY);
  run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Atlas',?,?)`,project,acme,ids.owner,AT,AT);
  run(`INSERT INTO project_files(id,tenant_id,project_id,original_name,storage_key,mime_type,byte_size,sha256,created_at) VALUES(?,?,?,'brief.pdf','k1','application/pdf',1000,?,?)`,randomUUID(),acme,project,'a'.repeat(64),AT-20*DAY);
  run(`INSERT INTO project_files(id,tenant_id,project_id,original_name,storage_key,mime_type,byte_size,sha256,created_at,content_purged_at) VALUES(?,?,?,'old.pdf','k2','application/pdf',2000,?,?,?)`,randomUUID(),acme,project,'b'.repeat(64),AT-60*DAY,AT-DAY);
  run(`INSERT INTO audit_chain_epochs(tenant_id,chain_epoch,genesis_hash,status,reason,opened_at_ms) VALUES(?,1,?,'open','genesis',?)`,acme,'f'.repeat(64),AT-2*DAY);
  run(`INSERT INTO audit_events(id,tenant_id,chain_epoch,sequence,occurred_at_ms,recorded_at_ms,action,category,outcome,severity,actor_type,target_type,request_id,source,metadata_json,metadata_text,prev_hash,event_hash) VALUES(?,?,1,1,?,?,'admin.user_updated','admin','success','info','user','user',?,'http','{"a":1}','alpha',?,?)`,event,acme,AT-DAY,AT-DAY,randomUUID(),'c'.repeat(64),'d'.repeat(64));
  run(`INSERT INTO audit_transcripts(id,tenant_id,audit_event_id,direction,content_state,content_encoding,redacted_content_sha256,character_count,created_at_ms,purge_after_ms) VALUES(?,?,?,'inbound','present','utf8',?,12,?,?)`,randomUUID(),acme,event,'e'.repeat(64),AT-DAY,AT+10*DAY);
  run(`INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'conversation',?,'litigation',?,?)`,randomUUID(),acme,conversation,ids.owner,AT-DAY);
  run(`INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms,released_at_ms) VALUES(?,?,'tenant',NULL,'closed',?,?,?)`,randomUUID(),acme,ids.owner,AT-2*DAY,AT-DAY);
  run(`INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'tenant',NULL,'bravo matter',?,?)`,randomUUID(),bravo,ids.bravoUser,AT-DAY);
  const reader=createDirectoryReader(database,()=>AT);
  const scope=(tenantId:TenantId)=>forTenant({tenantId});
  return {database,reader,acme:scope(acme),bravo:scope(bravo),tenantId:acme,conversationId:conversation,projectId:project,conversationUpdatedAt:AT-5*DAY};
}

test('listRoles counts permissions and only this tenant\'s live assignments',()=>{
  const f=fixture();
  const {items,nextCursor}=f.reader.listRoles(f.acme,{});
  assert.equal(nextCursor,null);
  assert.deepEqual(items.map(row=>row.name),['Owner','Support','Auditor']);
  assert.deepEqual(items[0],{name:'Owner',type:'system',permissionCount:3,assignedUsers:1,lastChangedBy:'Owner One',updatedAt:AT-DAY,status:null});
  assert.deepEqual(items[1],{name:'Support',type:'system',permissionCount:0,assignedUsers:0,lastChangedBy:null,updatedAt:AT,status:null});
  assert.deepEqual(items[2],{name:'Auditor',type:'custom',permissionCount:1,assignedUsers:0,lastChangedBy:null,updatedAt:AT-DAY,status:null});
  f.database.close();
});

test('role filters narrow by type and by permission in either key form',()=>{
  const f=fixture();
  assert.deepEqual(f.reader.listRoles(f.acme,{type:'custom'}).items.map(row=>row.name),['Auditor']);
  assert.deepEqual(f.reader.listRoles(f.acme,{permission:'admin:users'}).items.map(row=>row.name),['Owner']);
  assert.deepEqual(f.reader.listRoles(f.acme,{permission:'audit.read'}).items.map(row=>row.name),['Auditor']);
  assert.deepEqual(f.reader.listRoles(f.acme,{search:'aud'}).items.map(row=>row.name),['Auditor']);
  f.database.close();
});

test('listRetention derives volume, holds and the next purge from real rows',()=>{
  const f=fixture();
  const {items}=f.reader.listRetention(f.acme,{});
  assert.deepEqual(items.map(row=>row.dataClass),['conversations','messages','audit_events','files']);
  assert.deepEqual(items[0],{dataClass:'conversations',retentionDays:30,minimumDays:1,maximumDays:3650,legalHolds:1,nextPurgeAt:f.conversationUpdatedAt+30*DAY,estimatedRows:1,estimatedBytes:14});
  // 'hello' plus 'wörld' is 11 bytes but 10 characters: retention is a storage number, not a text length.
  assert.deepEqual(items[1],{dataClass:'messages',retentionDays:30,minimumDays:1,maximumDays:3650,legalHolds:1,nextPurgeAt:f.conversationUpdatedAt+30*DAY,estimatedRows:2,estimatedBytes:11});
  assert.deepEqual(items[2],{dataClass:'audit_events',retentionDays:null,minimumDays:365,maximumDays:null,legalHolds:1,nextPurgeAt:null,estimatedRows:1,estimatedBytes:12});
  assert.deepEqual(items[3],{dataClass:'files',retentionDays:30,minimumDays:1,maximumDays:3650,legalHolds:1,nextPurgeAt:AT+10*DAY,estimatedRows:2,estimatedBytes:1000});
  f.database.close();
});

test('retention filters select a class, held classes and overdue purges',()=>{
  const f=fixture();
  assert.deepEqual(f.reader.listRetention(f.acme,{dataClass:'files'}).items.map(row=>row.dataClass),['files']);
  assert.deepEqual(f.reader.listRetention(f.acme,{legalHold:'true'}).items.map(row=>row.dataClass),['conversations','messages','audit_events','files']);
  assert.deepEqual(f.reader.listRetention(f.acme,{purgeDue:'true'}).items.map(row=>row.dataClass),[]);
  const later=createDirectoryReader(f.database,()=>AT+40*DAY);
  assert.deepEqual(later.listRetention(f.acme,{purgeDue:'true'}).items.map(row=>row.dataClass),['conversations','messages','files']);
  const bravo=f.reader.listRetention(f.bravo,{}).items;
  assert.deepEqual(bravo.map(row=>row.estimatedRows),[1,0,0,0]);
  // Bravo has no tenant_settings row. The screen has to show the default the purge worker will
  // actually enforce against it, not report it as kept forever.
  assert.deepEqual(bravo[0]!.retentionDays,DEFAULT_CONVERSATION_RETENTION_DAYS);
  assert.deepEqual(bravo[0]!.nextPurgeAt,AT-40*DAY+DEFAULT_CONVERSATION_RETENTION_DAYS*DAY);
  f.database.close();
});

test('project holds are reported for the conversations and messages they protect',()=>{
  const f=fixture();
  f.database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)').run(f.projectId,f.conversationId,ids.owner,AT);
  f.database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,reason,created_by_user_id,created_at_ms) VALUES(?,?,'project',?,'project matter',?,?)").run(randomUUID(),f.tenantId,f.projectId,ids.owner,AT);
  const held=new Map(f.reader.listRetention(f.acme,{legalHold:'true'}).items.map(row=>[row.dataClass,row.legalHolds]));
  assert.equal(held.get('conversations'),2);
  assert.equal(held.get('messages'),2);
  assert.equal(held.get('files'),2);
  f.database.close();
});

test('retention hold counts include every active worker scope and exclude released holds',()=>{
  const f=fixture(),insert=f.database.prepare('INSERT INTO audit_legal_holds(id,tenant_id,scope_type,scope_id,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms,released_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
  f.database.prepare('DELETE FROM audit_legal_holds WHERE tenant_id=?').run(f.tenantId);
  for(const scope of ['tenant','user','conversation','project','date_range'] as const){
    const scopeId=scope==='user'?ids.owner:scope==='conversation'?f.conversationId:scope==='project'?f.projectId:null;
    insert.run(randomUUID(),f.tenantId,scope,scopeId,scope==='date_range'?AT-DAY:null,scope==='date_range'?AT+DAY:null,`${scope} matter`,ids.owner,AT,null);
  }
  insert.run(randomUUID(),f.tenantId,'tenant',null,null,null,'released matter',ids.owner,AT-DAY,AT);
  assert.deepEqual(Object.fromEntries(f.reader.listRetention(f.acme,{}).items.map(row=>[row.dataClass,row.legalHolds])),{conversations:5,messages:5,audit_events:5,files:5});
  f.database.close();
});
