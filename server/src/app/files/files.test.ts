import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createFilesAdapter } from './index.js';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { FileDetail, RequestPrincipal, TenantId } from '../../shared/types.js';

/**
 * The five file routes were declared in the catalog and implemented by nothing, so every one of them
 * answered 501 and the composer's attach button was decorative. These run against a real migrated
 * database through the real `forTenant`, because the tenant binding is the control being tested:
 * a hand-rolled TenantDb would pass a statement that the real one rejects at prepare time.
 */
const AT=1_700_000_000_000;
const TEXT=new TextEncoder().encode('vendor evidence: annual access review');
const EXECUTABLE=Uint8Array.from([0x4d,0x5a,0x90,0,3,0,0,0,4,0,0,0]);
const PDF=new TextEncoder().encode('%PDF-1.7 trailer with no drawable text operators');

function fixture() {
  const database=new Database(':memory:'); database.pragma('foreign_keys=ON'); runMigrations(database);
  const root=mkdtempSync(join(tmpdir(),'gateway-files-'));
  const run=(sql:string,...params:unknown[])=>database.prepare(sql).run(...params);
  const tenants=[randomUUID() as TenantId,randomUUID() as TenantId] as const;
  const users=[randomUUID(),randomUUID()] as const, projects=[randomUUID(),randomUUID()] as const;
  tenants.forEach((id,index)=>{
    run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)`,id,`tenant-${index}`,`Tenant ${index}`,AT,AT);
    run(`INSERT INTO tenant_settings(tenant_id,conversation_retention_days,audit_retention_days,updated_at) VALUES(?,30,365,?)`,id,AT);
    run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)`,users[index],id,`owner${index}@test.invalid`,AT,AT);
    run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Vendor Risk Review',?,?)`,projects[index],id,users[index],AT,AT);
  });
  // The real audit service, not a stub: "the event landed" is only worth asserting against the store
  // that hashes it into the tenant's chain. Its clock advances so consecutive events keep a total order.
  let tick=AT;
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:AT}),now:()=>tick++});
  const adapter=createFilesAdapter({database,audit,storageRoot:root,now:()=>AT});

  const request=(index:0|1,options:{params?:Record<string,string>;headers?:Record<string,string>;body?:unknown}={}):RouteRequest => {
    const tenantId=tenants[index],principal:RequestPrincipal={userId:users[index],tenantId,membershipId:users[index],sessionId:randomUUID(),roles:['owner'],permissions:new Set()};
    return {tenant:{principal,db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(AT)},requestId:randomUUID(),
      params:options.params??{},query:{},headers:new Headers(options.headers??{}),body:options.body??null,rawBody:null};
  };
  const upload=(index:0|1,bytes:Uint8Array,name:string,type:string,projectId=projects[index]) =>
    adapter.execute('files.upload',request(index,{body:{file:new File([bytes],name,{type}),projectId}}));
  const events=(action:string)=>database.prepare(`SELECT action,outcome,target_id,metadata_json FROM audit_events WHERE action=? ORDER BY sequence`).all(action) as {action:string;outcome:string;target_id:string|null;metadata_json:string}[];
  const close=()=>{database.close();rmSync(root,{recursive:true,force:true})};
  return {database,adapter,request,upload,events,run,root,tenants,users,projects,close};
}

const ok=(result:RouteResult,expected?:number):Record<string,unknown> => {
  assert.equal(result.status,expected,`expected ${String(expected)}, got ${String(result.status)}: ${JSON.stringify(result.body)}`);
  return result.body as Record<string,unknown>;
};
const code=(result:RouteResult):string => ((result.body as {error?:{code?:string}}|undefined)?.error?.code)??'';

