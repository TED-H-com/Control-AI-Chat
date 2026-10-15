import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import {createIdentityService} from '../app/identity/service.js';
import {runMigrations} from '../lib/migrations/index.js';
import {bootstrapTenant,requireBootstrapSecrets} from './bootstrap-core.js';
import {createAuditService} from '../lib/audit/index.js';
import {issueOperatorPasswordLink} from './issue-password-link-core.js';

const SECRET='bootstrap-test-jwt-secret-value-00000000';

test('bootstrap creates one login-ready owner and is idempotent',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const first=await bootstrapTenant(database,{workspaceName:'Northstar Systems',adminEmail:'owner@northstar.example',adminName:'Alex Owner'});
  assert.equal(first.created,true);if(!first.created)return;
  assert.equal(first.password.length,24);
  assert.equal(database.prepare('SELECT count(*) FROM tenants').pluck().get(),1);
  assert.equal(database.prepare("SELECT count(*) FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id JOIN roles r ON r.id=ur.role_id WHERE r.key='owner' AND u.email_verified_at IS NOT NULL").pluck().get(),1);
  assert.equal(database.prepare("SELECT count(*) FROM groups WHERE name='All Employees' AND is_system=1").pluck().get(),1);
  const before=database.prepare('SELECT (SELECT count(*) FROM tenants) tenants,(SELECT count(*) FROM users) users,(SELECT count(*) FROM groups) groups,(SELECT count(*) FROM model_catalog) models').get();
  const second=await bootstrapTenant(database,{workspaceName:'Changed',adminEmail:'changed@example.test',adminName:'Changed'});
  assert.deepEqual(second,{created:false,slug:first.slug});
  assert.deepEqual(database.prepare('SELECT (SELECT count(*) FROM tenants) tenants,(SELECT count(*) FROM users) users,(SELECT count(*) FROM groups) groups,(SELECT count(*) FROM model_catalog) models').get(),before);
  const identity=createIdentityService({database,jwtSecret:SECRET,encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'test',appOrigin:'https://app.test',audit:{append(){}}});
  const result=await identity.execute('auth.login',{tenant:null,requestId:'bootstrap-test',params:{},query:{},headers:new Headers(),body:{email:first.email,password:first.password},rawBody:null});
  assert.equal(result?.status??200,200);assert.match(result?.headers?.['Set-Cookie']??'',/__Host-session=/u);
  database.close();
});

test('bootstrap secret validation gives a plain actionable message',()=>{
  assert.throws(()=>requireBootstrapSecrets({JWT_SECRET:'',AUDIT_KEY:''}),/^Error: JWT_SECRET is required$/u);
  assert.throws(()=>requireBootstrapSecrets({JWT_SECRET:SECRET,AUDIT_KEY:''}),/^Error: AUDIT_KEY is required$/u);
});

test('the built bootstrap command loads secrets from the working directory .env',t=>{
  const directory=mkdtempSync(join(tmpdir(),'bootstrap-env-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'.env'),`JWT_SECRET=${SECRET}\nAUDIT_KEY=bootstrap-test-audit-key-value-00000000\nDB_PATH=./bootstrap.db\n`);
  const environment={...process.env};delete environment.JWT_SECRET;delete environment.AUDIT_KEY;delete environment.DB_PATH;
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../dist/scripts/bootstrap.js',import.meta.url)),'--workspace-name','Dev','--admin-email','dev@example.test'],{cwd:directory,env:environment,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const database=new Database(join(directory,'bootstrap.db'));
  try{assert.equal(database.prepare("SELECT count(*) FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id JOIN roles r ON r.id=ur.role_id WHERE r.key='owner' AND u.email='dev@example.test'").pluck().get(),1)}finally{database.close()}
});

test('operator recovery issues setup or reset through the CLI core and records a system audit actor',async()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const boot=await bootstrapTenant(database,{workspaceName:'Northstar Systems',adminEmail:'owner@northstar.example',adminName:'Alex Owner'});assert.equal(boot.created,true);if(!boot.created)return;
  const tenant=database.prepare("SELECT id FROM tenants WHERE slug=?").pluck().get(boot.slug) as string,invited='22222222-2222-4222-8222-222222222222',at=1_800_000_000_000;
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,status,created_at,updated_at) VALUES(?,?,?,'Invited','invited',?,?)").run(invited,tenant,'invited@northstar.example',at,at);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,5),transcriptKey:()=>Buffer.alloc(32,6),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:at}),now:()=>at});
  const reset=issueOperatorPasswordLink(database,audit,{workspaceSlug:boot.slug,email:boot.email,appOrigin:'https://control.example',now:at}),setup=issueOperatorPasswordLink(database,audit,{workspaceSlug:boot.slug,email:'invited@northstar.example',appOrigin:'https://control.example',now:at});
  assert.match(reset.url,/^https:\/\/control\.example\/reset-password#[A-Za-z0-9_-]{43}$/u);assert.equal(reset.purpose,'reset');assert.match(setup.url,/^https:\/\/control\.example\/setup#[A-Za-z0-9_-]{43}$/u);assert.equal(setup.purpose,'setup');
  assert.deepEqual(database.prepare('SELECT issued_by_user_id,issued_by_service FROM credential_links ORDER BY created_at,id').all(),[{issued_by_user_id:null,issued_by_service:'issue-password-link'},{issued_by_user_id:null,issued_by_service:'issue-password-link'}]);
  const rows=database.prepare("SELECT actor_type,actor_id,source,metadata_json FROM audit_events WHERE action='identity.credential_link_issued' ORDER BY sequence").all() as Array<{actor_type:string;actor_id:string;source:string;metadata_json:string}>;
  assert.deepEqual(rows.map(row=>({...row,metadata:JSON.parse(row.metadata_json),metadata_json:undefined})),[{actor_type:'service',actor_id:'issue-password-link',source:'cli',metadata_json:undefined,metadata:{purpose:'reset'}},{actor_type:'service',actor_id:'issue-password-link',source:'cli',metadata_json:undefined,metadata:{purpose:'setup'}}]);
  assert.throws(()=>issueOperatorPasswordLink(database,audit,{workspaceSlug:boot.slug,email:'missing@example.test',appOrigin:'https://control.example',now:at}),/No active or invited user/u);
  database.close();
});
