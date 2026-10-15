import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest } from '../../routes/types.js';
import type { Permission, RequestPrincipal, TenantId } from '../../shared/api.js';
import { createGateDecisionReader, type GateDecisionDetail } from './decisions.js';

const AT=1_780_000_000_000, DIGEST='c'.repeat(64);
const key=(label:string):Buffer=>createHash('sha256').update(label).digest();

function fixture(){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,otherTenantId=randomUUID() as TenantId,owner=randomUUID(),colleague=randomUUID(),officer=randomUUID();
  for(const [id,slug] of [[tenantId,'gate-test'],[otherTenantId,'gate-other']] as const)
    database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(id,slug,slug,AT,AT);
  for(const [id,tenant] of [[owner,tenantId],[colleague,tenantId],[officer,tenantId]] as const)
    database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'h','active',?,?)").run(id,tenant,`${id}@example.test`,'Person',AT,AT);
  const conversationId=randomUUID(),messageId=randomUUID();
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Thread','active',?,?)").run(conversationId,tenantId,owner,AT,AT);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?,'user','complete',0,?)").run(messageId,tenantId,conversationId,owner,AT);
  const decisionId=randomUUID();
  database.prepare(`INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,redacted_excerpt,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,'outbound','block','final',?,?,?,?,?,0,?)`)
    .run(decisionId,tenantId,owner,conversationId,messageId,DIGEST,JSON.stringify(['rule-a']),JSON.stringify(['aws_access_key']),'sk-••••1234',42,AT);
  const audit=createAuditService({database,ipHmacKey:key('ip'),transcriptKey:()=>key('transcript'),
    retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT})});
  const reader=createGateDecisionReader({database,audit});
  const request=(userId:string,id:string,permissions:Permission[],tenant=tenantId):RouteRequest=>{
    const principal:RequestPrincipal={tenantId:tenant,userId,membershipId:userId,roles:['member'],permissions:new Set(permissions),sessionId:randomUUID()};
    return {tenant:{principal,db:forTenant({tenantId:tenant}),requestId:randomUUID(),now:new Date(AT)},requestId:randomUUID(),params:{id},query:{},headers:new Headers(),body:null,rawBody:null};
  };
  return {database,reader,request,decisionId,messageId,conversationId,tenantId,otherTenantId,owner,colleague,officer};
}

const detail=(result:{body?:unknown}):GateDecisionDetail=>result.body as GateDecisionDetail;
const auditCount=(database:Database.Database):number=>(database.prepare("SELECT COUNT(*) c FROM audit_events WHERE action='admin.audit_event_viewed'").get() as {c:number}).c;

test('the person the gate stopped can read why, without holding an audit permission',()=>{
  const f=fixture();
  const result=f.reader.execute('gate.decision',f.request(f.owner,f.decisionId,['chat:use']));
  assert.equal(result.status,undefined,'a user reading their own decision must not be refused');
  const body=detail(result);
  assert.equal(body.action,'block');assert.equal(body.direction,'outbound');
  assert.deepEqual(body.detectors,['aws_access_key']);assert.deepEqual(body.ruleIds,['rule-a']);
  assert.equal(body.redactedExcerpt,'sk-••••1234');assert.equal(body.contentSha256,DIGEST);
  assert.equal(body.messageId,f.messageId);assert.equal(body.conversationId,f.conversationId);
  assert.equal(body.durationMs,42);assert.equal(body.cacheHit,false);
  assert.equal(body.decidedAt,new Date(AT).toISOString());assert.equal(body.review,null);
  assert.equal(auditCount(f.database),0,'reading your own decision is not a content-access event');
  f.database.close();
});

test('a colleague without audit:read is told the decision does not exist',()=>{
  const f=fixture();
  const result=f.reader.execute('gate.decision',f.request(f.colleague,f.decisionId,['chat:use']));
  assert.equal(result.status,404,'a 403 would confirm the id to someone who may not read it');
  assert.equal(auditCount(f.database),0,'a refused read is not a content access');
  f.database.close();
});

test('a compliance officer may read it, and the read is on the record',()=>{
  const f=fixture();
  const result=f.reader.execute('gate.decision',f.request(f.officer,f.decisionId,['audit:read']));
  assert.equal(detail(result).decisionId,f.decisionId);
  assert.equal(auditCount(f.database),1,'opening a colleague\'s excerpt must be audited');
  const event=f.database.prepare("SELECT actor_id,subject_user_id,target_type,target_id,metadata_json FROM audit_events WHERE action='admin.audit_event_viewed'").get() as {actor_id:string;subject_user_id:string|null;target_type:string;target_id:string;metadata_json:string};
  assert.equal(event.actor_id,f.officer);
  assert.equal(event.subject_user_id,f.owner,'the audit trail must name whose content was opened');
  assert.equal(event.target_type,'message');assert.equal(event.target_id,f.messageId);
  assert.equal((JSON.parse(event.metadata_json) as {gateDecisionId:string}).gateDecisionId,f.decisionId);
  f.database.close();
});

test('a decision belonging to another tenant is invisible even to an auditor',()=>{
  const f=fixture();
  const stranger=randomUUID();
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Stranger','h','active',?,?)").run(stranger,f.otherTenantId,'stranger@example.test',AT,AT);
  assert.equal(f.reader.execute('gate.decision',f.request(stranger,f.decisionId,['audit:read'],f.otherTenantId)).status,404);
  assert.equal(auditCount(f.database),0);
  f.database.close();
});