test('an upload is accepted, extracted in-process, and served back byte for byte',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  assert.equal(created.status,'ready');
  assert.equal(created.sizeBytes,TEXT.byteLength);
  assert.equal(created.projectId,f.projects[0]);
  assert.equal(created.extractedChars,'vendor evidence: annual access review'.length);

  const fetched=ok(await f.adapter.execute('files.get',f.request(0,{params:{id:created.id}})),undefined) as unknown as FileDetail;
  assert.equal(fetched.id,created.id);
  assert.equal(fetched.version,AT,'the ETag a caller must echo on delete');

  const content=await f.adapter.execute('files.content',f.request(0,{params:{id:created.id}}));
  assert.equal(content.status,undefined);
  assert.deepEqual(content.body,TEXT,'the original bytes, not the extracted text');
  assert.equal(content.headers?.['Content-Type'],'text/plain');
  // Never inline: a document served inline from the app origin is stored XSS against the session.
  assert.match(content.headers?.['Content-Disposition']??'',/^attachment; filename="evidence.txt"/);

  const extracted=ok(await f.adapter.execute('files.extracted',f.request(0,{params:{id:created.id}})),undefined);
  assert.equal(extracted.text,'vendor evidence: annual access review');
  f.close();
});

test('an executable is refused, stores nothing, and is written to the audit log',async()=>{
  const f=fixture();
  const refused=await f.upload(0,EXECUTABLE,'setup.txt','text/plain');
  assert.equal(refused.status,422);
  assert.equal(code(refused),'FILE_TYPE_NOT_ALLOWED');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM project_files').pluck().get(),0,'a refused upload must leave no row');
  assert.equal(existsSync(join(f.root,f.tenants[0])),false,'a refused upload must leave no bytes on disk');
  // A refusal is the event the log exists for; recording it only on success would leave an attempted
  // malware upload invisible to the auditor.
  const denied=f.events('chat.file_uploaded');
  assert.deepEqual(denied.map(row=>row.outcome),['denied']);
  assert.match(denied[0]!.metadata_json,/FILE_TYPE_NOT_ALLOWED/);
  f.close();
});

test('the same bytes uploaded twice return the existing row rather than a constraint failure',async()=>{
  const f=fixture();
  const first=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  const second=ok(await f.upload(0,TEXT,'evidence-copy.txt','text/plain'),202) as unknown as FileDetail;
  assert.equal(second.id,first.id,'UNIQUE(project_id,sha256) is a dedupe, not a 500');
  assert.equal(second.name,'evidence.txt','a re-upload must not rename a file another conversation cites');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM project_files').pluck().get(),1);
  assert.deepEqual(f.events('chat.file_uploaded').map(row=>JSON.parse(row.metadata_json).deduplicated),[false,true]);
  assert.deepEqual(f.events('chat.project_file_added').map(row=>JSON.parse(row.metadata_json)),[
    {projectId:f.projects[0],fileId:first.id},{projectId:f.projects[0],fileId:first.id},
  ]);
  // A different project in the same tenant is a different row: the unique key is per project.
  const other=randomUUID();
  f.run(`INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Second',?,?)`,other,f.tenants[0],f.users[0],AT,AT);
  const elsewhere=ok(await f.upload(0,TEXT,'evidence.txt','text/plain',other),202) as unknown as FileDetail;
  assert.notEqual(elsewhere.id,first.id);
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM project_files').pluck().get(),2);
  f.close();
});

test('another tenant\'s file id is a 404, never a 403',async()=>{
  const f=fixture();
  const mine=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  for(const operation of ['files.get','files.content','files.extracted']) {
    const denied=await f.adapter.execute(operation,f.request(1,{params:{id:mine.id}}));
    // 403 would confirm the id exists, which is the disclosure the tenant predicate exists to prevent.
    assert.equal(denied.status,404,`${operation} must answer 404 across tenants`);
    assert.equal(code(denied),'RESOURCE_NOT_FOUND');
  }
  const deletion=await f.adapter.execute('files.delete',f.request(1,{params:{id:mine.id},headers:{'If-Match':'*'}}));
  assert.equal(deletion.status,404);
  assert.equal(f.database.prepare('SELECT deleted_at FROM project_files WHERE id=?').pluck().get(mine.id),null,'the other tenant must not have deleted it');
  // Uploading into a project belonging to somebody else is the same answer.
  assert.equal((await f.upload(1,TEXT,'evidence.txt','text/plain',f.projects[0])).status,404);
  f.close();
});

