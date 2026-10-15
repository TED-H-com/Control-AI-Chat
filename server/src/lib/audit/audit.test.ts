import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { canonicalJson, genesisHash } from './audit-canonical.js';
import { AuditStore } from './audit-store.js';
import { AuditSearch } from './audit-search.js';
import { verifyAuditChain } from './audit-verify.js';
import type { TenantId } from '../../shared/types.js';

const tenant='00000000-0000-4000-8000-000000000001' as TenantId;
function fixture():Database.Database {
  const db=new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE audit_chain_heads(tenant_id TEXT PRIMARY KEY,chain_epoch INTEGER,last_sequence INTEGER,last_hash TEXT,genesis_hash TEXT,status TEXT,last_verified_sequence INTEGER DEFAULT 0,last_verified_hash TEXT,last_verified_at_ms INTEGER,break_sequence INTEGER,break_detected_at_ms INTEGER,updated_at_ms INTEGER);
CREATE TABLE audit_chain_epochs(tenant_id TEXT,chain_epoch INTEGER,genesis_hash TEXT,prior_epoch_final_hash TEXT,first_sequence INTEGER DEFAULT 1,last_sequence INTEGER,final_hash TEXT,status TEXT,reason TEXT,incident_id TEXT,opened_at_ms INTEGER,closed_at_ms INTEGER,PRIMARY KEY(tenant_id,chain_epoch));
CREATE TABLE audit_events(id TEXT PRIMARY KEY,tenant_id TEXT,chain_epoch INTEGER,sequence INTEGER,occurred_at_ms INTEGER,recorded_at_ms INTEGER,action TEXT,category TEXT,outcome TEXT,severity TEXT,actor_type TEXT,actor_id TEXT,actor_session_id TEXT,actor_ip_hmac TEXT,actor_user_agent TEXT,subject_user_id TEXT,group_id TEXT,project_id TEXT,conversation_id TEXT,message_id TEXT,target_type TEXT,target_id TEXT,model_id TEXT,provider_id TEXT,gate_action TEXT,detector TEXT,request_id TEXT,trace_id TEXT,source TEXT,metadata_json TEXT,metadata_text TEXT,transcript_id TEXT,transcript_digest TEXT,prev_hash TEXT,event_hash TEXT,hash_version INTEGER,UNIQUE(tenant_id,chain_epoch,sequence));
CREATE TABLE audit_transcripts(id TEXT PRIMARY KEY,tenant_id TEXT,audit_event_id TEXT,direction TEXT,content_state TEXT,content_encoding TEXT,content_ciphertext BLOB,content_nonce BLOB,key_version INTEGER,sanitized_preview TEXT,redacted_content_sha256 TEXT,original_content_hmac TEXT,character_count INTEGER,token_count INTEGER,redaction_count INTEGER,created_at_ms INTEGER,purge_after_ms INTEGER,purged_at_ms INTEGER,erasure_request_id TEXT);
CREATE VIRTUAL TABLE audit_events_fts USING fts5(tenant_key,tenant_id UNINDEXED,event_id,action,request_id,target_id,metadata_text,tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');
CREATE TABLE governed_state(id TEXT PRIMARY KEY);`); return db;
}
function store(db:Database.Database):AuditStore { let now=1_700_000_000_000; return new AuditStore({database:db,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:now}),now:()=>now++}); }
function input(index:number){return {tenantId:tenant,action:'chat.conversation_created' as const,actor:{type:'user' as const,id:null,sessionId:null,ip:'203.0.113.1',userAgent:'test',authMethod:'password' as const},target:{type:'conversation' as const,id:null},outcome:'success' as const,context:{requestId:`request-${index}`,traceId:null,source:'http' as const},metadata:{mode:'chat',projectId:null}};}

test('canonical JSON sorts recursively and rejects unsafe values',()=>{assert.equal(canonicalJson({z:1,a:{y:true,x:'é'}}),'{"a":{"x":"é","y":true},"z":1}');assert.throws(()=>canonicalJson({value:1.5}));assert.throws(()=>canonicalJson({value:-0}));});
test('genesis is stable and domain separated',()=>{assert.equal(genesisHash(tenant,1),genesisHash(tenant,1));assert.notEqual(genesisHash(tenant,1),genesisHash(tenant,2));});
test('append creates a contiguous chain and verifier detects metadata tampering',()=>{const db=fixture();const audit=store(db);for(let i=0;i<100;i++)audit.append(input(i));const sequences=db.prepare('SELECT sequence FROM audit_events WHERE tenant_id=? ORDER BY sequence').all(tenant) as {sequence:number}[];assert.deepEqual(sequences.map(x=>x.sequence),Array.from({length:101},(_,i)=>i+1));assert.equal(verifyAuditChain(db,tenant).valid,true);db.prepare('UPDATE audit_events SET metadata_json=? WHERE tenant_id=? AND sequence=?').run('{"mode":"tampered","projectId":null}',tenant,51);const verification=verifyAuditChain(db,tenant);assert.equal(verification.valid,false);assert.equal(verification.breakAtSequence,51);assert.equal(verification.reason,'event_hash_mismatch');db.close();});
test('verification can stop at and resume from a trusted hash without changing full sweeps',()=>{const db=fixture();const audit=store(db);for(let i=0;i<12;i++)audit.append(input(i));const full=verifyAuditChain(db,tenant);const first=verifyAuditChain(db,tenant,undefined,{startSequence:1,expectedPrevHash:genesisHash(tenant,1),maxRows:5});assert.equal(first.valid,true);assert.equal(first.checkedRows,5);assert.equal(first.throughSequence,5);assert.equal(typeof first.throughHash,'string');const second=verifyAuditChain(db,tenant,undefined,{startSequence:6,expectedPrevHash:first.throughHash,maxRows:5});assert.equal(second.valid,true);assert.equal(second.checkedRows,5);assert.equal(second.throughSequence,10);assert.equal(full.checkedRows,13);assert.equal(full.throughSequence,13);db.close();});
test('the first append initializes the chain once and includes its genesis hash',()=>{const db=fixture(),audit=store(db);audit.append(input(1));audit.append(input(2));const rows=db.prepare("SELECT sequence,metadata_json FROM audit_events WHERE tenant_id=? AND action='system.audit_chain_initialized'").all(tenant) as Array<{sequence:number;metadata_json:string}>;assert.equal(rows.length,1,'system.audit_chain_initialized was not stored exactly once');assert.equal(rows[0]!.sequence,1);assert.deepEqual(JSON.parse(rows[0]!.metadata_json),{epoch:1,genesisHash:genesisHash(tenant,1),reason:'tenant_created'});db.close();});
test('a regressed clock records observed, clamped, and delta values but a normal clock does not',()=>{const db=fixture();let now=1_700_000_000_000;const audit=new AuditStore({database:db,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:now}),now:()=>now});audit.append(input(1));now+=10;audit.append(input(2));assert.equal(db.prepare("SELECT COUNT(*) FROM audit_events WHERE action='system.clock_regression_detected'").pluck().get(),0,'normal clock stored a regression event');now-=25;audit.append(input(3));const rows=db.prepare("SELECT recorded_at_ms,metadata_json FROM audit_events WHERE action='system.clock_regression_detected'").all() as Array<{recorded_at_ms:number;metadata_json:string}>;assert.equal(rows.length,1,'system.clock_regression_detected was not stored');assert.equal(rows[0]!.recorded_at_ms,1_700_000_000_010);assert.deepEqual(JSON.parse(rows[0]!.metadata_json),{observedAtMs:1_699_999_999_985,clampedAtMs:1_700_000_000_010,deltaMs:25});db.close();});
test('transcript defense-in-depth scrub never persists a raw secret',()=>{const db=fixture();const audit=store(db);audit.append({...input(1),transcript:{direction:'input',sanitizedContent:'password=hunter2 and sk-live-abcdefghijklmnop',sanitizedPreview:'password=hunter2',tokenCount:3,redactionCount:0,retentionClass:'chat'}});const logical=JSON.stringify(db.prepare('SELECT * FROM audit_transcripts').get());assert.equal(logical.includes('hunter2'),false);assert.equal(logical.includes('sk-live'),false);db.close();});
test('unhealthy audit chain rolls back domain state in the shared transaction',()=>{const db=fixture(),audit=store(db);audit.append(input(1));db.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(tenant);assert.throws(()=>audit.transact(tx=>{db.prepare('INSERT INTO governed_state VALUES(?)').run('change');tx.append(input(2));}),/unavailable/);assert.equal(db.prepare('SELECT COUNT(*) FROM governed_state').pluck().get(),0);db.close();});
test('SQLITE_FULL rolls back domain state and is reported as unavailable',()=>{const db=fixture(),audit=store(db);assert.throws(()=>audit.transact(()=>{db.prepare('INSERT INTO governed_state VALUES(?)').run('change');throw Object.assign(new Error('full'),{code:'SQLITE_FULL'});}),/Audit write unavailable/);assert.equal(db.prepare('SELECT COUNT(*) FROM governed_state').pluck().get(),0);db.close();});
test('domain failure rolls back an audit append',()=>{const db=fixture(),audit=store(db);assert.throws(()=>audit.transact(tx=>{tx.append(input(1));throw new Error('forced domain failure');}),/forced domain failure/);assert.equal(db.prepare('SELECT COUNT(*) FROM audit_events').pluck().get(),0);db.close();});

test('search returns the events that were appended, and paginates with a cursor',()=>{
  // AuditSearch.search built its filter hash from `{...query,cursor:undefined,limit:undefined}`.
  // Those are own properties whose value canonicalJson cannot represent, so every call threw
  // "Cannot convert undefined or null to object" — the audit log was unreadable through the one
  // product feature that exists to read it. No test executed search() before this one.
  const db=fixture();const audit=store(db);
  for(let i=0;i<12;i++)audit.append(input(i));
  const search=new AuditSearch(db,Buffer.alloc(32,3),()=>1_700_000_000_000);
  const first=search.search(tenant,'owner',{limit:5});
  assert.equal(first.rows.length,5);
  assert.equal(first.hasMore,true);
  assert.ok(first.nextCursor,'a truncated page must return a cursor');
  const second=search.search(tenant,'owner',{limit:5,cursor:first.nextCursor!});
  assert.equal(second.rows.length,5);
  assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,10,'pages must not overlap');
  // A cursor is bound to the filters that produced it; reusing it under different filters must be
  // refused rather than silently paging through a different result set.
  assert.throws(()=>search.search(tenant,'owner',{limit:5,cursor:first.nextCursor!,outcomes:['failure']}));
  db.close();
});

test('search filters by the fields a compliance reviewer actually files on',()=>{
  const db=fixture();const audit=store(db);
  audit.append(input(1));
  audit.append({...input(2),outcome:'denied' as const,action:'gate.content_blocked' as const});
  const search=new AuditSearch(db,Buffer.alloc(32,3),()=>1_700_000_000_000);
  assert.equal(search.search(tenant,'owner',{outcomes:['denied']}).rows.length,1);
  assert.equal(search.search(tenant,'owner',{actions:['gate.content_blocked']}).rows.length,1);
  assert.equal(search.search(tenant,'owner',{}).rows.length,3,'an unfiltered search must return everything');
  db.close();
});

test('full-text search is tenant-scoped, prefix-aware, literal, and excludes transcripts',()=>{
  const db=fixture(),audit=store(db);
  audit.append({...input(1),action:'gate.content_blocked' as const,metadata:{summary:'Quarterly customer address review'},transcript:{direction:'input',sanitizedContent:'transcript-only-needle',sanitizedPreview:'transcript-only-needle',tokenCount:1,redactionCount:0,retentionClass:'chat'}});
  const other='00000000-0000-4000-8000-000000000002' as TenantId;
  audit.append({...input(2),tenantId:other,action:'gate.content_blocked' as const,metadata:{summary:'Cross tenant marker'}});
  const search=new AuditSearch(db,Buffer.alloc(32,3));
  assert.equal(search.search(tenant,'owner',{text:'quart cust addr'}).rows.length,1,'every literal prefix term must match');
  assert.equal(search.search(tenant,'owner',{text:'customer OR unrelated'}).rows.length,0,'OR must remain a literal word');
  assert.equal(search.search(tenant,'owner',{text:'+++'}).rows.length,0,'punctuation-only input is an empty match, not FTS syntax');
  assert.equal(search.search(tenant,'owner',{text:'transcript-only-needle'}).rows.length,0,'encrypted transcript content is never indexed');
  assert.equal(search.search(tenant,'owner',{text:'cross tenant marker'}).rows.length,0,'another tenant cannot satisfy the search');
  assert.throws(()=>search.search(tenant,'owner',{text:'x'.repeat(257)}),/at most 256/);
  assert.throws(()=>search.search(tenant,'owner',{text:Array.from({length:33},(_,i)=>`term${i}`).join(' ')}),/too many terms/);
  db.close();
});