test('an approval reached through the shared message is reported, and a review is surfaced',()=>{
  const f=fixture();
  // policy_violations.audit_event_id is a foreign key, so the row needs a real event to hang off.
  // One officer read produces one, which keeps the fixture honest about the chain's shape.
  f.reader.execute('gate.decision',f.request(f.officer,f.decisionId,['audit:read']));
  const approvalId=randomUUID(),violationId=randomUUID(),anchor=(f.database.prepare('SELECT id FROM audit_events ORDER BY sequence DESC LIMIT 1').get() as {id:string}).id;
  f.database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'outbound','aws_access_key','block','high','open','[]','x',?,?,?)`)
    .run(violationId,f.tenantId,anchor,approvalId,f.owner,f.messageId,DIGEST,AT,AT);
  f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms)
    VALUES(?,?,?,?,'pending',?,?,1,?,1,?,?)`).run(approvalId,f.tenantId,violationId,f.owner,Buffer.from('cipher'),Buffer.from('nonce'),'d'.repeat(64),AT+86_400_000,AT);
  f.database.prepare('UPDATE gate_decisions SET reviewed_by_user_id=?,reviewed_at=?,review_note=? WHERE id=?').run(f.officer,AT+1000,'Confirmed as a real key',f.decisionId);
  const body=detail(f.reader.execute('gate.decision',f.request(f.owner,f.decisionId,['chat:use'])));
  assert.equal(body.approvalId,approvalId);
  assert.deepEqual(body.review,{byUserId:f.officer,at:new Date(AT+1000).toISOString(),note:'Confirmed as a real key'});
  f.database.close();
});

test('a direct approval relation takes priority over legacy message correlation',()=>{
  const f=fixture();
  f.reader.execute('gate.decision',f.request(f.officer,f.decisionId,['audit:read']));
  f.reader.execute('gate.decision',f.request(f.officer,f.decisionId,['audit:read']));
  const anchors=f.database.prepare('SELECT id FROM audit_events ORDER BY sequence').pluck().all() as string[];
  const legacyApprovalId=randomUUID(),directApprovalId=randomUUID(),legacyViolationId=randomUUID(),directViolationId=randomUUID();
  const insertViolation=f.database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'outbound','aws_access_key','require_approval','high','open','[]','x',?,?,?)`);
  insertViolation.run(legacyViolationId,f.tenantId,anchors[0],legacyApprovalId,f.owner,f.messageId,DIGEST,AT+1,AT+1);
  insertViolation.run(directViolationId,f.tenantId,anchors[1],directApprovalId,f.owner,null,DIGEST,AT,AT);
  f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms)
    VALUES(?,?,?,?,'pending',?,?,1,?,1,?,?)`).run(legacyApprovalId,f.tenantId,legacyViolationId,f.owner,Buffer.from('cipher'),Buffer.from('nonce'),'c'.repeat(64),AT+86_400_000,AT);
  f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,gate_decision_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,'pending',?,?,1,?,1,?,?)`).run(directApprovalId,f.tenantId,directViolationId,f.decisionId,f.owner,Buffer.from('cipher'),Buffer.from('nonce'),'d'.repeat(64),AT+86_400_000,AT);

  const body=detail(f.reader.execute('gate.decision',f.request(f.owner,f.decisionId,['chat:use'])));
  assert.equal(body.approvalId,directApprovalId);
  assert.notEqual(body.approvalId,legacyApprovalId);
  f.database.close();
});

test('a decision does not borrow an approval linked to another evaluation of the same message',()=>{
  const f=fixture();
  f.reader.execute('gate.decision',f.request(f.officer,f.decisionId,['audit:read']));
  const anchor=f.database.prepare('SELECT id FROM audit_events ORDER BY sequence DESC LIMIT 1').pluck().get() as string;
  const siblingDecisionId=randomUUID(),approvalId=randomUUID(),violationId=randomUUID();
  f.database.prepare(`INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,cache_hit,decided_at)
    VALUES(?,?,?,?,?,'outbound','require_approval','pending_approval',?,'[]','[]',1,0,?)`).run(siblingDecisionId,f.tenantId,f.owner,f.conversationId,f.messageId,DIGEST,AT+1);
  f.database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,message_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,'outbound','aws_access_key','require_approval','high','open','[]','x',?,?,?)`).run(violationId,f.tenantId,anchor,approvalId,f.owner,f.messageId,DIGEST,AT+1,AT+1);
  f.database.prepare(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,gate_decision_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,'pending',?,?,1,?,1,?,?)`).run(approvalId,f.tenantId,violationId,siblingDecisionId,f.owner,Buffer.from('cipher'),Buffer.from('nonce'),'e'.repeat(64),AT+86_400_000,AT);

  assert.equal(detail(f.reader.execute('gate.decision',f.request(f.owner,f.decisionId,['chat:use']))).approvalId,null);
  assert.equal(detail(f.reader.execute('gate.decision',f.request(f.owner,siblingDecisionId,['chat:use']))).approvalId,approvalId);
  f.database.close();
});