test('a deleted file is invisible to get, content and extracted, and its bytes are gone',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  const key=String(f.database.prepare('SELECT storage_key FROM project_files WHERE id=?').pluck().get(created.id));
  assert.equal(existsSync(join(f.root,key)),true);

  assert.equal((await f.adapter.execute('files.delete',f.request(0,{params:{id:created.id},headers:{'If-Match':`"${created.version}"`}}))).status,204);
  for(const operation of ['files.get','files.content','files.extracted'])
    assert.equal((await f.adapter.execute(operation,f.request(0,{params:{id:created.id}}))).status,404,`${operation} must not serve a deleted file`);
  assert.equal(existsSync(join(f.root,key)),false,'deleting a file must destroy its bytes');
  // The row survives the delete: it is what the audit trail and the retention screen read.
  assert.notEqual(f.database.prepare('SELECT deleted_at FROM project_files WHERE id=?').pluck().get(created.id),null);
  const deleted=f.events('chat.file_deleted');
  assert.deepEqual(deleted.map(row=>[row.outcome,row.target_id]),[['success',created.id]]);
  // A retry of the same delete is the same request arriving twice, not a second deletion.
  assert.equal((await f.adapter.execute('files.delete',f.request(0,{params:{id:created.id},headers:{'If-Match':'*'}}))).status,204);
  assert.equal(f.events('chat.file_deleted').length,1);
  f.close();
});

test('a purged file still lists, and its content is refused with 410 rather than 404',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  f.run('UPDATE project_files SET content_purged_at=? WHERE id=?',AT,created.id);

  const listed=ok(await f.adapter.execute('files.get',f.request(0,{params:{id:created.id}})),undefined) as unknown as FileDetail;
  assert.equal(listed.id,created.id,'metadata survives a purge; the bytes do not');
  assert.equal(listed.failureCode,'FILE_NOT_READY');
  const refused=await f.adapter.execute('files.content',f.request(0,{params:{id:created.id}}));
  assert.equal(refused.status,410,'404 would contradict a resource GET /files/:id still returns');
  assert.equal(code(refused),'FILE_NOT_READY');
  f.close();
});

test('delete honours If-Match and refuses a stale validator',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  const stale=await f.adapter.execute('files.delete',f.request(0,{params:{id:created.id},headers:{'If-Match':'"1"'}}));
  assert.equal(stale.status,412);
  assert.equal(code(stale),'PRECONDITION_FAILED');
  assert.equal(f.database.prepare('SELECT deleted_at FROM project_files WHERE id=?').pluck().get(created.id),null,'a refused precondition must not delete');
  assert.equal(f.events('chat.file_deleted').length,0);
  assert.equal((await f.adapter.execute('files.delete',f.request(0,{params:{id:created.id},headers:{'If-Match':`W/"${created.version}"`}}))).status,204);
  f.close();
});

test('a file this process cannot safely read is retained but fails closed for chat',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,PDF,'contract.pdf','application/pdf'),202) as unknown as FileDetail;
  assert.equal(f.database.prepare('SELECT extraction_status FROM project_files WHERE id=?').pluck().get(created.id),'failed');
  assert.equal(created.status,'failed');
  assert.equal(created.failureCode,'FILE_SCAN_FAILED');
  const content=await f.adapter.execute('files.content',f.request(0,{params:{id:created.id}}));
  assert.deepEqual(content.body,PDF,'contract.pdf must still be retrievable');
  assert.equal(content.headers?.['Content-Type'],'application/pdf');
  assert.equal(ok(await f.adapter.execute('files.extracted',f.request(0,{params:{id:created.id}})),undefined).text,null);
  f.close();
});

test('the tenant upload setting is enforced below the extractor ceiling',async()=>{
  const f=fixture();
  f.run('UPDATE tenant_settings SET max_upload_bytes=10 WHERE tenant_id=?',f.tenants[0]);
  const refused=await f.upload(0,TEXT,'evidence.txt','text/plain');
  assert.equal(refused.status,413);
  assert.equal(code(refused),'FILE_TOO_LARGE');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM project_files').pluck().get(),0);
  assert.equal(existsSync(join(f.root,f.tenants[0])),false,'a limit refusal must happen before blob persistence');
  const [event]=f.events('chat.file_uploaded');
  assert.equal(event?.outcome,'denied');
  assert.deepEqual(JSON.parse(event!.metadata_json),{
    byteSize:TEXT.byteLength,configuredLimitBytes:10,effectiveLimitBytes:10,fileName:'evidence.txt',reason:'FILE_TOO_LARGE',
  });
  f.close();
});

test('an upload with no project of the caller\'s own is refused',async()=>{
  const f=fixture();
  const missing=await f.adapter.execute('files.upload',f.request(0,{body:{file:new File([TEXT],'evidence.txt',{type:'text/plain'})}}));
  assert.equal(missing.status,422,'project_id is NOT NULL, and a file outside every project is outside retention and legal hold');
  assert.equal(code(missing),'VALIDATION_FAILED');
  assert.equal((await f.adapter.execute('files.upload',f.request(0,{body:{projectId:f.projects[0]}}))).status,422,'no file part');
  assert.equal((await f.upload(0,new Uint8Array(0),'empty.txt','text/plain')).status,422,'byte_size is CHECKed to 1..104857600');
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM project_files').pluck().get(),0);
  f.close();
});

test('reading a file back is recorded against the file it read',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  await f.adapter.execute('files.content',f.request(0,{params:{id:created.id}}));
  await f.adapter.execute('files.extracted',f.request(0,{params:{id:created.id}}));
  // Two different actions on purpose. file_extracted is the pipeline reading a file to build model
  // context; file_downloaded is a person pulling the bytes back out. An auditor filtering the log for
  // exfiltration wants the second alone, and one shared action makes that filter impossible.
  const reads=[...f.events('chat.file_downloaded'),...f.events('chat.file_extracted').filter(row=>JSON.parse(row.metadata_json).access!=='pipeline')];
  assert.deepEqual(reads.map(row=>[row.target_id,JSON.parse(row.metadata_json).access]),[[created.id,'content'],[created.id,'extracted']]);
  // Metadata reads are not audited: GET /files/:id discloses nothing the project list does not.
  await f.adapter.execute('files.get',f.request(0,{params:{id:created.id}}));
  assert.equal(f.events('chat.file_downloaded').length+f.events('chat.file_extracted').filter(row=>JSON.parse(row.metadata_json).access!=='pipeline').length,2);
  f.close();
});

test('the upload and its audit event commit together',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  const [event]=f.events('chat.file_uploaded');
  assert.equal(event?.target_id,created.id);
  const digest=String(f.database.prepare('SELECT sha256 FROM project_files WHERE id=?').pluck().get(created.id));
  assert.equal(JSON.parse(event!.metadata_json).sha256,undefined,'audit metadata must not expose an unkeyed digest of file content');
  assert.doesNotMatch(event!.metadata_json,new RegExp(digest));
  assert.equal(f.database.prepare('SELECT project_id FROM audit_events WHERE id=?').pluck().get(
    f.database.prepare('SELECT id FROM audit_events WHERE action=? ORDER BY sequence LIMIT 1').pluck().get('chat.file_uploaded')),f.projects[0]);
  f.close();
});

test('file audit metadata contains neither content nor an unkeyed content digest',async()=>{
  const f=fixture();
  const created=ok(await f.upload(0,TEXT,'evidence.txt','text/plain'),202) as unknown as FileDetail;
  const digest=String(f.database.prepare('SELECT sha256 FROM project_files WHERE id=?').pluck().get(created.id));
  await f.adapter.execute('files.content',f.request(0,{params:{id:created.id}}));
  await f.adapter.execute('files.extracted',f.request(0,{params:{id:created.id}}));
  await f.adapter.execute('files.delete',f.request(0,{params:{id:created.id},headers:{'If-Match':'*'}}));
  const metadata=f.database.prepare('SELECT metadata_json FROM audit_events WHERE target_id=?').pluck().all(created.id).map(String);
  assert.ok(metadata.length>=5);
  for(const value of metadata){assert.doesNotMatch(value,new RegExp(digest));assert.doesNotMatch(value,/vendor evidence|annual access review/);assert.doesNotMatch(value,new RegExp(Buffer.from(TEXT).toString('base64')));}
  f.close();
});
