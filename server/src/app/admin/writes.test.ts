import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createAdminAdapter, prepareAdminStatements } from './index.js';
import { prepareConsoleStatements } from './capabilities.js';
import { prepareAnalyticsStatements } from './analytics.js';
import { prepareNudgeStatements } from './nudges.js';
import { createDirectoryReader } from './directory.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { assertTenantFirst, forTenant } from '../../lib/db.js';
import { createAuditService, type AuditService } from '../../lib/audit/index.js';
import { handleRequestError, type AppVariables } from '../../lib/http/index.js';
import { routeDefinitions } from '../../routes/catalog.js';
import { mountDefinitions } from '../../routes/http.js';
import type { RouteRequest } from '../../routes/types.js';
import type { Permission, RequestPrincipal, Role, TenantId } from '../../shared/types.js';
import type { Mailer, MailMessage } from '../../lib/email/mailer.js';
import {createIdentityService} from '../identity/service.js';
import {issueOperatorPasswordLink} from '../../scripts/issue-password-link-core.js';
import {SETUP_LINK_TTL_MS} from '../../lib/identity/credential-links.js';

/**
 * The admin console's write paths, every one of them, through the real `forTenant`.
 *
 * Nothing exercised these before, and the reason they were all broken at once is the reason this
 * file exists: the fixture in index.test.ts hand-rolls a TenantDb that binds the tenant id and skips
 * `checked()`. That is the half of TenantDb doing the actual work — without it a statement whose
 * tenant predicate is not the first placeholder looks fine in a test and throws on every real
 * request. `POST /api/v1/budgets` answered 500 in production for exactly that reason, as did invite
 * a user, create a group, add a model, author a rule and add a detector.
 *
 * So: real forTenant, and assert the row landed rather than that the call returned. A statement can
 * report success and change nothing — `addMember` matched no rows for months because its tenant
 * parameter was written into `created_at`.
 */

const AT = 1_700_000_000_000;

function fixture(failAudit=false,providedMailer?:Mailer|null,databasePath=':memory:',realAudit=false) {
  const database = new Database(databasePath);database.pragma('foreign_keys=ON');if(databasePath!==':memory:')database.pragma('journal_mode=WAL');runMigrations(database);
  const tenantId = randomUUID() as TenantId, userId = randomUUID(), memberId = randomUUID();
  const run = (sql:string, ...params:unknown[]) => database.prepare(sql).run(...params);
  run(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'acme','Acme','active',?,?)`, tenantId, AT, AT);
  run(`INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)`, tenantId, AT);
  for (const [id, email, name] of [[userId,'owner@acme.test','Owner'],[memberId,'member@acme.test','Member']] as const)
    run(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)`, id, tenantId, email, name, AT, AT);
  // The bootstrap in integration-services.ts seeds `owner` only, so a real tenant cannot be promoted
  // to any other role. Seeded here so the role-assignment path is testable at all; the gap itself is
  // a bootstrap defect, not a test-fixture convenience.
  for (const key of ['owner','admin','compliance','member'])
    run(`INSERT INTO roles(id,tenant_id,key,name,is_system,created_at) VALUES(?,?,?,?,1,?)`, randomUUID(), tenantId, key, key, AT);
  run(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'openai',1,'encrypted','fixture',1,?,?)`, randomUUID(), tenantId, AT, AT);
  const policyId = randomUUID();
  run(`INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Default',?,?)`, policyId, tenantId, AT, AT);

  const events:string[] = [],auditInputs:Array<{action:string;target?:{type:string;id:string|null};metadata?:unknown}>=[],mail:MailMessage[]=[],warnings:Array<{message:string;details?:Readonly<Record<string,unknown>>}>=[];
  const append = (input:{action:string;target?:{type:string;id:string|null};metadata?:unknown}) => { if(failAudit)throw new Error('forced invitation audit failure');events.push(input.action);auditInputs.push(input); return {id:randomUUID(),tenantId,chainEpoch:1,sequence:events.length,eventHash:'a'.repeat(64),recordedAtMs:AT} };
  const auditFor=(connection:Database.Database)=>realAudit?createAuditService({database:connection,ipHmacKey:Buffer.alloc(32,3),transcriptKey:()=>Buffer.alloc(32,4),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT}),now:()=>AT}):({append,transact:<T>(work:(tx:{append:typeof append})=>T)=>connection.transaction(()=>work({append})).immediate(),enqueue(){throw new Error('unused')}} as unknown as AuditService);
  const statements = prepareAdminStatements(database);
  const mailer=providedMailer===undefined?{async send(message:MailMessage){mail.push(message)}}:providedMailer;
  const logger={warn(message:string,details?:Readonly<Record<string,unknown>>){warnings.push(details===undefined?{message}:{message,details})}};
  const makeAdapter=(selectedMailer:Mailer|null=mailer,selectedNow:()=>number=()=>AT,connection:Database.Database=database)=>{
    const selectedStatements=connection===database?statements:prepareAdminStatements(connection);
    return createAdminAdapter({database:connection,statements:selectedStatements,console:prepareConsoleStatements(connection),analytics:prepareAnalyticsStatements(connection),nudges:prepareNudgeStatements(connection),directory:createDirectoryReader(connection,selectedNow),audit:auditFor(connection),now:selectedNow,appOrigin:'https://app.test',idempotencyHmacKey:Buffer.alloc(32,1),invitationResponseEncryptionKey:Buffer.alloc(32,2),...(selectedMailer?{mailer:selectedMailer}:{}),logger});
  };
  const adapter = makeAdapter();
  const tenantDb = forTenant({tenantId});
  const request = (body:unknown, params:Record<string,string> = {}, roles:Role[] = ['owner']):RouteRequest => {
    const principal:RequestPrincipal = {userId,tenantId,membershipId:userId,sessionId:randomUUID(),roles,permissions:new Set()};
    return {tenant:{principal,db:tenantDb,requestId:randomUUID(),now:new Date(AT)},requestId:randomUUID(),params,query:{},headers:new Headers({'Idempotency-Key':randomUUID()}),body,rawBody:null};
  };
  const count = (sql:string, ...params:unknown[]) => database.prepare(sql).pluck().get(...params) as number;
  return {database,adapter,makeAdapter,request,statements,events,auditInputs,mail,warnings,tenantId,userId,memberId,policyId,count,allowAudit(){failAudit=false;}};
}

const item = (result:{body?:unknown}) => (result.body as {item:Record<string,unknown>}).item;
const withMatch = (request:RouteRequest,version:number):RouteRequest => {const headers=new Headers(request.headers);headers.set('If-Match',`"${version}"`);return {...request,headers}};
const errorCode = (result:{body?:unknown}):unknown => (result.body as {error?:{code?:unknown}}|undefined)?.error?.code;
const errorMessage = (result:{body?:unknown}):unknown => (result.body as {error?:{message?:unknown}}|undefined)?.error?.message;
const errorReason = (result:{body?:unknown}):unknown => (result.body as {error?:{details?:{reason?:unknown}}}|undefined)?.error?.details?.reason;
test('every admin write lands a row, through the real tenant binding', async () => {
  const f = fixture();

  const group = item(await f.adapter.execute('admin.groups.create', f.request({name:'Engineering',description:'Builders'})));
  assert.equal(f.count('SELECT COUNT(*) FROM groups WHERE tenant_id=? AND name=?', f.tenantId, 'Engineering'), 1);

  const invited = await f.adapter.execute('admin.users.create', f.request({email:'New@Acme.test',displayName:'Newcomer'}));
  assert.equal(invited.status, 201);
  assert.equal(f.count(`SELECT COUNT(*) FROM users WHERE tenant_id=? AND email='new@acme.test' AND status='invited'`, f.tenantId), 1);

  // Role assignment is two statements plus a lookup, and each was independently wrong: `roleId`
  // carried a `(? IS NOT NULL)` sink that ate the tenant id, and `assignRole` bound one parameter
  // fewer than it declared.
  await f.adapter.execute('admin.users.update', withMatch(f.request({role:'admin'}, {id:f.memberId}),AT));
  assert.equal(f.count(`SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? AND r.key='admin'`, f.tenantId, f.memberId), 1);
  // Reassignment must not accumulate: clearAssignableRoles runs first.
  await f.adapter.execute('admin.users.update', withMatch(f.request({role:'compliance'}, {id:f.memberId}),AT+1));
  assert.equal(f.count('SELECT COUNT(*) FROM user_roles WHERE tenant_id=? AND user_id=?', f.tenantId, f.memberId), 1);

  const groupId = String(group.id);
  const added = await f.adapter.execute('admin.groups.addMember', withMatch(f.request(null, {id:groupId,userId:f.memberId}),Number(group.version)));
  assert.equal(added.status, 204);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=?', f.tenantId, groupId, f.memberId), 1);

  const model = item(await f.adapter.execute('admin.models.create', f.request({provider:'openai',providerModelId:'gpt-5.6-sol',displayName:'GPT-5.6 Sol',contextWindowTokens:400_000,maxOutputTokens:64_000,inputPriceMicroUsdPerMillion:1_250_000,outputPriceMicroUsdPerMillion:10_000_000,capabilities:['vision']})));
  assert.equal(f.count('SELECT COUNT(*) FROM model_catalog WHERE tenant_id=?', f.tenantId), 1);

  const groupVersion=Number(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,groupId));
  const enabled = await f.adapter.execute('admin.models.enableForGroup', withMatch(f.request({}, {groupId,modelId:String(model.id)}),groupVersion));
  assert.equal(enabled.status, 204);
  assert.equal(f.count('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?', groupId, String(model.id)), 1);

  // setProviderAccess wrote the tenant id into `enabled` and compared the enabled flag to a tenant
  // id, so it matched nothing; `enabled` is a 0/1 CHECK column, which is what made it visible.
  await f.adapter.execute('admin.providers.setGroupAccess', withMatch(f.request({enabled:true}, {groupId,providerId:'openai'}),0));
  assert.equal(f.count(`SELECT a.enabled FROM group_provider_access a JOIN provider_config p ON p.id=a.provider_config_id WHERE a.group_id=? AND p.provider_key='openai'`, groupId), 1);
  await f.adapter.execute('admin.providers.setGroupAccess', withMatch(f.request({enabled:false}, {groupId,providerId:'openai'}),1));
  assert.equal(f.count(`SELECT a.enabled FROM group_provider_access a JOIN provider_config p ON p.id=a.provider_config_id WHERE a.group_id=? AND p.provider_key='openai'`, groupId), 0, 'the upsert must be able to turn access back off');

  const budget = await f.adapter.execute('budgets.create', f.request({scope:'tenant',period:'monthly',metric:'usd',softLimit:8_000_000,hardLimit:10_000_000}));
  assert.equal(budget.status, 201);
  assert.equal(f.count('SELECT hard_limit FROM budgets WHERE tenant_id=?', f.tenantId), 10_000_000);
  const budgetId=String(item(budget).id);
  await f.adapter.execute('budgets.update',withMatch(f.request({enabled:false},{id:budgetId}),Number(item(budget).version)));
  assert.equal(f.count('SELECT soft_limit FROM budgets WHERE tenant_id=? AND id=?',f.tenantId,budgetId),8_000_000,'an enabled-only PATCH preserves the configured soft limit');

  const detector = item(await f.adapter.execute('admin.detectors.create', f.request({key:'project-cobalt',kind:'keyword',config:{terms:['Project Cobalt']}})));
  assert.equal(f.count('SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=?', f.tenantId), 1);

  const rule = await f.adapter.execute('gate.rules.create', f.request({policyId:f.policyId,detectorId:String(detector.id),direction:'outbound',action:'block',severity:'high',config:{},priority:10}));
  assert.equal(rule.status, 201);
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND policy_id=?', f.tenantId, f.policyId), 1);
  const policies=await f.adapter.execute('gate.policies.list',f.request(null));
  assert.deepEqual((policies.body as {items:Array<{id:string;name:string}>}).items.map(policy=>[policy.id,policy.name]),[[f.policyId,'Default']]);

  f.database.prepare('UPDATE tenant_settings SET audit_retention_days=730 WHERE tenant_id=?').run(f.tenantId);
  await f.adapter.execute('admin.settings.update', withMatch(f.request({defaultLocale:'ja',requestsPerMinute:120}),AT));
  assert.equal(f.count('SELECT requests_per_minute FROM tenant_settings WHERE tenant_id=?', f.tenantId), 120);
  assert.equal(f.count('SELECT audit_retention_days FROM tenant_settings WHERE tenant_id=?',f.tenantId),730,'a rate-limit-only PATCH preserves audit retention');
  assert.equal((await f.adapter.execute('admin.settings.update',f.request({auditRetentionDays:365}))).status,422,'the online API must not claim to enforce offline-only audit deletion');
  assert.equal((await f.adapter.execute('admin.settings.update',f.request({rehydrateRedactions:true}))).status,422,'irreversible redactions cannot be rehydrated');

  f.database.close();
});

test('group-provider PUT fences stale writes and durably replays one accepted intent',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PUT'&&definition.path==='/admin/groups/:groupId/providers/:providerId');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.providers.setGroupAccess',permission:'model:write',ifMatch:true,idempotency:true});
  const f=fixture(),groupId=randomUUID(),providerId='openai';
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Engineering',?,?)").run(groupId,f.tenantId,AT,AT);
  const read=async():Promise<{enabled:boolean;version:number}>=>{
    const result=await f.adapter.execute('admin.providers.list',f.request(null));
    const provider=(result.body as {items:Array<{provider:string;groupAccess:Array<{groupId:string;enabled:boolean;version:number}>}>}).items.find(row=>row.provider===providerId);
    assert.ok(provider);const access=provider.groupAccess.find(value=>value.groupId===groupId);
    return access?{enabled:access.enabled,version:access.version}:{enabled:false,version:0};
  };
  const principal:RequestPrincipal={userId:f.userId,tenantId:f.tenantId,membershipId:f.userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['model:write'])};
  const app=new Hono<{Variables:AppVariables}>();
  app.use('*',async(c,next)=>{c.set('requestId','group-provider-contract');c.set('principal',principal);c.set('tenant',{principal,requestId:'group-provider-contract',now:new Date(AT),db:forTenant({tenantId:f.tenantId})});await next()});
  mountDefinitions(app,f.adapter,route?[route]:[]);
  const put=(enabled:boolean,version:number|string|null,key:string=randomUUID())=>app.request(`/admin/groups/${groupId}/providers/${providerId}`,{method:'PUT',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(version===null?{}:{'If-Match':`"${version}"`})},body:JSON.stringify({enabled})});

  assert.equal((await put(true,null)).status,428);
  for(const invalid of ['not-a-version',-1])assert.equal((await put(true,invalid)).status,412);
  const absent=await read(),staleAbsent=await read();assert.deepEqual([absent,staleAbsent],[{enabled:false,version:0},{enabled:false,version:0}]);
  const first=await put(true,absent.version),firstBody=await first.json() as {item:Record<string,unknown>};
  assert.equal(first.status,200);assert.deepEqual(firstBody.item,{groupId,providerId,enabled:true,version:1});
  assert.equal((await put(false,staleAbsent.version)).status,412);assert.deepEqual(await read(),{enabled:true,version:1});

  const stored=await read(),staleStored=await read();
  assert.equal((await put(true,stored.version)).status,200);assert.deepEqual(await read(),{enabled:true,version:2},'a distinct same-value intent still advances the fence');
  assert.equal((await put(false,staleStored.version)).status,412);assert.deepEqual(await read(),{enabled:true,version:2});

  const key='durable-provider-access';
  const accepted=await put(false,2,key),acceptedBody=await accepted.json();
  const replay=await put(false,2,key),replayBody=await replay.json();
  assert.equal(accepted.status,200);assert.equal(replay.status,200);assert.deepEqual(replayBody,acceptedBody);assert.deepEqual(await read(),{enabled:false,version:3});
  assert.equal((await put(true,2,key)).status,409,'the key cannot reconcile a different body');
  assert.equal((await put(false,3,key)).status,409,'the key cannot reconcile a different precondition');
  assert.equal(f.events.filter(action=>action==='admin.provider_allowlist_changed').length,3,'stale writes and replay must not append success audits');
  const latestAudit=f.auditInputs.at(-1);assert.deepEqual(latestAudit&&{action:latestAudit.action,target:latestAudit.target,metadata:latestAudit.metadata},
    {action:'admin.provider_allowlist_changed',target:{type:'provider',id:providerId},metadata:{groupId,enabled:false,fromVersion:2,toVersion:3}});
  assert.equal(f.count('SELECT COUNT(*) FROM idempotency_records'),3,'only accepted distinct intents receive replay records');
  f.database.close();
});

test('group-provider PUT rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),groupId=randomUUID(),providerId='openai';
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Engineering',?,?)").run(groupId,f.tenantId,AT,AT);
  const request=withMatch(f.request({enabled:true},{groupId,providerId}),0);request.headers.set('Idempotency-Key','rollback-group-provider');
  await assert.rejects(f.adapter.execute('admin.providers.setGroupAccess',request),/forced invitation audit failure/);
  assert.equal(f.count('SELECT COUNT(*) FROM group_provider_access'),0);assert.equal(f.count('SELECT COUNT(*) FROM idempotency_records'),0);assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.providers.setGroupAccess',request);
  assert.deepEqual(item(accepted),{groupId,providerId,enabled:true,version:1});
  assert.deepEqual(f.database.prepare('SELECT enabled,version FROM group_provider_access WHERE group_id=?').get(groupId),{enabled:1,version:1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PUT' AND path='admin-provider-group-access:admin.providers.setGroupAccess'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.providers.setGroupAccess',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('group-provider PUT does not disclose missing or cross-tenant targets',async()=>{
  const f=fixture(),groupId=randomUUID(),otherTenant=randomUUID(),otherGroup=randomUUID(),otherProvider=randomUUID();
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Engineering',?,?)").run(groupId,f.tenantId,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'other-provider-tenant','Other','active',?,?)").run(otherTenant,AT,AT);
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Foreign group',?,?)").run(otherGroup,otherTenant,AT,AT);
  f.database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,created_at,updated_at) VALUES(?,?,'foreign-provider',1,'environment',?,?)").run(otherProvider,otherTenant,AT,AT);
  for(const params of [{groupId,providerId:'foreign-provider'},{groupId:otherGroup,providerId:'openai'},{groupId:otherGroup,providerId:'foreign-provider'},{groupId:randomUUID(),providerId:'missing-provider'}]){
    const response=await f.adapter.execute('admin.providers.setGroupAccess',withMatch(f.request({enabled:true},params),0));assert.equal(response.status,404);assert.equal(errorCode(response),'RESOURCE_NOT_FOUND');
  }
  assert.equal(f.count('SELECT COUNT(*) FROM group_provider_access'),0);assert.equal(f.count('SELECT COUNT(*) FROM idempotency_records'),0);assert.deepEqual(f.events,[]);f.database.close();
});

test('group DELETE reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='DELETE'&&definition.path==='/admin/groups/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.groups.delete',permission:'admin:groups',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),systemTarget=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignTarget=randomUUID();
  const insert=f.database.prepare('INSERT INTO groups(id,tenant_id,name,is_system,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  insert.run(target,f.tenantId,'Delete target',0,AT,AT);
  insert.run(staleTarget,f.tenantId,'Stale target',0,AT,AT+1);
  insert.run(otherTarget,f.tenantId,'Other target',0,AT,AT);
  insert.run(systemTarget,f.tenantId,'All Employees',1,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-group-delete','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  insert.run(foreignTarget,foreignTenant,'Foreign target',0,AT,AT);

  const read=await f.adapter.execute('admin.groups.get',f.request(null,{id:target}));
  assert.equal((read.body as {version?:number}).version,AT,'the read contract must supply the destructive-write fence');
  const remove=(id:string,version:number,key:string)=>{
    const request=withMatch(f.request(null,{id}),version);request.headers.set('Idempotency-Key',key);
    return f.adapter.execute('admin.groups.delete',request);
  };

  const stale=await remove(staleTarget,AT,'stale-group-delete');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await remove(systemTarget,AT,'system-group-delete')).status,403);
  assert.equal((await remove(foreignTarget,AT,'foreign-group-delete')).status,404);

  const key='durable-group-delete',accepted=await remove(target,AT,key),replay=await remove(target,AT,key);
  assert.equal(accepted.status,204);assert.equal(replay.status,204,'an exact lost-response retry must preserve success');
  const conflicting=await remove(otherTarget,AT,key);
  assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

  assert.equal(f.database.prepare('SELECT deleted_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,target),AT+1);
  for(const id of [staleTarget,otherTarget,systemTarget])
    assert.equal(f.database.prepare('SELECT deleted_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,id),null);
  assert.equal(f.database.prepare('SELECT deleted_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(foreignTenant,foreignTarget),null);
  assert.equal(f.events.filter(action=>action==='admin.group_deleted').length,1,'stale writes and replay must not append success audits');
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-group-delete:admin.groups.delete'",f.tenantId),1);
  f.database.close();
});

test('group DELETE rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Rollback group delete',?,?)").run(target,f.tenantId,AT,AT);
  const request=withMatch(f.request(null,{id:target}),AT);request.headers.set('Idempotency-Key','rollback-group-delete');
  await assert.rejects(f.adapter.execute('admin.groups.delete',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT deleted_at,updated_at FROM groups WHERE tenant_id=? AND id=?').get(f.tenantId,target),{deleted_at:null,updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-group-delete:admin.groups.delete'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.groups.delete',request);
  assert.equal(accepted.status,204);
  assert.equal(f.database.prepare('SELECT deleted_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,target),AT+1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-group-delete:admin.groups.delete'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.groups.delete',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('group PATCH reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/admin/groups/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.groups.update',permission:'admin:groups',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),systemTarget=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignTarget=randomUUID();
  const insert=f.database.prepare('INSERT INTO groups(id,tenant_id,name,description,is_system,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  insert.run(target,f.tenantId,'Update target','Keep this description',0,AT,AT);
  insert.run(staleTarget,f.tenantId,'Stale target','Stale description',0,AT,AT+1);
  insert.run(otherTarget,f.tenantId,'Other target','Other description',0,AT,AT);
  insert.run(systemTarget,f.tenantId,'All Employees','System description',1,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-group-update','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  insert.run(foreignTarget,foreignTenant,'Foreign target','Foreign description',0,AT,AT);

  const read=await f.adapter.execute('admin.groups.get',f.request(null,{id:target}));
  assert.equal((read.body as {version?:number}).version,AT,'the read contract must supply the update fence');
  const update=(id:string,body:unknown,version:number,key:string,adapter=f.adapter)=>{
    const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('admin.groups.update',request);
  };

  const stale=await update(staleTarget,{name:'Stale overwrite'},AT,'stale-group-update');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await update(systemTarget,{name:'Everyone'},AT,'system-group-update')).status,403);
  assert.equal((await update(foreignTarget,{name:'Foreign overwrite'},AT,'foreign-group-update')).status,404);

  const key='durable-group-update',accepted=await update(target,{name:'Renamed group'},AT,key);
  const replay=await update(target,{name:'Renamed group'},AT,key,f.makeAdapter());
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original row version and audit receipt');
  assert.deepEqual({name:item(accepted).name,description:item(accepted).description,version:item(accepted).version},
    {name:'Renamed group',description:'Keep this description',version:AT+1},'an omitted PATCH field must be preserved');
  const conflicting=await update(otherTarget,{name:'Conflicting group'},AT,key);
  assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

  assert.deepEqual(f.database.prepare('SELECT name,description,updated_at FROM groups WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {name:'Renamed group',description:'Keep this description',updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT name,updated_at FROM groups WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{name:'Stale target',updated_at:AT+1});
  assert.equal(f.database.prepare('SELECT name FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherTarget),'Other target');
  assert.equal(f.database.prepare('SELECT name FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,systemTarget),'All Employees');
  assert.equal(f.database.prepare('SELECT name FROM groups WHERE tenant_id=? AND id=?').pluck().get(foreignTenant,foreignTarget),'Foreign target');
  assert.equal(f.events.filter(action=>action==='admin.group_updated').length,1,'stale writes and replay must not append success audits');
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-group-update:admin.groups.update'",f.tenantId),1);
  f.database.close();
});

test('group PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,description,created_at,updated_at) VALUES(?,?,'Rollback group update','Original description',?,?)").run(target,f.tenantId,AT,AT);
  const request=withMatch(f.request({name:'Should roll back'},{id:target}),AT);request.headers.set('Idempotency-Key','rollback-group-update');
  await assert.rejects(f.adapter.execute('admin.groups.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT name,description,updated_at FROM groups WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {name:'Rollback group update',description:'Original description',updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-group-update:admin.groups.update'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.groups.update',request);
  assert.deepEqual({name:item(accepted).name,description:item(accepted).description,version:item(accepted).version},
    {name:'Should roll back',description:'Original description',version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT name,description,updated_at FROM groups WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {name:'Should roll back',description:'Original description',updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-group-update:admin.groups.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.groups.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('group POST durably replays one audited response and isolates the same key by tenant',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/admin/groups');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'admin.groups.create',permission:'admin:groups',idempotency:true});
  const f=fixture(),key='durable-group-create',body={name:'Operations',description:'Runs the company'};
  const request=(input:unknown,selectedKey=key)=>{const value=f.request(input);value.headers.set('Idempotency-Key',selectedKey);return value};

  const accepted=await f.adapter.execute('admin.groups.create',request(body));
  const replay=await f.makeAdapter().execute('admin.groups.create',request(body));
  assert.equal(accepted.status,201);assert.deepEqual(replay,accepted,'a fresh adapter must replay the original group and audit receipt');
  assert.deepEqual({name:item(accepted).name,description:item(accepted).description,version:item(accepted).version},
    {name:'Operations',description:'Runs the company',version:AT});
  const conflicting=await f.adapter.execute('admin.groups.create',request({name:'Different intent'}));
  assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

  const foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-group-create','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign.test','Foreign owner','hash','active',?,?)").run(foreignUser,foreignTenant,AT,AT);
  const foreignBase=request(body),foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignUser,membershipId:foreignUser};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignAccepted=await f.adapter.execute('admin.groups.create',foreignRequest);
  assert.equal(foreignAccepted.status,201,'another tenant must own an independent use of the same key');
  assert.notEqual(item(foreignAccepted).id,item(accepted).id);

  assert.equal(f.count("SELECT COUNT(*) FROM groups WHERE tenant_id=? AND name='Operations'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM groups WHERE tenant_id=? AND name='Operations'",foreignTenant),1);
  assert.equal(f.events.filter(action=>action==='admin.group_created').length,2,'replay and conflicts must not append success audits');
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-group-create:admin.groups.create'"),2);
  f.database.close();
});

test('group POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=f.request({name:'Rollback group create'});request.headers.set('Idempotency-Key','rollback-group-create');
  await assert.rejects(f.adapter.execute('admin.groups.create',request),/forced invitation audit failure/u);
  assert.equal(f.count("SELECT COUNT(*) FROM groups WHERE tenant_id=? AND name='Rollback group create'",f.tenantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-group-create:admin.groups.create'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.groups.create',request);
  assert.equal(accepted.status,201);
  assert.deepEqual({name:item(accepted).name,version:item(accepted).version},{name:'Rollback group create',version:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM groups WHERE tenant_id=? AND name='Rollback group create'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-group-create:admin.groups.create'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.groups.create',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('model POST durably replays one audited response and isolates the same key by tenant',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/admin/models');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'admin.models.create',permission:'model:write',idempotency:true});
  const f=fixture(),key='durable-model-create',body={provider:'openai',providerModelId:'durable-model-post',displayName:'Durable model',enabled:true,contextWindowTokens:8192,maxOutputTokens:1024,inputPriceMicroUsdPerMillion:3,outputPriceMicroUsdPerMillion:7,capabilities:['text']};
  const request=(input:unknown)=>{const value=f.request(input);value.headers.set('Idempotency-Key',key);return value};

  const accepted=await f.adapter.execute('admin.models.create',request(body));
  const replay=await f.makeAdapter().execute('admin.models.create',request(body));
  assert.equal(accepted.status,201);assert.deepEqual(replay,accepted,'a fresh adapter must replay the original model and audit receipt');
  assert.deepEqual({provider:item(accepted).provider,providerModelId:item(accepted).providerModelId,displayName:item(accepted).displayName,version:item(accepted).version},
    {provider:'openai',providerModelId:'durable-model-post',displayName:'Durable model',version:AT});
  const conflicting=await f.adapter.execute('admin.models.create',request({...body,displayName:'Different intent'}));
  assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

  const foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-model-create','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-model-create.test','Foreign owner','hash','active',?,?)").run(foreignUser,foreignTenant,AT,AT);
  const foreignBase=request(body),foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignUser,membershipId:foreignUser};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignAccepted=await f.adapter.execute('admin.models.create',foreignRequest);
  assert.equal(foreignAccepted.status,201,'another tenant must own an independent use of the same key');
  assert.notEqual(item(foreignAccepted).id,item(accepted).id);

  assert.equal(f.count("SELECT COUNT(*) FROM model_catalog WHERE tenant_id=? AND provider_key='openai' AND model_key='durable-model-post'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM model_catalog WHERE tenant_id=? AND provider_key='openai' AND model_key='durable-model-post'",foreignTenant),1);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.model_access_changed').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target:item(accepted).id,metadata:{}},{target:item(foreignAccepted).id,metadata:{}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-model-create:admin.models.create'"),2);
  f.database.close();
});

test('model POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=f.request({provider:'openai',providerModelId:'rollback-model-create',displayName:'Rollback model create',contextWindowTokens:4096,maxOutputTokens:512,inputPriceMicroUsdPerMillion:3,outputPriceMicroUsdPerMillion:7,capabilities:[]});
  request.headers.set('Idempotency-Key','rollback-model-create');
  await assert.rejects(f.adapter.execute('admin.models.create',request),/forced invitation audit failure/u);
  assert.equal(f.count("SELECT COUNT(*) FROM model_catalog WHERE tenant_id=? AND model_key='rollback-model-create'",f.tenantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-model-create:admin.models.create'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.models.create',request);
  assert.equal(accepted.status,201);
  assert.deepEqual({providerModelId:item(accepted).providerModelId,displayName:item(accepted).displayName,version:item(accepted).version},
    {providerModelId:'rollback-model-create',displayName:'Rollback model create',version:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM model_catalog WHERE tenant_id=? AND model_key='rollback-model-create'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-model-create:admin.models.create'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.models.create',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('budget POST durably replays one audited response and isolates the same key by tenant',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/budgets');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'budgets.create',permission:'budget:write',idempotency:true});
  const f=fixture(),key='durable-budget-create',body={scope:'tenant',period:'monthly',metric:'tokens',softLimit:8000,hardLimit:10000,timezone:'America/New_York',enabled:true};
  const request=(input:unknown)=>{const value=f.request(input);value.headers.set('Idempotency-Key',key);return value};

  const accepted=await f.adapter.execute('budgets.create',request(body));
  const replay=await f.makeAdapter().execute('budgets.create',request(body));
  assert.equal(accepted.status,201);assert.deepEqual(replay,accepted,'a fresh adapter must replay the original budget and audit receipt');
  assert.deepEqual({scope:item(accepted).scope,scopeId:item(accepted).scopeId,period:item(accepted).period,metric:item(accepted).metric,hardLimit:item(accepted).hardLimit},
    {scope:'tenant',scopeId:null,period:'monthly',metric:'tokens',hardLimit:10000});
  const conflicting=await f.adapter.execute('budgets.create',request({...body,hardLimit:12000}));
  assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

  const foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-budget-create','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-budget-create.test','Foreign owner','hash','active',?,?)").run(foreignUser,foreignTenant,AT,AT);
  const foreignBase=request(body),foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignUser,membershipId:foreignUser};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignAccepted=await f.adapter.execute('budgets.create',foreignRequest);
  assert.equal(foreignAccepted.status,201,'another tenant must own an independent use of the same key');
  assert.notEqual(item(foreignAccepted).id,item(accepted).id);

  assert.equal(f.count("SELECT COUNT(*) FROM budgets WHERE tenant_id=? AND period='monthly' AND metric='tokens'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM budgets WHERE tenant_id=? AND period='monthly' AND metric='tokens'",foreignTenant),1);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.tenant_setting_changed'&&(input.metadata as {kind?:unknown}|undefined)?.kind==='budget_created').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target:item(accepted).id,metadata:{kind:'budget_created'}},{target:item(foreignAccepted).id,metadata:{kind:'budget_created'}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-budget-create:budgets.create'"),2);
  f.database.close();
});

test('budget POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=f.request({scope:'tenant',period:'daily',metric:'tokens',softLimit:8000,hardLimit:10000,timezone:'UTC',enabled:true});
  request.headers.set('Idempotency-Key','rollback-budget-create');
  await assert.rejects(f.adapter.execute('budgets.create',request),/forced invitation audit failure/u);
  assert.equal(f.count("SELECT COUNT(*) FROM budgets WHERE tenant_id=? AND period='daily' AND metric='tokens'",f.tenantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-budget-create:budgets.create'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('budgets.create',request);
  assert.equal(accepted.status,201);
  assert.deepEqual({period:item(accepted).period,metric:item(accepted).metric,hardLimit:item(accepted).hardLimit},
    {period:'daily',metric:'tokens',hardLimit:10000});
  assert.equal(f.count("SELECT COUNT(*) FROM budgets WHERE tenant_id=? AND period='daily' AND metric='tokens'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-budget-create:budgets.create'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('budgets.create',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('budget PATCH reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/budgets/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'budgets.update',permission:'budget:write',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignTarget=randomUUID(),foreignOwner=randomUUID();
  const insert=f.database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,'tenant',NULL,?,?,800,1000,'UTC',1,?,?)");
  insert.run(target,f.tenantId,'monthly','tokens',AT,AT);
  insert.run(staleTarget,f.tenantId,'daily','tokens',AT,AT+1);
  insert.run(otherTarget,f.tenantId,'weekly','tokens',AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-budget-patch','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-budget-patch.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  insert.run(foreignTarget,foreignTenant,'monthly','tokens',AT,AT);

  const listed=(await f.adapter.execute('budgets.list',f.request(null))).body as {items:Array<{id:string;version?:number}>};
  assert.equal(listed.items.find(budget=>budget.id===target)?.version,AT,'the list contract must supply the update fence');
  const update=(adapter:typeof f.adapter,id:string,body:unknown,version:number,key:string)=>{
    const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('budgets.update',request);
  };

  const missingMatch=await f.adapter.execute('budgets.update',f.request({hardLimit:1100},{id:target}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const stale=await update(f.adapter,staleTarget,{hardLimit:1100},AT,'stale-budget-update');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await update(f.adapter,foreignTarget,{hardLimit:1100},AT,'foreign-budget-update')).status,404);

  const key='durable-budget-update',accepted=await update(f.adapter,target,{softLimit:null,hardLimit:1200,enabled:false},AT,key);
  const replay=await update(f.makeAdapter(),target,{softLimit:null,hardLimit:1200,enabled:false},AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original row version and audit receipt');
  assert.deepEqual({softLimit:item(accepted).softLimit,hardLimit:item(accepted).hardLimit,timezone:item(accepted).timezone,enabled:item(accepted).enabled,version:item(accepted).version},
    {softLimit:null,hardLimit:1200,timezone:'UTC',enabled:false,version:AT+1},'explicit null must clear the soft limit while omitted fields stay unchanged');
  assert.equal((await update(f.adapter,otherTarget,{hardLimit:1300},AT,key)).status,409);
  assert.equal((await update(f.adapter,target,{softLimit:null,hardLimit:1200,enabled:false},AT+1,key)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request({hardLimit:1400},{id:foreignTarget}),AT);
  foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal(item(await f.adapter.execute('budgets.update',foreignRequest)).hardLimit,1400,'the same key belongs to an independent tenant scope');

  assert.deepEqual(f.database.prepare('SELECT soft_limit,hard_limit,timezone,enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {soft_limit:null,hard_limit:1200,timezone:'UTC',enabled:0,updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT hard_limit,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{hard_limit:1000,updated_at:AT+1});
  assert.equal(f.database.prepare('SELECT hard_limit FROM budgets WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherTarget),1000);
  assert.deepEqual(f.database.prepare('SELECT hard_limit,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{hard_limit:1400,updated_at:AT+1});
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.tenant_setting_changed'&&(input.metadata as {kind?:unknown}|undefined)?.kind==='budget_updated').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target,metadata:{kind:'budget_updated'}},{target:foreignTarget,metadata:{kind:'budget_updated'}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-budget-update:budgets.update'"),2);
  f.database.close();
});

test('budget PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,'tenant',NULL,'monthly','tokens',800,1000,'UTC',1,?,?)").run(target,f.tenantId,AT,AT);
  const request=withMatch(f.request({hardLimit:1200},{id:target}),AT);request.headers.set('Idempotency-Key','rollback-budget-update');
  await assert.rejects(f.adapter.execute('budgets.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT hard_limit,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),{hard_limit:1000,updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-budget-update:budgets.update'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('budgets.update',request);
  assert.deepEqual({hardLimit:item(accepted).hardLimit,version:item(accepted).version},{hardLimit:1200,version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT hard_limit,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),{hard_limit:1200,updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-budget-update:budgets.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('budgets.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('budget DELETE reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='DELETE'&&definition.path==='/budgets/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'budgets.delete',permission:'budget:write',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignTarget=randomUUID(),foreignOwner=randomUUID();
  const insert=f.database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,'tenant',NULL,?,?,800,1000,'UTC',1,?,?)");
  insert.run(target,f.tenantId,'monthly','tokens',AT,AT);
  insert.run(staleTarget,f.tenantId,'daily','tokens',AT,AT+1);
  insert.run(otherTarget,f.tenantId,'weekly','tokens',AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-budget-delete','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-budget-delete.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  insert.run(foreignTarget,foreignTenant,'monthly','tokens',AT,AT);

  const listed=(await f.adapter.execute('budgets.list',f.request(null))).body as {items:Array<{id:string;version?:number}>};
  assert.equal(listed.items.find(budget=>budget.id===target)?.version,AT,'the list contract must supply the destructive-write fence');
  const remove=(adapter:typeof f.adapter,id:string,version:number,key:string)=>{
    const request=withMatch(f.request(null,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('budgets.delete',request);
  };

  const missingMatch=await f.adapter.execute('budgets.delete',f.request(null,{id:target}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const stale=await remove(f.adapter,staleTarget,AT,'stale-budget-delete');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await remove(f.adapter,foreignTarget,AT,'foreign-budget-delete')).status,404);

  const key='durable-budget-delete',accepted=await remove(f.adapter,target,AT,key);
  const replay=await remove(f.makeAdapter(),target,AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original 204 after the row version advances');
  assert.equal(accepted.status,204);
  assert.equal((await remove(f.adapter,otherTarget,AT,key)).status,409);
  assert.equal((await remove(f.adapter,target,AT+1,key)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request(null,{id:foreignTarget}),AT);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal((await f.adapter.execute('budgets.delete',foreignRequest)).status,204,'the same key belongs to an independent tenant scope');

  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:0,updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{enabled:1,updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,otherTarget),{enabled:1,updated_at:AT});
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{enabled:0,updated_at:AT+1});
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.tenant_setting_changed'&&(input.metadata as {kind?:unknown}|undefined)?.kind==='budget_disabled').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target,metadata:{kind:'budget_disabled'}},{target:foreignTarget,metadata:{kind:'budget_disabled'}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-budget-delete:budgets.delete'"),2);
  f.database.close();
});

test('budget DELETE rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO budgets(id,tenant_id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,'tenant',NULL,'monthly','tokens',800,1000,'UTC',1,?,?)").run(target,f.tenantId,AT,AT);
  const request=withMatch(f.request(null,{id:target}),AT);request.headers.set('Idempotency-Key','rollback-budget-delete');
  await assert.rejects(f.adapter.execute('budgets.delete',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:1,updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-budget-delete:budgets.delete'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('budgets.delete',request);
  assert.equal(accepted.status,204);
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:0,updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-budget-delete:budgets.delete'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('budgets.delete',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('settings PATCH fences stale writes, replays exactly, and isolates the same key by tenant',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/admin/settings');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.settings.update',permission:'admin:settings',ifMatch:true,idempotency:true});
  const f=fixture(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID(),missingTenant=randomUUID() as TenantId,missingOwner=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-settings-patch','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(foreignTenant,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-settings.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'missing-settings-patch','Missing','active',?,?)").run(missingTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@missing-settings.test','Missing owner','hash','active',?,?)").run(missingOwner,missingTenant,AT,AT);

  const read=await f.adapter.execute('admin.settings.get',f.request(null));
  assert.equal((read.body as {updated_at?:number}).updated_at,AT,'the read contract must supply the settings fence');
  const update=(adapter:typeof f.adapter,body:unknown,version:number,key:string)=>{
    const request=withMatch(f.request(body),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('admin.settings.update',request);
  };
  const scoped=(tenantId:TenantId,userId:string,body:unknown,version:number,key:string):RouteRequest=>{
    const base=withMatch(f.request(body),version);base.headers.set('Idempotency-Key',key);
    const principal:RequestPrincipal={...base.tenant!.principal,tenantId,userId,membershipId:userId};
    return {...base,tenant:{...base.tenant!,principal,db:forTenant({tenantId})}};
  };

  const missingMatch=await f.adapter.execute('admin.settings.update',f.request({requestsPerMinute:90}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  f.database.prepare('UPDATE tenant_settings SET updated_at=? WHERE tenant_id=?').run(AT+1,f.tenantId);
  const stale=await update(f.adapter,{requestsPerMinute:90},AT,'stale-settings-update');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  f.database.prepare('UPDATE tenant_settings SET updated_at=? WHERE tenant_id=?').run(AT,f.tenantId);
  assert.equal((await f.adapter.execute('admin.settings.update',scoped(missingTenant,missingOwner,{requestsPerMinute:90},AT,'missing-settings-update'))).status,404);

  const key='durable-settings-update',body={defaultLocale:'ja',requestsPerMinute:120,brandName:'Acme AI'};
  const accepted=await update(f.adapter,body,AT,key),replay=await update(f.makeAdapter(),body,AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original settings row version and audit receipt');
  assert.deepEqual({defaultLocale:item(accepted).default_locale,requestsPerMinute:item(accepted).requests_per_minute,brandName:item(accepted).brand_name,version:item(accepted).updated_at},
    {defaultLocale:'ja',requestsPerMinute:120,brandName:'Acme AI',version:AT+1});
  assert.equal((await update(f.adapter,{...body,requestsPerMinute:121},AT,key)).status,409);
  assert.equal((await update(f.adapter,body,AT+1,key)).status,409,'the key cannot reconcile a different precondition');
  assert.equal(item(await f.adapter.execute('admin.settings.update',scoped(foreignTenant,foreignOwner,{defaultLocale:'zh-TW'},AT,key))).default_locale,'zh-TW','the same key belongs to an independent tenant scope');

  assert.deepEqual(f.database.prepare('SELECT default_locale,requests_per_minute,brand_name,updated_at FROM tenant_settings WHERE tenant_id=?').get(f.tenantId),{default_locale:'ja',requests_per_minute:120,brand_name:'Acme AI',updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT default_locale,updated_at FROM tenant_settings WHERE tenant_id=?').get(foreignTenant),{default_locale:'zh-TW',updated_at:AT+1});
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.tenant_setting_changed'&&input.target?.type==='tenant').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target:f.tenantId,metadata:{fields:['defaultLocale','requestsPerMinute','brandName']}},{target:foreignTenant,metadata:{fields:['defaultLocale']}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-settings-update:admin.settings.update'"),2);
  f.database.close();
});

test('settings PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=withMatch(f.request({defaultLocale:'ja',requestsPerMinute:120,brandName:'Rollback brand'}),AT);
  request.headers.set('Idempotency-Key','rollback-settings-update');
  await assert.rejects(f.adapter.execute('admin.settings.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT default_locale,requests_per_minute,brand_name,updated_at FROM tenant_settings WHERE tenant_id=?').get(f.tenantId),{default_locale:'en',requests_per_minute:60,brand_name:null,updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-settings-update:admin.settings.update'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.settings.update',request);
  assert.deepEqual({defaultLocale:item(accepted).default_locale,requestsPerMinute:item(accepted).requests_per_minute,brandName:item(accepted).brand_name,version:item(accepted).updated_at},
    {defaultLocale:'ja',requestsPerMinute:120,brandName:'Rollback brand',version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT default_locale,requests_per_minute,brand_name,updated_at FROM tenant_settings WHERE tenant_id=?').get(f.tenantId),{default_locale:'ja',requests_per_minute:120,brand_name:'Rollback brand',updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-settings-update:admin.settings.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.settings.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('group membership PUT and DELETE share a version fence, replay exactly, and stay tenant-scoped',async()=>{
  const routes=routeDefinitions.filter(definition=>definition.path==='/admin/groups/:id/members/:userId');
  assert.deepEqual(routes.map(route=>({method:route.method,operation:route.operation,ifMatch:route.ifMatch,idempotency:route.idempotency})),[
    {method:'PUT',operation:'admin.groups.addMember',ifMatch:true,idempotency:true},
    {method:'DELETE',operation:'admin.groups.removeMember',ifMatch:true,idempotency:true},
  ]);
  const f=fixture(),groupId=randomUUID(),otherGroup=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignGroup=randomUUID(),foreignOwner=randomUUID(),foreignMember=randomUUID();
  const insertGroup=f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)');
  insertGroup.run(groupId,f.tenantId,'Membership target',AT,AT);
  insertGroup.run(otherGroup,f.tenantId,'Membership other',AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-membership','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  insertGroup.run(foreignGroup,foreignTenant,'Foreign membership target',AT,AT);
  const insertUser=f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)");
  insertUser.run(foreignOwner,foreignTenant,'owner@foreign-membership.test','Foreign owner',AT,AT);
  insertUser.run(foreignMember,foreignTenant,'member@foreign-membership.test','Foreign member',AT,AT);
  const change=(adapter:typeof f.adapter,operation:'admin.groups.addMember'|'admin.groups.removeMember',id:string,userId:string,version:number,key:string)=>{
    const request=withMatch(f.request(operation==='admin.groups.addMember'?{}:null,{id,userId}),version);
    request.headers.set('Idempotency-Key',key);return adapter.execute(operation,request);
  };

  const missingMatch=await f.adapter.execute('admin.groups.addMember',f.request({}, {id:groupId,userId:f.memberId}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const addKey='durable-membership-add';
  const acceptedAdd=await change(f.adapter,'admin.groups.addMember',groupId,f.memberId,AT,addKey);
  const replayedAdd=await change(f.makeAdapter(),'admin.groups.addMember',groupId,f.memberId,AT,addKey);
  assert.equal(acceptedAdd.status,204);assert.deepEqual(replayedAdd,acceptedAdd);
  assert.equal(await change(f.adapter,'admin.groups.addMember',otherGroup,f.memberId,AT,addKey).then(result=>result.status),409);
  assert.equal((await change(f.adapter,'admin.groups.addMember',groupId,f.memberId,AT+1,addKey)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request({}, {id:foreignGroup,userId:foreignMember}),AT);
  foreignBase.headers.set('Idempotency-Key',addKey);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal((await f.adapter.execute('admin.groups.addMember',foreignRequest)).status,204,'the same key belongs to an independent tenant scope');

  const staleRemove=await change(f.adapter,'admin.groups.removeMember',groupId,f.memberId,AT,'stale-membership-remove');
  assert.equal(staleRemove.status,412);assert.equal(errorCode(staleRemove),'PRECONDITION_FAILED');
  assert.equal((await change(f.adapter,'admin.groups.addMember',foreignGroup,foreignMember,AT+1,'cross-tenant-group')).status,404);
  assert.equal((await change(f.adapter,'admin.groups.addMember',otherGroup,foreignMember,AT,'cross-tenant-user')).status,404);

  const removeKey='durable-membership-remove';
  const acceptedRemove=await change(f.adapter,'admin.groups.removeMember',groupId,f.memberId,AT+1,removeKey);
  const replayedRemove=await change(f.makeAdapter(),'admin.groups.removeMember',groupId,f.memberId,AT+1,removeKey);
  assert.equal(acceptedRemove.status,204);assert.deepEqual(replayedRemove,acceptedRemove);
  assert.equal((await change(f.adapter,'admin.groups.removeMember',groupId,f.memberId,AT+2,removeKey)).status,409,'the remove key also binds its precondition');

  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=?',f.tenantId,groupId),0);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=?',foreignTenant,foreignGroup,foreignMember),1);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,groupId),AT+2);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherGroup),AT);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(foreignTenant,foreignGroup),AT+1);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.group_membership_changed').map(input=>input.metadata),[
    {userId:f.memberId,change:'added',fromVersion:AT,toVersion:AT+1},
    {userId:foreignMember,change:'added',fromVersion:AT,toVersion:AT+1},
    {userId:f.memberId,change:'removed',fromVersion:AT+1,toVersion:AT+2},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path LIKE 'admin-group-membership:%'"),3);
  f.database.close();
});

test('group membership PUT and DELETE roll back and leave their idempotency keys reusable',async()=>{
  const f=fixture(true),addGroup=randomUUID(),removeGroup=randomUUID();
  const insertGroup=f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)');
  insertGroup.run(addGroup,f.tenantId,'Rollback membership add',AT,AT);
  insertGroup.run(removeGroup,f.tenantId,'Rollback membership remove',AT,AT);
  f.database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(f.tenantId,removeGroup,f.memberId,AT);
  const request=(operation:'admin.groups.addMember'|'admin.groups.removeMember',id:string,key:string)=>{
    const value=withMatch(f.request(operation==='admin.groups.addMember'?{}:null,{id,userId:f.memberId}),AT);
    value.headers.set('Idempotency-Key',key);return value;
  };
  const addRequest=request('admin.groups.addMember',addGroup,'rollback-membership-add');
  const removeRequest=request('admin.groups.removeMember',removeGroup,'rollback-membership-remove');
  await assert.rejects(f.adapter.execute('admin.groups.addMember',addRequest),/forced invitation audit failure/u);
  await assert.rejects(f.adapter.execute('admin.groups.removeMember',removeRequest),/forced invitation audit failure/u);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=?',f.tenantId,addGroup),0);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=?',f.tenantId,removeGroup,f.memberId),1);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE id=?').pluck().get(addGroup),AT);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE id=?').pluck().get(removeGroup),AT);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path LIKE 'admin-group-membership:%'"),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const acceptedAdd=await f.adapter.execute('admin.groups.addMember',addRequest);
  const acceptedRemove=await f.adapter.execute('admin.groups.removeMember',removeRequest);
  assert.equal(acceptedAdd.status,204);assert.equal(acceptedRemove.status,204);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=?',f.tenantId,addGroup,f.memberId),1);
  assert.equal(f.count('SELECT COUNT(*) FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=?',f.tenantId,removeGroup,f.memberId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PUT' AND path='admin-group-membership:admin.groups.addMember'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-group-membership:admin.groups.removeMember'",f.tenantId),1);

  const replayedAdd=await f.makeAdapter().execute('admin.groups.addMember',addRequest);
  const replayedRemove=await f.makeAdapter().execute('admin.groups.removeMember',removeRequest);
  assert.deepEqual(replayedAdd,acceptedAdd,'a fresh adapter must replay the recovered success from the database');
  assert.deepEqual(replayedRemove,acceptedRemove,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('group-model PUT and DELETE share a version fence, replay exactly, and stay tenant-scoped',async()=>{
  const routes=routeDefinitions.filter(definition=>definition.path==='/admin/groups/:groupId/models/:modelId');
  assert.deepEqual(routes.map(route=>({method:route.method,operation:route.operation,ifMatch:route.ifMatch,idempotency:route.idempotency})),[
    {method:'PUT',operation:'admin.models.enableForGroup',ifMatch:true,idempotency:true},
    {method:'DELETE',operation:'admin.models.disableForGroup',ifMatch:true,idempotency:true},
  ]);
  const f=fixture(),groupId=randomUUID(),otherGroup=randomUUID(),modelId=randomUUID(),otherModel=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignGroup=randomUUID(),foreignModel=randomUUID(),foreignOwner=randomUUID();
  const insertGroup=f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)');
  insertGroup.run(groupId,f.tenantId,'Model access target',AT,AT);insertGroup.run(otherGroup,f.tenantId,'Model access other',AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-model-access','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  insertGroup.run(foreignGroup,foreignTenant,'Foreign model access target',AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-model-access.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  const insertModel=f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai',?,?,1,4096,512,0,0,'[]',?,?)");
  insertModel.run(modelId,f.tenantId,'group-access-local','Local access model',AT,AT);
  insertModel.run(otherModel,f.tenantId,'group-access-other','Other access model',AT,AT);
  insertModel.run(foreignModel,foreignTenant,'group-access-foreign','Foreign access model',AT,AT);
  const change=(adapter:typeof f.adapter,operation:'admin.models.enableForGroup'|'admin.models.disableForGroup',id:string,selectedModel:string,version:number,key:string)=>{
    const request=withMatch(f.request(operation==='admin.models.enableForGroup'?{}:null,{groupId:id,modelId:selectedModel}),version);
    request.headers.set('Idempotency-Key',key);return adapter.execute(operation,request);
  };

  const missingMatch=await f.adapter.execute('admin.models.enableForGroup',f.request({}, {groupId,modelId}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const enableKey='durable-group-model-enable';
  const acceptedEnable=await change(f.adapter,'admin.models.enableForGroup',groupId,modelId,AT,enableKey);
  const replayedEnable=await change(f.makeAdapter(),'admin.models.enableForGroup',groupId,modelId,AT,enableKey);
  assert.equal(acceptedEnable.status,204);assert.deepEqual(replayedEnable,acceptedEnable);
  assert.equal((await change(f.adapter,'admin.models.enableForGroup',otherGroup,otherModel,AT,enableKey)).status,409);
  assert.equal((await change(f.adapter,'admin.models.enableForGroup',groupId,modelId,AT+1,enableKey)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request({}, {groupId:foreignGroup,modelId:foreignModel}),AT);
  foreignBase.headers.set('Idempotency-Key',enableKey);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal((await f.adapter.execute('admin.models.enableForGroup',foreignRequest)).status,204,'the same key belongs to an independent tenant scope');

  const staleDisable=await change(f.adapter,'admin.models.disableForGroup',groupId,modelId,AT,'stale-group-model-disable');
  assert.equal(staleDisable.status,412);assert.equal(errorCode(staleDisable),'PRECONDITION_FAILED');
  assert.equal((await change(f.adapter,'admin.models.enableForGroup',foreignGroup,foreignModel,AT+1,'cross-tenant-group-model')).status,404);
  assert.equal((await change(f.adapter,'admin.models.enableForGroup',otherGroup,foreignModel,AT,'cross-tenant-model')).status,404);

  const disableKey='durable-group-model-disable';
  const acceptedDisable=await change(f.adapter,'admin.models.disableForGroup',groupId,modelId,AT+1,disableKey);
  const replayedDisable=await change(f.makeAdapter(),'admin.models.disableForGroup',groupId,modelId,AT+1,disableKey);
  assert.equal(acceptedDisable.status,204);assert.deepEqual(replayedDisable,acceptedDisable);
  assert.equal((await change(f.adapter,'admin.models.disableForGroup',groupId,modelId,AT+2,disableKey)).status,409,'the delete key also binds its precondition');

  assert.equal(f.database.prepare('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?').pluck().get(groupId,modelId),0);
  assert.equal(f.database.prepare('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?').pluck().get(foreignGroup,foreignModel),1);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,groupId),AT+2);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherGroup),AT);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE tenant_id=? AND id=?').pluck().get(foreignTenant,foreignGroup),AT+1);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.model_access_changed').map(input=>input.metadata),[
    {groupId,enabled:true,fromVersion:AT,toVersion:AT+1},
    {groupId:foreignGroup,enabled:true,fromVersion:AT,toVersion:AT+1},
    {groupId,enabled:false,fromVersion:AT+1,toVersion:AT+2},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path LIKE 'admin-group-model-access:%'"),3);
  f.database.close();
});

test('group-model PUT and DELETE roll back and leave their idempotency keys reusable',async()=>{
  const f=fixture(true),enableGroup=randomUUID(),disableGroup=randomUUID(),modelId=randomUUID();
  const insertGroup=f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)');
  insertGroup.run(enableGroup,f.tenantId,'Rollback model enable',AT,AT);insertGroup.run(disableGroup,f.tenantId,'Rollback model disable',AT,AT);
  f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai','rollback-group-model','Rollback group model',1,4096,512,0,0,'[]',?,?)").run(modelId,f.tenantId,AT,AT);
  f.database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(disableGroup,modelId);
  const request=(operation:'admin.models.enableForGroup'|'admin.models.disableForGroup',groupId:string,key:string)=>{
    const value=withMatch(f.request(operation==='admin.models.enableForGroup'?{}:null,{groupId,modelId}),AT);
    value.headers.set('Idempotency-Key',key);return value;
  };
  const enableRequest=request('admin.models.enableForGroup',enableGroup,'rollback-group-model-enable');
  const disableRequest=request('admin.models.disableForGroup',disableGroup,'rollback-group-model-disable');
  await assert.rejects(f.adapter.execute('admin.models.enableForGroup',enableRequest),/forced invitation audit failure/u);
  await assert.rejects(f.adapter.execute('admin.models.disableForGroup',disableRequest),/forced invitation audit failure/u);
  assert.equal(f.count('SELECT COUNT(*) FROM group_model_access WHERE group_id=? AND model_catalog_id=?',enableGroup,modelId),0);
  assert.equal(f.database.prepare('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?').pluck().get(disableGroup,modelId),1);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE id=?').pluck().get(enableGroup),AT);
  assert.equal(f.database.prepare('SELECT updated_at FROM groups WHERE id=?').pluck().get(disableGroup),AT);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path LIKE 'admin-group-model-access:%'"),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const acceptedEnable=await f.adapter.execute('admin.models.enableForGroup',enableRequest);
  const acceptedDisable=await f.adapter.execute('admin.models.disableForGroup',disableRequest);
  assert.equal(acceptedEnable.status,204);assert.equal(acceptedDisable.status,204);
  assert.equal(f.database.prepare('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?').pluck().get(enableGroup,modelId),1);
  assert.equal(f.database.prepare('SELECT enabled FROM group_model_access WHERE group_id=? AND model_catalog_id=?').pluck().get(disableGroup,modelId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PUT' AND path='admin-group-model-access:admin.models.enableForGroup'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-group-model-access:admin.models.disableForGroup'",f.tenantId),1);

  const replayedEnable=await f.makeAdapter().execute('admin.models.enableForGroup',enableRequest);
  const replayedDisable=await f.makeAdapter().execute('admin.models.disableForGroup',disableRequest);
  assert.deepEqual(replayedEnable,acceptedEnable,'a fresh adapter must replay the recovered success from the database');
  assert.deepEqual(replayedDisable,acceptedDisable,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('model PATCH reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/admin/models/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.models.update',permission:'model:write',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignTarget=randomUUID(),foreignOwner=randomUUID();
  const insert=f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai',?,?,1,4096,512,3,7,'[\"text\"]',?,?)");
  insert.run(target,f.tenantId,'model-patch-target','Patch target',AT,AT);
  insert.run(staleTarget,f.tenantId,'model-patch-stale','Stale target',AT,AT+1);
  insert.run(otherTarget,f.tenantId,'model-patch-other','Other target',AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-model-patch','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-model-patch.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  insert.run(foreignTarget,foreignTenant,'model-patch-foreign','Foreign target',AT,AT);

  const listed=(await f.adapter.execute('admin.models.list',f.request(null))).body as {items:Array<{id:string;version?:number}>};
  assert.equal(listed.items.find(model=>model.id===target)?.version,AT,'the list contract must supply the update fence');
  const update=(adapter:typeof f.adapter,id:string,body:unknown,version:number,key:string)=>{
    const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('admin.models.update',request);
  };

  const missingMatch=await f.adapter.execute('admin.models.update',f.request({displayName:'No fence'},{id:target}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const stale=await update(f.adapter,staleTarget,{displayName:'Stale overwrite'},AT,'stale-model-update');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await update(f.adapter,foreignTarget,{displayName:'Cross-tenant overwrite'},AT,'foreign-model-update')).status,404);

  const key='durable-model-update',accepted=await update(f.adapter,target,{displayName:'Renamed model',enabled:false},AT,key);
  const replay=await update(f.makeAdapter(),target,{displayName:'Renamed model',enabled:false},AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original row version and audit receipt');
  assert.deepEqual({displayName:item(accepted).displayName,enabled:item(accepted).enabled,context:item(accepted).contextWindowTokens,outputPrice:item(accepted).outputPriceMicroUsdPerMillion,version:item(accepted).version},
    {displayName:'Renamed model',enabled:false,context:4096,outputPrice:7,version:AT+1},'omitted PATCH fields must be preserved');
  assert.equal((await update(f.adapter,otherTarget,{displayName:'Conflicting model'},AT,key)).status,409);
  assert.equal((await update(f.adapter,target,{displayName:'Renamed model',enabled:false},AT+1,key)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request({displayName:'Foreign renamed'},{id:foreignTarget}),AT);
  foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal(item(await f.adapter.execute('admin.models.update',foreignRequest)).displayName,'Foreign renamed','the same key belongs to an independent tenant scope');

  assert.deepEqual(f.database.prepare('SELECT display_name,enabled,context_window,output_microusd_per_million,updated_at FROM model_catalog WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {display_name:'Renamed model',enabled:0,context_window:4096,output_microusd_per_million:7,updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM model_catalog WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{display_name:'Stale target',updated_at:AT+1});
  assert.equal(f.database.prepare('SELECT display_name FROM model_catalog WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherTarget),'Other target');
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM model_catalog WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{display_name:'Foreign renamed',updated_at:AT+1});
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='admin.model_access_changed').map(input=>({target:input.target?.id,metadata:input.metadata})),[
    {target,metadata:{pricingChanged:false}},{target:foreignTarget,metadata:{pricingChanged:false}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-model-update:admin.models.update'"),2);
  f.database.close();
});

test('model PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai','rollback-model-patch','Rollback model',1,4096,512,3,7,'[]',?,?)").run(target,f.tenantId,AT,AT);
  const request=withMatch(f.request({displayName:'Should roll back'},{id:target}),AT);request.headers.set('Idempotency-Key','rollback-model-update');
  await assert.rejects(f.adapter.execute('admin.models.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM model_catalog WHERE tenant_id=? AND id=?').get(f.tenantId,target),{display_name:'Rollback model',updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-model-update:admin.models.update'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.models.update',request);
  assert.deepEqual({displayName:item(accepted).displayName,version:item(accepted).version},{displayName:'Should roll back',version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM model_catalog WHERE tenant_id=? AND id=?').get(f.tenantId,target),{display_name:'Should roll back',updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-model-update:admin.models.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.models.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('assistant writes require an enabled tenant model and enforce validation and uniqueness',async()=>{
  const f=fixture();
  const enabled=item(await f.adapter.execute('admin.models.create',f.request({provider:'openai',providerModelId:'assistant-enabled',displayName:'Assistant enabled',enabled:true,contextWindowTokens:4096,maxOutputTokens:512,inputPriceMicroUsdPerMillion:1,outputPriceMicroUsdPerMillion:1,capabilities:[]})));
  const disabled=item(await f.adapter.execute('admin.models.create',f.request({provider:'openai',providerModelId:'assistant-disabled',displayName:'Assistant disabled',enabled:false,contextWindowTokens:4096,maxOutputTokens:512,inputPriceMicroUsdPerMillion:1,outputPriceMicroUsdPerMillion:1,capabilities:[]})));
  const created=await f.adapter.execute('admin.assistants.create',f.request({name:'Researcher',description:'Finds facts',systemPrompt:'Be rigorous.',modelCatalogId:enabled.id}));
  assert.equal(created.status,201);assert.deepEqual({name:item(created).name,model:item(created).model,version:item(created).version},{name:'Researcher',model:'Assistant enabled',version:1});
  assert.equal((await f.adapter.execute('admin.assistants.create',f.request({name:'Unknown',systemPrompt:'Help.',modelCatalogId:randomUUID()}))).status,422);
  assert.equal((await f.adapter.execute('admin.assistants.create',f.request({name:'Disabled',systemPrompt:'Help.',modelCatalogId:disabled.id}))).status,422);
  const duplicate=await f.adapter.execute('admin.assistants.create',f.request({name:'Researcher',systemPrompt:'Duplicate.',modelCatalogId:enabled.id}));assert.equal(duplicate.status,409);assert.equal(errorReason(duplicate),'assistant_name_taken');
  assert.equal((await f.adapter.execute('admin.assistants.create',f.request({name:'Long',systemPrompt:'x'.repeat(20_001),modelCatalogId:enabled.id}))).status,422);
  const id=String(item(created).id),version=Number(item(created).version);
  assert.equal((await f.adapter.execute('admin.assistants.update',withMatch(f.request({modelCatalogId:disabled.id},{id}),version))).status,422);
  const updated=await f.adapter.execute('admin.assistants.update',withMatch(f.request({name:'Analyst',systemPrompt:'Analyze carefully.'},{id}),version));assert.equal(item(updated).name,'Analyst');assert.equal(item(updated).version,2);
  f.database.close();
});


test('assistant admin writes durably replay create, update, and delete outcomes',async()=>{
  const f=fixture();
  const model=item(await f.adapter.execute('admin.models.create',f.request({provider:'openai',providerModelId:'assistant-replay-model',displayName:'Assistant replay model',enabled:true,contextWindowTokens:4096,maxOutputTokens:512,inputPriceMicroUsdPerMillion:1,outputPriceMicroUsdPerMillion:1,capabilities:[]})));
  const createBody={name:'Replay assistant',description:'Original',systemPrompt:'Be precise.',modelCatalogId:model.id};
  const createRequest=()=>{const request=f.request(createBody);request.headers.set('Idempotency-Key','assistant-create-replay');return request};
  const created=await f.adapter.execute('admin.assistants.create',createRequest());
  const createdReplay=await f.makeAdapter().execute('admin.assistants.create',createRequest());
  assert.deepEqual(createdReplay,created);assert.equal(f.count("SELECT COUNT(*) FROM assistants WHERE tenant_id=? AND name='Replay assistant'",f.tenantId),1);
  const assistantId=String(item(created).id),version=Number(item(created).version);
  const updateRequest=()=>{const request=withMatch(f.request({name:'Replayed assistant',systemPrompt:'Be exact.',modelCatalogId:model.id},{id:assistantId}),version);request.headers.set('Idempotency-Key','assistant-update-replay');return request};
  const updated=await f.adapter.execute('admin.assistants.update',updateRequest());
  const updatedReplay=await f.makeAdapter().execute('admin.assistants.update',updateRequest());
  assert.deepEqual(updatedReplay,updated);assert.equal(item(updated).name,'Replayed assistant');
  const deleteRequest=()=>{const request=withMatch(f.request(null,{id:assistantId}),Number(item(updated).version));request.headers.set('Idempotency-Key','assistant-delete-replay');return request};
  const deleted=await f.adapter.execute('admin.assistants.delete',deleteRequest());
  const deletedReplay=await f.makeAdapter().execute('admin.assistants.delete',deleteRequest());
  assert.deepEqual(deletedReplay,deleted);assert.equal(deleted.status,204);assert.equal(f.count('SELECT COUNT(*) FROM assistants WHERE tenant_id=? AND id=?',f.tenantId,assistantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-assistant-create:admin.assistants.create'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-assistant-update:admin.assistants.update'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-assistant-delete:admin.assistants.delete'",f.tenantId),1);
  f.database.close();
});

test('an admin idempotency key cannot reconcile a different user mutation',async()=>{
  const f=fixture(),secondMember=randomUUID(),key='shared-seat-mutation';
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Second','hash','active',?,?)")
    .run(secondMember,f.tenantId,'second@acme.test',AT,AT);
  const mutation=(body:unknown,id:string):RouteRequest=>({...f.request(body,{id}),headers:new Headers({'Idempotency-Key':key,'If-Match':`"${AT}"`})});

  await f.adapter.execute('admin.users.update',mutation({status:'suspended'},f.memberId));
  assert.deepEqual(f.database.prepare('SELECT status FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{status:'suspended'});

  const differentTarget=await f.adapter.execute('admin.users.update',mutation({status:'suspended'},secondMember));
  assert.equal(differentTarget.status,409);assert.equal(errorCode(differentTarget),'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.database.prepare('SELECT status FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,secondMember),{status:'active'},'the conflicting user update must roll back');

  const exactRetry=await f.adapter.execute('admin.users.update',mutation({status:'suspended'},f.memberId));
  assert.equal(exactRetry.status,undefined);
  const differentBody=await f.adapter.execute('admin.users.update',mutation({status:'active'},f.memberId));
  assert.equal(differentBody.status,409);assert.equal(errorCode(differentBody),'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.database.prepare('SELECT status FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{status:'suspended'},'the conflicting body must roll back');
  f.database.close();
});

test('user status transitions add specific audit rows without replacing the generic receipt',async()=>{
  const f=fixture(false,undefined,':memory:',true),disabledRequest=withMatch(f.request({status:'suspended'},{id:f.memberId}),AT);
  const disabled=await f.adapter.execute('admin.users.update',disabledRequest);
  const receipt=(disabled.body as {auditEventId:string}).auditEventId;
  const rows=()=>f.database.prepare("SELECT id,action,actor_id,actor_session_id,request_id,metadata_json FROM audit_events WHERE tenant_id=? AND action IN ('admin.user_updated','admin.user_disabled','admin.user_enabled') ORDER BY sequence").all(f.tenantId) as Array<Record<string,unknown>>;
  let auditRows=rows();
  assert.deepEqual(auditRows.map(row=>row.action),['admin.user_updated','admin.user_disabled']);
  assert.equal(auditRows[0]!.id,receipt,'the response keeps the generic user_updated receipt');
  assert.deepEqual(JSON.parse(String(auditRows[1]!.metadata_json)),{});
  assert.deepEqual({actor:auditRows[1]!.actor_id,session:auditRows[1]!.actor_session_id,request:auditRows[1]!.request_id},{actor:f.userId,session:disabledRequest.tenant!.principal.sessionId,request:disabledRequest.requestId});
  const enableRequest=withMatch(f.request({status:'active'},{id:f.memberId}),AT+1);await f.adapter.execute('admin.users.update',enableRequest);
  const alreadyActiveRequest=withMatch(f.request({status:'active'},{id:f.memberId}),AT+2);await f.adapter.execute('admin.users.update',alreadyActiveRequest);
  auditRows=rows();
  assert.equal(auditRows.filter(row=>row.action==='admin.user_enabled').length,1);
  assert.equal(auditRows.filter(row=>row.action==='admin.user_disabled').length,1);
  f.database.close();
});

test('user status updates accept only active and suspended on an active or suspended account',async()=>{
  const f=fixture();
  for(const [index,status] of ['invited','deprovisioned','unknown'].entries()){
    const id=randomUUID();f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Status target','hash','active',?,?)").run(id,f.tenantId,`status-${index}@acme.test`,AT,AT);
    const response=await f.adapter.execute('admin.users.update',withMatch(f.request({status},{id}),AT));
    assert.equal(response.status,422,status);assert.deepEqual(f.database.prepare('SELECT status,deleted_at,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,id),{status:'active',deleted_at:null,updated_at:AT},status);
  }
  const invited=randomUUID();f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,status,created_at,updated_at) VALUES(?,?,?,'Invited','invited',?,?)").run(invited,f.tenantId,'status-invited@acme.test',AT,AT);
  const invitedChange=await f.adapter.execute('admin.users.update',withMatch(f.request({status:'active'},{id:invited}),AT));
  assert.equal(invitedChange.status,422);assert.equal(errorReason(invitedChange),'resource_changed');assert.deepEqual(f.database.prepare('SELECT status,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,invited),{status:'invited',updated_at:AT});
  const valid=randomUUID();f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Valid status','hash','active',?,?)").run(valid,f.tenantId,'status-valid@acme.test',AT,AT);
  const suspended=await f.adapter.execute('admin.users.update',withMatch(f.request({status:'suspended'},{id:valid}),AT));assert.equal(suspended.status??200,200);
  const enabled=await f.adapter.execute('admin.users.update',withMatch(f.request({status:'active'},{id:valid}),AT+1));assert.equal(enabled.status??200,200);
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,valid),{status:'active',deleted_at:null});f.database.close();
});

test('user PATCH reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/admin/users/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'admin.users.update',permission:'admin:users',ifMatch:true,idempotency:true});
  const directory=mkdtempSync(join(tmpdir(),'gateway-user-patch-')),databasePath=join(directory,'admin.sqlite');
  const f=fixture(false,undefined,databasePath),staleTarget=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignTarget=randomUUID();let second:Database.Database|undefined;
  try{
    f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Stale member','hash','active',?,?)")
      .run(staleTarget,f.tenantId,'stale-user-patch@acme.test',AT,AT+1);
    f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-user-patch','Foreign','active',?,?)").run(foreignTenant,AT,AT);
    f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-user-patch.test','Foreign owner','hash','active',?,?)")
      .run(foreignTarget,foreignTenant,AT,AT);

    const read=await f.adapter.execute('admin.users.get',f.request(null,{id:f.memberId}));
    assert.equal((read.body as {version?:number}).version,AT,'the read contract must supply the update fence');
    const update=(adapter:typeof f.adapter,id:string,body:unknown,version:number,key:string)=>{
      const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
      return adapter.execute('admin.users.update',request);
    };

    const missingMatch=await f.adapter.execute('admin.users.update',f.request({displayName:'No fence'},{id:f.memberId}));
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{display_name:'Member',updated_at:AT});
    assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
    const stale=await update(f.adapter,staleTarget,{displayName:'Stale overwrite'},AT,'stale-user-update');
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),
      {display_name:'Stale member',updated_at:AT+1},'a stale user PATCH must not reach the row');
    assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
    const missingTarget=randomUUID(),missing=await update(f.adapter,missingTarget,{displayName:'Missing overwrite'},AT,'missing-user-update');
    assert.equal(f.count('SELECT COUNT(*) FROM users WHERE tenant_id=? AND id=?',f.tenantId,missingTarget),0);assert.equal(missing.status,404);
    const crossTenant=await update(f.adapter,foreignTarget,{displayName:'Cross-tenant overwrite'},AT,'foreign-user-update');
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{display_name:'Foreign owner',updated_at:AT});
    assert.equal(crossTenant.status,404);

    const key='durable-user-update',body={displayName:'Renamed member'},accepted=await update(f.adapter,f.memberId,body,AT,key);
    assert.deepEqual({displayName:item(accepted).displayName,version:item(accepted).version},{displayName:'Renamed member',version:AT+1});
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{display_name:'Renamed member',updated_at:AT+1});
    second=new Database(databasePath);second.pragma('foreign_keys=ON');second.pragma('journal_mode=WAL');second.pragma('busy_timeout=5000');
    const replay=await update(f.makeAdapter(undefined,undefined,second),f.memberId,body,AT,key);
    assert.deepEqual(replay,accepted,'a fresh adapter must replay the original row version and audit receipt');
    assert.equal(item(replay).version,item(accepted).version);assert.equal((replay.body as {auditEventId?:unknown}).auditEventId,(accepted.body as {auditEventId?:unknown}).auditEventId);
    assert.equal(f.events.filter(action=>action==='admin.user_updated').length,1,'replay and rejected writes must not append success audits');
    assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-user-mutation:admin.users.update'",f.tenantId),1);

    const conflicting=await update(f.adapter,f.memberId,body,AT+1,key);
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),
      {display_name:'Renamed member',updated_at:AT+1},'a key reused with another precondition must not reach the row');
    assert.equal(conflicting.status,409);assert.equal(errorCode(conflicting),'IDEMPOTENCY_CONFLICT');

    const foreignBase=withMatch(f.request({displayName:'Foreign renamed'},{id:foreignTarget}),AT);foreignBase.headers.set('Idempotency-Key',key);
    const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignTarget,membershipId:foreignTarget};
    const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
    assert.equal(item(await f.adapter.execute('admin.users.update',foreignRequest)).version,AT+1,'the same key belongs to an independent tenant scope');
    assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{display_name:'Foreign renamed',updated_at:AT+1});
    assert.equal(f.events.filter(action=>action==='admin.user_updated').length,2);
    assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE method='PATCH' AND path='admin-user-mutation:admin.users.update'"),2);
  }finally{second?.close();f.database.close();rmSync(directory,{recursive:true,force:true})}
});

test('a rolled-back user PATCH does not poison its idempotency key',async()=>{
  const f=fixture(true),request=f.request({displayName:'Should roll back'},{id:f.memberId});
  request.headers.set('If-Match',`"${AT}"`);request.headers.set('Idempotency-Key','rollback-user-update');
  await assert.rejects(f.adapter.execute('admin.users.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{display_name:'Member',updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-user-mutation:admin.users.update'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.users.update',request);
  assert.deepEqual({displayName:item(accepted).displayName,version:item(accepted).version},{displayName:'Should roll back',version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT display_name,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{display_name:'Should roll back',updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-user-mutation:admin.users.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.users.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('a user delete fences stale reads, replays exactly, and cannot cross a tenant or request',async()=>{
  const f=fixture(),secondMember=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID(),key='user-delete';
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Second','hash','active',?,?)")
    .run(secondMember,f.tenantId,'second@acme.test',AT,AT+1);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-delete','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'foreign-delete@example.test','Foreign','hash','active',?,?)")
    .run(foreignUser,foreignTenant,AT,AT);
  const remove=(id:string,version:number,requestKey=key):Promise<{status?:number;body?:unknown}>=>f.adapter.execute('admin.users.delete',{
    ...f.request(null,{id}),headers:new Headers({'Idempotency-Key':requestKey,'If-Match':`"${version}"`}),
  });

  const stale=await remove(secondMember,AT,'stale-user-delete');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,secondMember),{status:'active',deleted_at:null});

  assert.equal((await remove(f.memberId,AT)).status,204);

  assert.equal((await remove(f.memberId,AT)).status,204,'an exact transport retry must remain successful');

  const differentTarget=await remove(secondMember,AT+1);
  assert.equal(differentTarget.status,409);assert.equal(errorCode(differentTarget),'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,secondMember),
    {status:'active',deleted_at:null},'the conflicting delete must roll back');
  assert.equal((await remove(foreignUser,AT,'foreign-user-delete')).status,404);
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(foreignTenant,foreignUser),
    {status:'active',deleted_at:null},'a foreign tenant user must remain untouched');
  assert.equal(f.events.filter(action=>action==='admin.user_deleted').length,1,'stale writes and replays must not append success audits');
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-user-mutation:admin.users.delete'",f.tenantId),1);
  f.database.close();
});

test('user DELETE rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=f.request(null,{id:f.memberId});
  request.headers.set('If-Match',`"${AT}"`);request.headers.set('Idempotency-Key','rollback-user-delete');
  await assert.rejects(f.adapter.execute('admin.users.delete',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{status:'active',deleted_at:null});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-user-mutation:admin.users.delete'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.users.delete',request);
  assert.equal(accepted.status,204);
  assert.deepEqual(f.database.prepare('SELECT status,deleted_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.memberId),{status:'deprovisioned',deleted_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-user-mutation:admin.users.delete'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.users.delete',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('deprovisioning an invited user cancels the outstanding setup link',async()=>{
  const f=fixture(),created=await f.adapter.execute('admin.users.create',f.request({email:'cancel-invite@acme.test',displayName:'Cancelled Invite'})),item=(created.body as {item:{id:string;version:number}}).item;
  assert.equal(f.database.prepare('SELECT superseded_at FROM credential_links WHERE tenant_id=? AND user_id=?').pluck().get(f.tenantId,item.id),null);
  const removed=await f.adapter.execute('admin.users.delete',withMatch(f.request(null,{id:item.id}),item.version));
  assert.equal(removed.status,204);
  assert.equal(f.database.prepare('SELECT superseded_at FROM credential_links WHERE tenant_id=? AND user_id=?').pluck().get(f.tenantId,item.id),AT+1);
  f.database.close();
});

test('force logout revokes only target sessions and durably replays one audited result',async()=>{
  const f=fixture(),foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID(),key='force-member-logout';
  const insertSession=(tenantId:string,userId:string,token:string)=>{
    const id=randomUUID();
    f.database.prepare("INSERT INTO sessions(id,tenant_id,user_id,token_hash,jwt_id,auth_method,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,'password',?,?,?)")
      .run(id,tenantId,userId,token.repeat(64),randomUUID(),AT,AT,AT+60_000);
    return id;
  };
  const memberSessions=[insertSession(f.tenantId,f.memberId,'a'),insertSession(f.tenantId,f.memberId,'b')];
  const ownerSession=insertSession(f.tenantId,f.userId,'c');
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'foreign@example.test','Foreign','hash','active',?,?)").run(foreignUser,foreignTenant,AT,AT);
  const foreignSession=insertSession(foreignTenant,foreignUser,'d');
  const request=f.request({}, {id:f.memberId});request.headers.set('Idempotency-Key',key);

  const first=await f.adapter.execute('admin.users.forceLogout',request);
  assert.deepEqual(first.body,{revoked:2});
  assert.deepEqual(f.database.prepare('SELECT revoked_at,revoke_reason FROM sessions WHERE id IN (?,?) ORDER BY id').all(...memberSessions),[
    {revoked_at:AT,revoke_reason:'admin_forced_logout'},{revoked_at:AT,revoke_reason:'admin_forced_logout'},
  ]);
  assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE id=?').pluck().get(ownerSession),null);
  const audit=f.auditInputs.at(-1);
  assert.equal(audit?.action,'identity.sessions_revoked_all');
  assert.deepEqual(audit?.target,{type:'user',id:f.memberId});
  assert.deepEqual(audit?.metadata,{count:2,reasonCode:'admin_forced_logout'});

  const replay=await f.adapter.execute('admin.users.forceLogout',request);
  assert.deepEqual(replay.body,{revoked:2});
  assert.equal(f.events.filter(action=>action==='identity.sessions_revoked_all').length,1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-user-force-logout:admin.users.forceLogout' AND idempotency_key=?",f.tenantId,key),1);

  const foreign=await f.adapter.execute('admin.users.forceLogout',f.request({}, {id:foreignUser}));
  assert.equal(foreign.status,404);
  assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE id=?').pluck().get(foreignSession),null);
  f.database.close();
});

test('force-logout POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),session=randomUUID();
  f.database.prepare("INSERT INTO sessions(id,tenant_id,user_id,token_hash,jwt_id,auth_method,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,'password',?,?,?)")
    .run(session,f.tenantId,f.memberId,'e'.repeat(64),randomUUID(),AT,AT,AT+60_000);
  const request=f.request({}, {id:f.memberId});request.headers.set('Idempotency-Key','rollback-force-logout');
  await assert.rejects(f.adapter.execute('admin.users.forceLogout',request),/forced invitation audit failure/u);
  assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE id=?').pluck().get(session),null);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-user-force-logout:admin.users.forceLogout'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.users.forceLogout',request);
  assert.deepEqual(accepted.body,{revoked:1});
  assert.equal(f.database.prepare('SELECT revoked_at FROM sessions WHERE id=?').pluck().get(session),AT);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-user-force-logout:admin.users.forceLogout'",f.tenantId),1);
  assert.equal(f.events.filter(action=>action==='identity.sessions_revoked_all').length,1);

  const replay=await f.makeAdapter().execute('admin.users.forceLogout',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  assert.equal(f.events.filter(action=>action==='identity.sessions_revoked_all').length,1);
  f.database.close();
});

test('the rule insert refuses a policy or detector from another tenant', async () => {
  // The two EXISTS guards are the only thing stopping a rule from pointing at another tenant's
  // policy, and they are also where the missing parameter was.
  const f = fixture();
  const other = randomUUID(), foreignPolicy = randomUUID();
  f.database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'bravo','Bravo','active',?,?)`).run(other, AT, AT);
  f.database.prepare(`INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Theirs',?,?)`).run(foreignPolicy, other, AT, AT);
  const detector = item(await f.adapter.execute('admin.detectors.create', f.request({key:'k',kind:'keyword',config:{}})));
  const refused = await f.adapter.execute('gate.rules.create', f.request({policyId:foreignPolicy,detectorId:String(detector.id),direction:'outbound',action:'flag',config:{}}));
  assert.equal(refused.status, 404, 'a rule was filed against another tenant\'s policy');
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules'), 0);
  f.database.close();
});

test('rule tester POST replays one encrypted result and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/gate/rules/test');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'gate.test',permission:'policy:write',idempotency:true});
  const f=fixture(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-rule-test','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-rule-test.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  const testBody={sampleText:'Do not disclose Project Cobalt',rule:{detectorKind:'keyword',direction:'outbound',action:'block',config:{terms:['Project Cobalt']}}};
  const run=(adapter:typeof f.adapter,body:unknown,key:string,request=f.request(body))=>{request.headers.set('Idempotency-Key',key);return adapter.execute('gate.test',request)};

  const missingKey=f.request(testBody);missingKey.headers.delete('Idempotency-Key');
  assert.equal((await f.adapter.execute('gate.test',missingKey)).status,400);
  const invalid=await run(f.adapter,{sampleText:'text',rule:{detectorKind:'semantic',action:'block',config:{}}},'invalid-rule-test');
  assert.equal(invalid.status,422);assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-rule-test:gate.test'"),0);

  const key='durable-rule-test',accepted=await run(f.adapter,testBody,key),replay=await run(f.makeAdapter(),testBody,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the exact detector result and timings');
  const body=accepted.body as {published:boolean;action:string;disposition:string;matches:unknown[]};
  assert.deepEqual({published:body.published,action:body.action,disposition:body.disposition,matches:body.matches.length},{published:false,action:'block',disposition:'blocked',matches:1});
  assert.equal((await run(f.adapter,{...testBody,sampleText:'Different sample'},key)).status,409);

  const foreignBody=testBody;
  const foreignBase=f.request(foreignBody);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal(((await f.adapter.execute('gate.test',foreignRequest)).body as {action:string}).action,'block');

  const stored=f.database.prepare("SELECT response_json FROM idempotency_records WHERE tenant_id=? AND path='admin-rule-test:gate.test'").pluck().get(f.tenantId) as string;
  const envelope=JSON.parse(stored) as {algorithm?:unknown;keyVersion?:unknown};assert.equal(envelope.algorithm,'A256GCM');if(Object.hasOwn(envelope,'keyVersion'))assert.equal(envelope.keyVersion,1);
  assert.doesNotMatch(stored,/Project Cobalt|Do not disclose/u,'rule-test excerpts must not be cached in plaintext');
  assert.deepEqual(f.events,[],'testing a draft rule must remain unaudited');
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-rule-test:gate.test'"),2);
  f.database.close();
});

test('rule POST creates once, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/gate/rules');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'gate.rules.create',permission:'policy:write',idempotency:true});
  const f=fixture(),detector=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID(),foreignPolicy=randomUUID(),foreignDetector=randomUUID();
  const insertDetector=f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)");
  insertDetector.run(detector,f.tenantId,'rule-create-local','d'.repeat(64),AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-rule-create','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-rule-create.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Foreign policy',?,?)").run(foreignPolicy,foreignTenant,AT,AT);
  insertDetector.run(foreignDetector,foreignTenant,'rule-create-foreign','e'.repeat(64),AT,AT);
  const create=(adapter:typeof f.adapter,body:unknown,key:string,request=f.request(body))=>{
    request.headers.set('Idempotency-Key',key);
    return adapter.execute('gate.rules.create',request);
  };

  assert.equal((await create(f.adapter,{policyId:foreignPolicy,detectorId:detector,direction:'outbound',action:'flag',config:{}},'foreign-policy-rule-create')).status,404);
  assert.equal((await create(f.adapter,{policyId:f.policyId,detectorId:foreignDetector,direction:'outbound',action:'flag',config:{}},'foreign-detector-rule-create')).status,404);

  const key='durable-rule-create',body={policyId:f.policyId,detectorId:detector,direction:'outbound',action:'flag',config:{terms:['cobalt']}};
  const accepted=await create(f.adapter,body,key),replay=await create(f.makeAdapter(),body,key);
  assert.equal(accepted.status,201);assert.deepEqual(replay,accepted,'a fresh adapter must replay the original rule and audit receipt');
  assert.deepEqual({policyId:item(accepted).policy_id,detectorId:item(accepted).detector_id,scopeType:item(accepted).scope_type,scopeId:item(accepted).scope_id,severity:item(accepted).severity,enabled:item(accepted).enabled,priority:item(accepted).priority,version:item(accepted).updated_at},
    {policyId:f.policyId,detectorId:detector,scopeType:'tenant',scopeId:null,severity:'medium',enabled:1,priority:100,version:AT});
  assert.equal((await create(f.adapter,{...body,action:'block'},key)).status,409,'the key cannot reconcile a different body');

  const foreignBody={policyId:foreignPolicy,detectorId:foreignDetector,direction:'outbound',action:'block',config:{}};
  const foreignBase=f.request(foreignBody);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignCreated=await f.adapter.execute('gate.rules.create',foreignRequest);
  assert.equal(foreignCreated.status,201,'the same key belongs to an independent tenant scope');

  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=?',f.tenantId),1);
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=?',foreignTenant),1);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='gate.rule_created').map(input=>({target:input.target,metadata:input.metadata})),[
    {target:{type:'policy_rule',id:String(item(accepted).id)},metadata:{}},
    {target:{type:'policy_rule',id:String(item(foreignCreated).id)},metadata:{}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-rule-create:gate.rules.create'"),2);
  f.database.close();
});

test('rule POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),detector=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'rollback-rule-create','keyword','{}',?,1,0,?,?)").run(detector,f.tenantId,'f'.repeat(64),AT,AT);
  const request=f.request({policyId:f.policyId,detectorId:detector,direction:'outbound',action:'flag',config:{}});
  request.headers.set('Idempotency-Key','rollback-rule-create');
  await assert.rejects(f.adapter.execute('gate.rules.create',request),/forced invitation audit failure/u);
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=?',f.tenantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-rule-create:gate.rules.create'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('gate.rules.create',request);
  assert.equal(accepted.status,201);
  assert.deepEqual({policyId:item(accepted).policy_id,detectorId:item(accepted).detector_id,action:item(accepted).action},
    {policyId:f.policyId,detectorId:detector,action:'flag'});
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=?',f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-rule-create:gate.rules.create'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('gate.rules.create',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('model-scoped rule intake accepts only an existing tenant model target',async()=>{
  const f=fixture(),detector=item(await f.adapter.execute('admin.detectors.create',f.request({key:'model-keyword',kind:'keyword',config:{}})));
  const model=item(await f.adapter.execute('admin.models.create',f.request({provider:'openai',providerModelId:'model-scope-test',displayName:'Model scope test',enabled:true,contextWindowTokens:4096,maxOutputTokens:128,inputPriceMicroUsdPerMillion:1,outputPriceMicroUsdPerMillion:1,capabilities:[]})));
  const accepted=await f.adapter.execute('gate.rules.create',f.request({policyId:f.policyId,detectorId:String(detector.id),scopeType:'model',scopeId:model.id,direction:'outbound',action:'block',config:{}}));
  assert.equal(accepted.status,201);assert.deepEqual({scope_type:item(accepted).scope_type,scope_id:item(accepted).scope_id},{scope_type:'model',scope_id:model.id});
  const missing=await f.adapter.execute('gate.rules.create',f.request({policyId:f.policyId,detectorId:String(detector.id),scopeType:'model',direction:'outbound',action:'block',config:{}}));
  const unknown=await f.adapter.execute('gate.rules.create',f.request({policyId:f.policyId,detectorId:String(detector.id),scopeType:'model',scopeId:randomUUID(),direction:'outbound',action:'block',config:{}}));
  assert.equal(missing.status,422);assert.equal(unknown.status,422);f.database.close();
});

test('policy rule updates compare If-Match through the real tenant adapter',async()=>{
  const f=fixture();
  const group=item(await f.adapter.execute('admin.groups.create',f.request({name:'Scoped reviewers'})));
  const detector=item(await f.adapter.execute('admin.detectors.create',f.request({key:'etag-keyword',kind:'keyword',config:{terms:['classified']}})));
  const rule=item(await f.adapter.execute('gate.rules.create',f.request({policyId:f.policyId,detectorId:String(detector.id),scopeType:'group',scopeId:group.id,direction:'outbound',action:'flag',severity:'medium',config:{},priority:25})));
  const id=String(rule.id),version=Number(rule.updated_at);

  const missing=await f.adapter.execute('gate.rules.update',f.request({severity:'high'},{id}));
  assert.equal(missing.status,428);assert.equal(errorCode(missing),'PRECONDITION_REQUIRED');
  const updated=await f.adapter.execute('gate.rules.update',withMatch(f.request({severity:'high'},{id}),version));
  assert.equal(updated.status,undefined);
  assert.deepEqual({severity:item(updated).severity,scope_type:item(updated).scope_type,scope_id:item(updated).scope_id,updated_at:item(updated).updated_at},
    {severity:'high',scope_type:'group',scope_id:group.id,updated_at:version+1},
    'the ETag must advance without broadening an omitted group scope');

  const stale=await f.adapter.execute('gate.rules.update',withMatch(f.request({severity:'critical'},{id}),version));
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.deepEqual(f.database.prepare('SELECT severity,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,id),{severity:'high',updated_at:version+1});
  f.database.close();
});

test('rule PATCH reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/gate/rules/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'gate.rules.update',permission:'policy:write',ifMatch:true,idempotency:true});
  const f=fixture(),detector=randomUUID(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignOwner=randomUUID(),foreignPolicy=randomUUID(),foreignDetector=randomUUID(),foreignTarget=randomUUID();
  const insertDetector=f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)");
  insertDetector.run(detector,f.tenantId,'rule-patch-local','a'.repeat(64),AT,AT);
  const insertRule=f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','flag','medium','{}',1,25,?,?)");
  insertRule.run(target,f.tenantId,f.policyId,detector,AT,AT);
  insertRule.run(staleTarget,f.tenantId,f.policyId,detector,AT,AT+1);
  insertRule.run(otherTarget,f.tenantId,f.policyId,detector,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-rule-patch','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-rule-patch.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Foreign policy',?,?)").run(foreignPolicy,foreignTenant,AT,AT);
  insertDetector.run(foreignDetector,foreignTenant,'rule-patch-foreign','b'.repeat(64),AT,AT);
  insertRule.run(foreignTarget,foreignTenant,foreignPolicy,foreignDetector,AT,AT);

  const listed=(await f.adapter.execute('gate.rules.list',f.request(null))).body as {items:Array<{id:string;updated_at:number}>};
  assert.equal(listed.items.find(rule=>rule.id===target)?.updated_at,AT,'the list contract must supply the update fence');
  const update=(adapter:typeof f.adapter,id:string,body:unknown,version:number,key:string)=>{
    const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('gate.rules.update',request);
  };

  const missingMatch=await f.adapter.execute('gate.rules.update',f.request({severity:'high'},{id:target}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const stale=await update(f.adapter,staleTarget,{severity:'critical'},AT,'stale-rule-update');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await update(f.adapter,randomUUID(),{severity:'high'},AT,'missing-rule-update')).status,404);
  assert.equal((await update(f.adapter,foreignTarget,{severity:'high'},AT,'foreign-rule-update')).status,404);

  const key='durable-rule-update',body={severity:'high',enabled:false},accepted=await update(f.adapter,target,body,AT,key);
  const replay=await update(f.makeAdapter(),target,body,AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original row version and audit receipt');
  assert.deepEqual({scopeType:item(accepted).scope_type,scopeId:item(accepted).scope_id,direction:item(accepted).direction,action:item(accepted).action,severity:item(accepted).severity,enabled:item(accepted).enabled,priority:item(accepted).priority,version:item(accepted).updated_at},
    {scopeType:'tenant',scopeId:null,direction:'outbound',action:'flag',severity:'high',enabled:0,priority:25,version:AT+1},'omitted PATCH fields must be preserved');
  assert.equal((await update(f.adapter,target,{severity:'critical',enabled:false},AT,key)).status,409,'the key cannot reconcile a different body');
  assert.equal((await update(f.adapter,otherTarget,body,AT,key)).status,409,'the key cannot reconcile a different target');
  assert.equal((await update(f.adapter,target,body,AT+1,key)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request({severity:'critical'},{id:foreignTarget}),AT);
  foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal(item(await f.adapter.execute('gate.rules.update',foreignRequest)).severity,'critical','the same key belongs to an independent tenant scope');

  assert.deepEqual(f.database.prepare('SELECT severity,enabled,priority,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,target),
    {severity:'high',enabled:0,priority:25,updated_at:AT+1});
  assert.deepEqual(f.database.prepare('SELECT severity,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{severity:'medium',updated_at:AT+1});
  assert.equal(f.database.prepare('SELECT severity FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherTarget),'medium');
  assert.deepEqual(f.database.prepare('SELECT severity,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(foreignTenant,foreignTarget),{severity:'critical',updated_at:AT+1});
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='gate.rule_updated').map(input=>({target:input.target,metadata:input.metadata})),[
    {target:{type:'policy_rule',id:target},metadata:{}},{target:{type:'policy_rule',id:foreignTarget},metadata:{}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-rule-update:gate.rules.update'"),2);
  f.database.close();
});

test('rule PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),detector=randomUUID(),target=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'rollback-rule-patch','keyword','{}',?,1,0,?,?)").run(detector,f.tenantId,'c'.repeat(64),AT,AT);
  f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','flag','medium','{}',1,25,?,?)").run(target,f.tenantId,f.policyId,detector,AT,AT);
  const request=withMatch(f.request({severity:'high'},{id:target}),AT);request.headers.set('Idempotency-Key','rollback-rule-update');
  await assert.rejects(f.adapter.execute('gate.rules.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT severity,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,target),{severity:'medium',updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-rule-update:gate.rules.update'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('gate.rules.update',request);
  assert.deepEqual({severity:item(accepted).severity,version:item(accepted).updated_at},{severity:'high',version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT severity,updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,target),{severity:'high',updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-rule-update:gate.rules.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('gate.rules.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('rule DELETE reads a version, fences stale writes, replays exactly, and stays tenant-scoped',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='DELETE'&&definition.path==='/gate/rules/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'gate.rules.delete',permission:'policy:write',ifMatch:true,idempotency:true});
  const f=fixture(),detector=randomUUID(),target=randomUUID(),staleTarget=randomUUID(),otherTarget=randomUUID(),foreignTenant=randomUUID() as TenantId;
  const foreignOwner=randomUUID(),foreignPolicy=randomUUID(),foreignDetector=randomUUID(),foreignTarget=randomUUID();
  const insertDetector=f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)");
  insertDetector.run(detector,f.tenantId,'rule-delete-local','d'.repeat(64),AT,AT);
  const insertRule=f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','flag','medium','{}',1,25,?,?)");
  insertRule.run(target,f.tenantId,f.policyId,detector,AT,AT);
  insertRule.run(staleTarget,f.tenantId,f.policyId,detector,AT,AT+1);
  insertRule.run(otherTarget,f.tenantId,f.policyId,detector,AT,AT);
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-rule-delete','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-rule-delete.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Foreign policy',?,?)").run(foreignPolicy,foreignTenant,AT,AT);
  insertDetector.run(foreignDetector,foreignTenant,'rule-delete-foreign','e'.repeat(64),AT,AT);
  insertRule.run(foreignTarget,foreignTenant,foreignPolicy,foreignDetector,AT,AT);

  const listed=(await f.adapter.execute('gate.rules.list',f.request(null))).body as {items:Array<{id:string;updated_at:number}>};
  assert.equal(listed.items.find(rule=>rule.id===target)?.updated_at,AT,'the list contract must supply the destructive-write fence');
  const remove=(adapter:typeof f.adapter,id:string,version:number,key:string)=>{
    const request=withMatch(f.request(null,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('gate.rules.delete',request);
  };

  const missingMatch=await f.adapter.execute('gate.rules.delete',f.request(null,{id:target}));
  assert.equal(missingMatch.status,428);assert.equal(errorCode(missingMatch),'PRECONDITION_REQUIRED');
  const stale=await remove(f.adapter,staleTarget,AT,'stale-rule-delete');
  assert.equal(stale.status,412);assert.equal(errorCode(stale),'PRECONDITION_FAILED');
  assert.equal((await remove(f.adapter,randomUUID(),AT,'missing-rule-delete')).status,404);
  assert.equal((await remove(f.adapter,foreignTarget,AT,'foreign-rule-delete')).status,404);

  const key='durable-rule-delete',accepted=await remove(f.adapter,target,AT,key);
  const replay=await remove(f.makeAdapter(),target,AT,key);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original 204 after the row is gone');
  assert.equal(accepted.status,204);
  assert.equal((await remove(f.adapter,otherTarget,AT,key)).status,409,'the key cannot reconcile a different target');
  assert.equal((await remove(f.adapter,target,AT+1,key)).status,409,'the key cannot reconcile a different precondition');

  const foreignBase=withMatch(f.request(null,{id:foreignTarget}),AT);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal((await f.adapter.execute('gate.rules.delete',foreignRequest)).status,204,'the same key belongs to an independent tenant scope');

  assert.equal(f.database.prepare('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,target),0);
  assert.deepEqual(f.database.prepare('SELECT updated_at FROM policy_rules WHERE tenant_id=? AND id=?').get(f.tenantId,staleTarget),{updated_at:AT+1});
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,otherTarget),1);
  assert.equal(f.database.prepare('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(foreignTenant,foreignTarget),0);
  assert.deepEqual(f.auditInputs.filter(input=>input.action==='gate.rule_deleted').map(input=>({target:input.target,metadata:input.metadata})),[
    {target:{type:'policy_rule',id:target},metadata:{}},{target:{type:'policy_rule',id:foreignTarget},metadata:{}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-rule-delete:gate.rules.delete'"),2);
  f.database.close();
});

test('rule DELETE rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),detector=randomUUID(),target=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'rollback-rule-delete','keyword','{}',?,1,0,?,?)").run(detector,f.tenantId,'f'.repeat(64),AT,AT);
  f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','flag','medium','{}',1,25,?,?)").run(target,f.tenantId,f.policyId,detector,AT,AT);
  const request=withMatch(f.request(null,{id:target}),AT);request.headers.set('Idempotency-Key','rollback-rule-delete');
  await assert.rejects(f.adapter.execute('gate.rules.delete',request),/forced invitation audit failure/u);
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND id=?',f.tenantId,target),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-rule-delete:gate.rules.delete'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('gate.rules.delete',request);
  assert.equal(accepted.status,204);
  assert.equal(f.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=? AND id=?',f.tenantId,target),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-rule-delete:gate.rules.delete'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('gate.rules.delete',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('custom-term POST and DELETE replay exact tenant-scoped state and audit once',async()=>{
  const routes=routeDefinitions.filter(definition=>definition.path==='/admin/custom-terms'&&definition.method!=='GET');
  assert.deepEqual(routes.map(route=>({method:route.method,operation:route.operation,permission:route.permission,idempotency:route.idempotency})),[
    {method:'POST',operation:'admin.customTerms.upsert',permission:'policy:write',idempotency:true},
    {method:'DELETE',operation:'admin.customTerms.delete',permission:'policy:write',idempotency:true},
  ]);
  const f=fixture(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID(),foreignPolicy=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-custom-terms','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-custom-terms.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Foreign policy',?,?)").run(foreignPolicy,foreignTenant,AT,AT);
  const send=(adapter:typeof f.adapter,operation:'admin.customTerms.upsert'|'admin.customTerms.delete',body:unknown,key:string,request=f.request(body))=>{
    request.headers.set('Idempotency-Key',key);return adapter.execute(operation,request);
  };

  const missingKey=f.request({terms:['Atlas'],action:'block'});missingKey.headers.delete('Idempotency-Key');
  assert.equal((await f.adapter.execute('admin.customTerms.upsert',missingKey)).status,400);
  const invalid=await send(f.adapter,'admin.customTerms.upsert',{terms:['Atlas'],action:'allow'},'invalid-custom-terms');
  assert.equal(invalid.status,422);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-custom-terms:admin.customTerms.upsert'"),0,'validation failures must not be cached');

  const upsertKey='durable-custom-terms-upsert',upsertBody={terms:[' Project Cobalt ','Project Cobalt','Atlas'],action:'block'};
  const acceptedUpsert=await send(f.adapter,'admin.customTerms.upsert',upsertBody,upsertKey);
  const replayedUpsert=await send(f.makeAdapter(),'admin.customTerms.upsert',upsertBody,upsertKey);
  assert.deepEqual(replayedUpsert,acceptedUpsert,'a fresh adapter must replay the original state and audit receipt');
  assert.deepEqual(acceptedUpsert.body&&{terms:(acceptedUpsert.body as {terms:unknown}).terms,counts:(acceptedUpsert.body as {counts:unknown}).counts},{terms:[{term:'Atlas',action:'block'},{term:'Project Cobalt',action:'block'}],counts:{flag:0,warn:0,redact:0,block:2}});
  assert.equal((await send(f.adapter,'admin.customTerms.upsert',{terms:['Atlas'],action:'warn'},upsertKey)).status,409,'the POST key cannot reconcile another body');

  const foreignBody={terms:['Foreign phrase'],action:'warn'},foreignBase=f.request(foreignBody);foreignBase.headers.set('Idempotency-Key',upsertKey);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignUpsert=await f.adapter.execute('admin.customTerms.upsert',foreignRequest);
  assert.deepEqual((foreignUpsert.body as {terms:unknown}).terms,[{term:'Foreign phrase',action:'warn'}],'the same POST key belongs to an independent tenant scope');

  const deleteKey='durable-custom-terms-delete',deleteBody={term:'Project Cobalt'};
  const acceptedDelete=await send(f.adapter,'admin.customTerms.delete',deleteBody,deleteKey);
  const replayedDelete=await send(f.makeAdapter(),'admin.customTerms.delete',deleteBody,deleteKey);
  assert.deepEqual(replayedDelete,acceptedDelete,'a fresh adapter must replay the exact post-delete state and audit receipt');
  assert.deepEqual((acceptedDelete.body as {terms:unknown}).terms,[{term:'Atlas',action:'block'}]);
  assert.equal((await send(f.adapter,'admin.customTerms.delete',{term:'Atlas'},deleteKey)).status,409,'the DELETE key cannot reconcile another body');

  const foreignDeleteBase=f.request({term:'Foreign phrase'});foreignDeleteBase.headers.set('Idempotency-Key',deleteKey);
  const foreignDelete:RouteRequest={...foreignDeleteBase,tenant:{...foreignDeleteBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.deepEqual(((await f.adapter.execute('admin.customTerms.delete',foreignDelete)).body as {terms:unknown}).terms,[],'the same DELETE key belongs to an independent tenant scope');

  assert.equal(f.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='custom-terms'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='custom-terms'",foreignTenant),1);
  assert.deepEqual(f.auditInputs.filter(input=>(input.metadata as {kind?:unknown}|undefined)?.kind==='custom_terms').map(input=>({action:input.action,metadata:input.metadata})),[
    {action:'gate.rule_updated',metadata:{kind:'custom_terms',count:2}},
    {action:'gate.rule_updated',metadata:{kind:'custom_terms',count:1}},
    {action:'gate.rule_deleted',metadata:{kind:'custom_terms',count:1}},
    {action:'gate.rule_deleted',metadata:{kind:'custom_terms',count:1}},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-custom-terms:admin.customTerms.upsert'"),2);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-custom-terms:admin.customTerms.delete'"),2);
  f.database.close();
});

test('custom-term POST and DELETE roll back and leave their idempotency keys reusable',async()=>{
  const create=fixture(true),createRequest=create.request({terms:['Rollback phrase'],action:'block'});createRequest.headers.set('Idempotency-Key','rollback-custom-terms-upsert');
  await assert.rejects(create.adapter.execute('admin.customTerms.upsert',createRequest),/forced invitation audit failure/u);
  assert.equal(create.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='custom-terms'",create.tenantId),0);
  assert.equal(create.count('SELECT COUNT(*) FROM policy_rules WHERE tenant_id=?',create.tenantId),0);
  assert.equal(create.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-custom-terms:admin.customTerms.upsert'",create.tenantId),0);

  create.allowAudit();
  const acceptedCreate=await create.adapter.execute('admin.customTerms.upsert',createRequest);
  assert.deepEqual(acceptedCreate.body&&{terms:(acceptedCreate.body as {terms:unknown}).terms,counts:(acceptedCreate.body as {counts:unknown}).counts},
    {terms:[{term:'Rollback phrase',action:'block'}],counts:{flag:0,warn:0,redact:0,block:1}});
  assert.equal(create.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='custom-terms'",create.tenantId),1);
  assert.equal(create.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-custom-terms:admin.customTerms.upsert'",create.tenantId),1);
  const replayedCreate=await create.makeAdapter().execute('admin.customTerms.upsert',createRequest);
  assert.deepEqual(replayedCreate,acceptedCreate,'a fresh adapter must replay the recovered success from the database');
  create.database.close();

  const remove=fixture(true),detector=randomUUID(),rule=randomUUID(),config=JSON.stringify({terms:['Rollback phrase'],regexes:[],wholeWord:false,maxMatches:20});
  remove.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'custom-terms','keyword',?,?,1,0,?,?)").run(detector,remove.tenantId,config,createHash('sha256').update(config).digest('hex'),AT,AT);
  remove.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','block','critical',?,1,1000,?,?)").run(rule,remove.tenantId,remove.policyId,detector,config,AT,AT);
  const deleteRequest=remove.request({term:'Rollback phrase'});deleteRequest.headers.set('Idempotency-Key','rollback-custom-terms-delete');
  await assert.rejects(remove.adapter.execute('admin.customTerms.delete',deleteRequest),/forced invitation audit failure/u);
  assert.equal(remove.database.prepare('SELECT enabled FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(remove.tenantId,rule),1);
  assert.match(remove.database.prepare('SELECT config_json FROM detector_definitions WHERE tenant_id=? AND id=?').pluck().get(remove.tenantId,detector) as string,/Rollback phrase/u);
  assert.equal(remove.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-custom-terms:admin.customTerms.delete'",remove.tenantId),0);

  remove.allowAudit();
  const acceptedDelete=await remove.adapter.execute('admin.customTerms.delete',deleteRequest);
  assert.deepEqual((acceptedDelete.body as {terms:unknown}).terms,[]);
  assert.equal(remove.database.prepare('SELECT enabled FROM policy_rules WHERE tenant_id=? AND id=?').pluck().get(remove.tenantId,rule),0);
  assert.equal(remove.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-custom-terms:admin.customTerms.delete'",remove.tenantId),1);
  const replayedDelete=await remove.makeAdapter().execute('admin.customTerms.delete',deleteRequest);
  assert.deepEqual(replayedDelete,acceptedDelete,'a fresh adapter must replay the recovered success from the database');
  remove.database.close();
});

test('detector POST durably replays one audited response and isolates the same key by tenant',async()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/admin/detectors');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'admin.detectors.create',permission:'policy:write',idempotency:true});
  const f=fixture(),key='durable-detector-create',body={key:'durable-detector-post',kind:'keyword',config:{terms:['Project Cobalt']},enabled:true};
  const request=(input:unknown)=>{const value=f.request(input);value.headers.set('Idempotency-Key',key);return value};

  const accepted=await f.adapter.execute('admin.detectors.create',request(body));
  assert.equal(accepted.status,201);
  const acceptedId=String(item(accepted).id);
  const rowsForKey=()=>(f.database.prepare("SELECT id FROM detector_definitions WHERE tenant_id=? AND key='durable-detector-post' ORDER BY id").all(f.tenantId) as Array<{id:string}>).map(row=>row.id);
  assert.deepEqual(rowsForKey(),[acceptedId],'the create must land exactly one detector row');
  let replay:unknown;
  try{replay=await f.makeAdapter().execute('admin.detectors.create',request(body));}
  catch(error){replay=error;}
  assert.deepEqual(rowsForKey(),[acceptedId],'a retry must not mint a second detector row');
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the original detector and audit receipt');
  assert.equal(item(replay as {body?:unknown}).id,acceptedId);
  assert.equal((replay as {body:{auditEventId:string}}).body.auditEventId,(accepted.body as {auditEventId:string}).auditEventId);
  assert.equal(f.auditInputs.filter(input=>input.action==='gate.rule_created').length,1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-detector-create:admin.detectors.create'"),1);

  const foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-detector-create','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-detector-create.test','Foreign owner','hash','active',?,?)").run(foreignUser,foreignTenant,AT,AT);
  const foreignBase=request(body),foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignUser,membershipId:foreignUser};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  const foreignAccepted=await f.adapter.execute('admin.detectors.create',foreignRequest);
  assert.equal(foreignAccepted.status,201,'another tenant must own an independent use of the same key');
  assert.notEqual(item(foreignAccepted).id,item(accepted).id);
  assert.equal(f.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='durable-detector-post'",foreignTenant),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-detector-create:admin.detectors.create'"),2);
  f.database.close();
});

test('detector POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),request=f.request({key:'rollback-detector-create',kind:'keyword',config:{terms:['Rollback phrase']}});
  request.headers.set('Idempotency-Key','rollback-detector-create');
  await assert.rejects(f.adapter.execute('admin.detectors.create',request),/forced invitation audit failure/u);
  assert.equal(f.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='rollback-detector-create'",f.tenantId),0);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-detector-create:admin.detectors.create'",f.tenantId),0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.detectors.create',request);
  assert.equal(accepted.status,201);
  assert.deepEqual({name:item(accepted).name,detectorKind:item(accepted).detectorKind,enabled:item(accepted).enabled},
    {name:'rollback-detector-create',detectorKind:'keyword',enabled:true});
  assert.equal(f.count("SELECT COUNT(*) FROM detector_definitions WHERE tenant_id=? AND key='rollback-detector-create'",f.tenantId),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-detector-create:admin.detectors.create'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.detectors.create',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});

test('detector PATCH enforces tenant CAS and durable exact replay',async()=>{
  const route=routeDefinitions.find(definition=>definition.operation==='admin.detectors.update');
  assert.deepEqual(route&&{method:route.method,path:route.path,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {method:'PATCH',path:'/admin/detectors/:id',ifMatch:true,idempotency:true});
  const f=fixture(),target=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID(),foreignTarget=randomUUID();
  const seed=(tenantId:string,id:string,key:string)=>f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)").run(id,tenantId,key,'f'.repeat(64),AT,AT);
  seed(f.tenantId,target,'detector-cas');
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-detector-cas','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-detector-cas.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  seed(foreignTenant,foreignTarget,'foreign-detector-cas');
  const send=(adapter:typeof f.adapter,body:unknown,key:string,id=target,version=AT)=>{
    const request=withMatch(f.request(body,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('admin.detectors.update',request);
  };

  const missingKey=withMatch(f.request({enabled:false},{id:target}),AT);missingKey.headers.delete('Idempotency-Key');
  assert.equal((await f.adapter.execute('admin.detectors.update',missingKey)).status,400);
  const missingMatch=f.request({enabled:false},{id:target});missingMatch.headers.set('Idempotency-Key','missing-detector-match');
  assert.equal((await f.adapter.execute('admin.detectors.update',missingMatch)).status,428);
  const invalid=await send(f.adapter,{enabled:'sometimes'},'invalid-detector-update');
  assert.equal(invalid.status,422);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-detector-update:admin.detectors.update'"),0,'rejected requests must not be cached');

  const key='durable-detector-update',body={enabled:false,config:{terms:['Project Cobalt']}};
  const accepted=await send(f.adapter,body,key);
  const replayed=await send(f.makeAdapter(),body,key);
  assert.deepEqual(replayed,accepted,'a fresh adapter must replay the original detector and audit receipt');
  assert.deepEqual(item(accepted),{id:target,name:'detector-cas',detectorKind:'keyword',enabled:false,builtin:false,config:{terms:['Project Cobalt']},version:AT+1,createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT+1).toISOString()});
  assert.equal((await send(f.adapter,{enabled:true},key)).status,409,'one key cannot reconcile another body');
  assert.equal((await send(f.adapter,body,key,randomUUID())).status,409,'one key cannot reconcile another target');
  assert.equal((await send(f.adapter,body,key,target,AT+10)).status,409,'one key cannot reconcile another precondition');
  assert.equal((await send(f.adapter,{enabled:true},'stale-detector-update')).status,412);
  assert.equal((await send(f.adapter,{enabled:true},'missing-detector-update',randomUUID())).status,404);
  assert.equal((await send(f.adapter,{enabled:true},'cross-tenant-detector-update',foreignTarget)).status,404);

  const foreignBase=withMatch(f.request({enabled:false},{id:foreignTarget}),AT);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.equal(item(await f.adapter.execute('admin.detectors.update',foreignRequest)).version,AT+1,'another tenant owns an independent use of the key');

  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-detector-update:admin.detectors.update'"),2);
  assert.deepEqual(f.auditInputs.filter(input=>(input.metadata as {kind?:unknown}|undefined)?.kind==='detector').map(input=>({action:input.action,target:input.target})),[
    {action:'gate.rule_updated',target:{type:'policy_rule',id:target}},
    {action:'gate.rule_updated',target:{type:'policy_rule',id:foreignTarget}},
  ]);
  f.database.close();
});

test('detector PATCH rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'rollback-detector-update','keyword','{}',?,1,0,?,?)").run(target,f.tenantId,'f'.repeat(64),AT,AT);
  const request=withMatch(f.request({enabled:false,config:{terms:['Rollback phrase']}},{id:target}),AT);request.headers.set('Idempotency-Key','rollback-detector-update');
  await assert.rejects(f.adapter.execute('admin.detectors.update',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT enabled,config_json,updated_at FROM detector_definitions WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:1,config_json:'{}',updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-detector-update:admin.detectors.update'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.detectors.update',request);
  assert.deepEqual({enabled:item(accepted).enabled,config:item(accepted).config,version:item(accepted).version},
    {enabled:false,config:{terms:['Rollback phrase']},version:AT+1});
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM detector_definitions WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:0,updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='PATCH' AND path='admin-detector-update:admin.detectors.update'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.detectors.update',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});


test('detector DELETE fences tenants and durably replays the original 204',async()=>{
  const route=routeDefinitions.find(definition=>definition.operation==='admin.detectors.delete');
  assert.deepEqual(route&&{method:route.method,path:route.path,ifMatch:route.ifMatch,idempotency:route.idempotency,success:route.success},
    {method:'DELETE',path:'/admin/detectors/:id',ifMatch:true,idempotency:true,success:204});
  const f=fixture(),target=randomUUID(),foreignTenant=randomUUID() as TenantId,foreignOwner=randomUUID(),foreignTarget=randomUUID();
  const seed=(tenantId:string,id:string,key:string)=>f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)").run(id,tenantId,key,'f'.repeat(64),AT,AT);
  seed(f.tenantId,target,'detector-delete');
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-detector-delete','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'owner@foreign-detector-delete.test','Foreign owner','hash','active',?,?)").run(foreignOwner,foreignTenant,AT,AT);
  seed(foreignTenant,foreignTarget,'foreign-detector-delete');
  const send=(adapter:typeof f.adapter,key:string,id=target,version=AT)=>{
    const request=withMatch(f.request(null,{id}),version);request.headers.set('Idempotency-Key',key);
    return adapter.execute('admin.detectors.delete',request);
  };

  const missingKey=withMatch(f.request(null,{id:target}),AT);missingKey.headers.delete('Idempotency-Key');
  assert.equal((await f.adapter.execute('admin.detectors.delete',missingKey)).status,400);
  const missingMatch=f.request(null,{id:target});missingMatch.headers.set('Idempotency-Key','missing-detector-delete-match');
  assert.equal((await f.adapter.execute('admin.detectors.delete',missingMatch)).status,428);

  const key='durable-detector-delete',accepted=await send(f.adapter,key);
  assert.deepEqual(accepted,{status:204});
  assert.deepEqual(await send(f.makeAdapter(),key),accepted,'a fresh adapter must replay 204 after the version has advanced');
  assert.equal((await send(f.adapter,key,randomUUID())).status,409,'one key cannot reconcile another target');
  assert.equal((await send(f.adapter,key,target,AT+10)).status,409,'one key cannot reconcile another precondition');
  assert.equal((await send(f.adapter,'stale-detector-delete')).status,412);
  assert.equal((await send(f.adapter,'missing-detector-delete',randomUUID())).status,404);
  assert.equal((await send(f.adapter,'cross-tenant-detector-delete',foreignTarget)).status,404);

  const foreignBase=withMatch(f.request(null,{id:foreignTarget}),AT);foreignBase.headers.set('Idempotency-Key',key);
  const foreignPrincipal:RequestPrincipal={...foreignBase.tenant!.principal,tenantId:foreignTenant,userId:foreignOwner,membershipId:foreignOwner};
  const foreignRequest:RouteRequest={...foreignBase,tenant:{...foreignBase.tenant!,principal:foreignPrincipal,db:forTenant({tenantId:foreignTenant})}};
  assert.deepEqual(await f.adapter.execute('admin.detectors.delete',foreignRequest),{status:204},'another tenant owns an independent use of the key');

  assert.deepEqual(f.database.prepare('SELECT tenant_id,enabled,updated_at FROM detector_definitions WHERE id IN (?,?) ORDER BY tenant_id').all(target,foreignTarget).map(row=>({...(row as object)})),[
    {tenant_id:[f.tenantId,foreignTenant].sort()[0],enabled:0,updated_at:AT+1},
    {tenant_id:[f.tenantId,foreignTenant].sort()[1],enabled:0,updated_at:AT+1},
  ]);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE path='admin-detector-delete:admin.detectors.delete'"),2);
  assert.deepEqual(f.auditInputs.filter(input=>(input.metadata as {kind?:unknown}|undefined)?.kind==='detector').map(input=>({action:input.action,target:input.target})),[
    {action:'gate.rule_deleted',target:{type:'policy_rule',id:target}},
    {action:'gate.rule_deleted',target:{type:'policy_rule',id:foreignTarget}},
  ]);
  f.database.close();
});

test('detector DELETE rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true),target=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'rollback-detector-delete','keyword','{}',?,1,0,?,?)").run(target,f.tenantId,'f'.repeat(64),AT,AT);
  const request=withMatch(f.request(null,{id:target}),AT);request.headers.set('Idempotency-Key','rollback-detector-delete');
  await assert.rejects(f.adapter.execute('admin.detectors.delete',request),/forced invitation audit failure/u);
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM detector_definitions WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:1,updated_at:AT});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-detector-delete:admin.detectors.delete'",f.tenantId),0);
  assert.deepEqual(f.events,[]);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.detectors.delete',request);
  assert.deepEqual(accepted,{status:204});
  assert.deepEqual(f.database.prepare('SELECT enabled,updated_at FROM detector_definitions WHERE tenant_id=? AND id=?').get(f.tenantId,target),{enabled:0,updated_at:AT+1});
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='DELETE' AND path='admin-detector-delete:admin.detectors.delete'",f.tenantId),1);

  const replay=await f.makeAdapter().execute('admin.detectors.delete',request);
  assert.deepEqual(replay,accepted,'a fresh adapter must replay the recovered success from the database');
  f.database.close();
});


test('the policy PATCH route requires and forwards the real version precondition',async()=>{
  const f=fixture();
  const detector=item(await f.adapter.execute('admin.detectors.create',f.request({key:'route-etag',kind:'keyword',config:{}})));
  const rule=item(await f.adapter.execute('gate.rules.create',f.request({policyId:f.policyId,detectorId:String(detector.id),direction:'outbound',action:'block',severity:'medium',config:{},priority:10})));
  const id=String(rule.id),version=Number(rule.updated_at);
  const principal:RequestPrincipal={userId:f.userId,tenantId:f.tenantId,membershipId:f.userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['policy:write'])};
  const app=new Hono<{Variables:AppVariables}>();
  app.use('*',async(c,next)=>{c.set('requestId','route-req');c.set('principal',principal);c.set('tenant',{principal,requestId:'route-req',now:new Date(AT),db:forTenant({tenantId:f.tenantId})});await next()});
  mountDefinitions(app,f.adapter,routeDefinitions.filter(definition=>definition.operation==='gate.rules.update'));
  const init=(ifMatch?:number):RequestInit=>({method:'PATCH',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(ifMatch===undefined?{}:{'If-Match':`"${ifMatch}"`})},body:'{"severity":"high"}'});

  const missing=await app.request(`/gate/rules/${id}`,init());
  assert.equal(missing.status,428);assert.equal((await missing.json() as {error:{code:string}}).error.code,'PRECONDITION_REQUIRED');
  const accepted=await app.request(`/gate/rules/${id}`,init(version));
  assert.equal(accepted.status,200);assert.equal(((await accepted.json() as {item:{updated_at:number}}).item.updated_at),version+1);
  const stale=await app.request(`/gate/rules/${id}`,init(version));
  assert.equal(stale.status,412);assert.equal((await stale.json() as {error:{code:string}}).error.code,'PRECONDITION_FAILED');
  f.database.close();
});

test('adding a member refuses a user from another tenant', async () => {
  const f = fixture();
  const other = randomUUID(), stranger = randomUUID();
  f.database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'bravo','Bravo','active',?,?)`).run(other, AT, AT);
  f.database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'x@bravo.test','X','h','active',?,?)`).run(stranger, other, AT, AT);
  const group = item(await f.adapter.execute('admin.groups.create', f.request({name:'Engineering'})));
  const refused = await f.adapter.execute('admin.groups.addMember', withMatch(f.request(null, {id:String(group.id),userId:stranger}),Number(group.version)));
  assert.equal(refused.status, 404, 'a user from another tenant was added to this tenant\'s group');
  assert.equal(f.count('SELECT COUNT(*) FROM group_members'), 0);
  f.database.close();
});

test('user list returns the web contract and honors every exposed filter through real forTenant',async()=>{
  const f=fixture(),groupId=randomUUID(),foreignTenant=randomUUID(),foreignUser=randomUUID();
  f.database.prepare("UPDATE users SET display_name='Ada 100% Analyst',status='suspended',totp_secret_ciphertext='sealed',totp_enabled_at=?,last_login_at=? WHERE tenant_id=? AND id=?")
    .run(AT-2_000,AT-1_000,f.tenantId,f.memberId);
  f.database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Engineering',?,?)").run(groupId,f.tenantId,AT,AT);
  f.database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(f.tenantId,groupId,f.memberId,AT);
  const complianceRole=f.database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='compliance'").pluck().get(f.tenantId) as string;
  f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,f.memberId,complianceRole,AT);

  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'foreign-users','Foreign','active',?,?)").run(foreignTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'foreign@outside.test','Ada 100X Analyst','hash','suspended',?,?)")
    .run(foreignUser,foreignTenant,AT,AT);

  type UserItem={id:string;email:string;displayName:string;status:string;roles:string[];groups:Array<{id:string;name:string}>;actions:{changeStatus:boolean;changeRole:boolean;deprovision:boolean;signOut:boolean;credentialLink:'setup'|'reset'|null};mfaEnabled:boolean;locale:string;version:number;lastActiveAt:string|null;createdAt:string;updatedAt:string};
  const list=async(query:Record<string,string>={})=>{
    const response=await f.adapter.execute('admin.users.list',{...f.request(null),query});
    assert.equal(response.status,undefined);
    return (response.body as {items:UserItem[];nextCursor:null}).items;
  };
  const ids=(items:UserItem[])=>items.map(item=>item.id);
  const all=await list();
  assert.deepEqual(ids(all).sort(),[f.userId,f.memberId].sort(),'another tenant must never enter the directory');
  const member=all.find(item=>item.id===f.memberId)!;
  assert.deepEqual(member,{
    id:f.memberId,email:'member@acme.test',displayName:'Ada 100% Analyst',status:'suspended',roles:['compliance'],
    groups:[{id:groupId,name:'Engineering'}],actions:{changeStatus:true,changeRole:true,deprovision:true,signOut:true,credentialLink:null},mfaEnabled:true,locale:'en',version:AT,
    lastActiveAt:new Date(AT-1_000).toISOString(),createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT).toISOString(),
  });
  assert.equal('display_name' in member,false);assert.equal('last_login_at' in member,false);

  assert.deepEqual(ids(await list({search:'100%'})),[f.memberId],'search treats SQL wildcard characters literally');
  assert.deepEqual(ids(await list({search:'MEMBER@ACME.TEST'})),[f.memberId]);
  assert.deepEqual(ids(await list({status:'suspended'})),[f.memberId]);
  assert.deepEqual(ids(await list({role:'COMPLIANCE'})),[f.memberId]);
  assert.deepEqual(ids(await list({group:'engineering'})),[f.memberId]);
  assert.deepEqual(ids(await list({group:groupId})),[f.memberId]);
  assert.deepEqual(ids(await list({mfa:'enabled'})),[f.memberId]);
  assert.deepEqual(ids(await list({mfa:'disabled'})),[f.userId]);

  for(const query of [{status:'disabled'},{status:'deprovisioned'},{mfa:'required'}]){
    const invalid=await f.adapter.execute('admin.users.list',{...f.request(null),query});
    assert.equal(invalid.status,422);
  }
  f.database.close();
});

test('concurrent HTTP invitation retries create one ordinary user and one audit event',async()=>{
  const f=fixture();
  const principal:RequestPrincipal={userId:f.userId,tenantId:f.tenantId,membershipId:f.userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['admin:users'])};
  const app=new Hono<{Variables:AppVariables}>();
  app.use('*',async(c,next)=>{c.set('requestId','concurrent-invite');c.set('principal',principal);c.set('tenant',{principal,requestId:'concurrent-invite',now:new Date(AT),db:forTenant({tenantId:f.tenantId})});await next()});
  mountDefinitions(app,f.adapter,routeDefinitions.filter(definition=>definition.operation==='admin.users.create'));
  const key='i'.repeat(128),payload={email:'parallel@acme.test',displayName:'Parallel Admin',role:'admin'};
  const post=(body=payload,idempotencyKey:string|null=key)=>app.request('/admin/users',{method:'POST',headers:{'Content-Type':'application/json',...(idempotencyKey===null?{}:{'Idempotency-Key':idempotencyKey})},body:JSON.stringify(body)});

  const [left,right]=await Promise.all([post(),post()]);
  assert.equal(left.status,201);assert.equal(right.status,201);
  const leftBody=await left.json() as {item:{id:string;roles:string[]};auditEventId:string;setup:{purpose:'setup';url?:string;expiresAt?:string;emailSent?:boolean;emailFailure?:string|null;reissueRequired?:boolean}};
  const rightBody=await right.json() as typeof leftBody;
  assert.deepEqual(rightBody.item,leftBody.item,'the retry must receive the original user');
  assert.equal(rightBody.auditEventId,leftBody.auditEventId,'the retry must receive the original audit receipt');
  const bodies=[leftBody,rightBody],credential=bodies.find(body=>typeof body.setup.url==='string'),replay=bodies.find(body=>body.setup.reissueRequired===true);
  assert.ok(credential?.setup.url?.startsWith('https://app.test/setup#'));
  assert.deepEqual(credential?.setup,{purpose:'setup',url:credential?.setup.url,expiresAt:new Date(AT+SETUP_LINK_TTL_MS).toISOString(),emailSent:true,emailFailure:null});
  assert.deepEqual(replay?.setup,{purpose:'setup',reissueRequired:true},'the durable replay must never repeat a plaintext credential');
  assert.deepEqual(leftBody.item.roles,['admin']);
  assert.equal(f.count('SELECT COUNT(*) FROM users WHERE tenant_id=? AND email=?',f.tenantId,'parallel@acme.test'),1);
  assert.equal(f.count('SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND actor_user_id=?',f.tenantId,f.userId),1);
  assert.deepEqual(f.events,['admin.user_invited']);
  const stored=f.database.prepare('SELECT response_json FROM idempotency_records WHERE tenant_id=?').pluck().get(f.tenantId) as string;
  assert.doesNotMatch(stored,/setup#|"url"/u,'the durable replay record must not contain the setup credential');
  assert.equal(f.mail.length,1,'only the first request sends the credential email');

  const conflict=await post({...payload,displayName:'Changed Name'});
  assert.equal(conflict.status,409);assert.equal((await conflict.json() as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.events,['admin.user_invited']);
  const tooLong=await post({...payload,email:'other@acme.test'},'i'.repeat(129));
  assert.equal(tooLong.status,400);assert.equal((await tooLong.json() as {error:{code:string}}).error.code,'INVALID_REQUEST');
  const missing=await post({...payload,email:'missing@acme.test'},null);
  assert.equal(missing.status,400);assert.equal((await missing.json() as {error:{code:string}}).error.code,'INVALID_REQUEST');
  f.database.close();
});

test('invitation POST rolls back and leaves its idempotency key reusable',async()=>{
  const f=fixture(true);
  const request=f.request({email:'rollback@acme.test',displayName:'Rollback Admin',role:'admin'});request.headers.set('Idempotency-Key','rollback-invitation');
  await assert.rejects(f.adapter.execute('admin.users.create',request),/forced invitation audit failure/);
  assert.equal(f.count('SELECT COUNT(*) FROM users WHERE tenant_id=? AND email=?',f.tenantId,'rollback@acme.test'),0);
  assert.equal(f.count('SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=?',f.tenantId),0);
  assert.deepEqual(f.events,[]);
  assert.equal(f.mail.length,0);

  f.allowAudit();
  const accepted=await f.adapter.execute('admin.users.create',request);
  assert.equal(accepted.status,201);
  const acceptedSetup=(accepted.body as {setup:{url:string;purpose:string;expiresAt:string;emailSent:boolean;emailFailure:string|null}}).setup;
  assert.deepEqual(acceptedSetup,{purpose:'setup',url:acceptedSetup.url,expiresAt:new Date(AT+SETUP_LINK_TTL_MS).toISOString(),emailSent:true,emailFailure:null});
  assert.equal(f.count('SELECT COUNT(*) FROM users WHERE tenant_id=? AND email=?',f.tenantId,'rollback@acme.test'),1);
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND method='POST' AND path='admin-user-invitation:admin.users.create'",f.tenantId),1);
  assert.equal(f.mail.length,1);

  const replay=await f.makeAdapter().execute('admin.users.create',request);
  assert.deepEqual((replay.body as {item:unknown}).item,(accepted.body as {item:unknown}).item,'a fresh adapter must replay the recovered user from the database');
  assert.deepEqual((replay.body as {setup:unknown}).setup,{purpose:'setup',reissueRequired:true},'a replay says the credential must be re-issued');
  assert.equal(f.mail.length,1,'a replay must not send again');
  f.database.close();
});

test('an invitation can set its password once and then sign in',async()=>{
  const f=fixture(),created=await f.adapter.execute('admin.users.create',f.request({email:'invited@acme.test',displayName:'Invited Member',role:'member',locale:'ja'}));
  const body=created.body as {setup:{url:string};item:{id:string}};
  const token=new URL(body.setup.url).hash.slice(1),audits:string[]=[];
  const identity=createIdentityService({database:f.database,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.test',now:()=>AT+1,audit:{append(input){audits.push(input.action)}}});
  const publicRequest=(value:unknown):RouteRequest=>({tenant:null,requestId:'invite-round-trip',params:{},query:{},headers:new Headers(),body:value,rawBody:null});
  const reset=await identity.execute('auth.passwordReset',publicRequest({token,password:'correct horse battery staple'}));
  assert.deepEqual(reset?.body,{changed:true,purpose:'setup'});
  const login=await identity.execute('auth.login',publicRequest({tenantSlug:'acme',email:'invited@acme.test',password:'correct horse battery staple'}));
  assert.match(login?.headers?.['Set-Cookie']??'',/__Host-session=/u);
  assert.deepEqual(f.database.prepare('SELECT status,email_verified_at IS NOT NULL verified FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,body.item.id),{status:'active',verified:1});
  assert.match(f.mail[0]!.text,/Acme/u);assert.match(f.mail[0]!.text,/リンクの有効期限/u);assert.match(f.mail[0]!.text,/心当たりがない/u);
  assert.ok(audits.includes('auth.password_setup_completed'));
  f.database.close();
});

test('credential-link issuance enforces the complete owner/admin/compliance/member role matrix',async()=>{
  const f=fixture(),targetIds=new Map<string,string>();
  for(const targetRole of ['owner','admin','compliance','member'] as const){
    const id=randomUUID();targetIds.set(targetRole,id);
    f.database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)`).run(id,f.tenantId,`${targetRole}@matrix.test`,targetRole,'hash',AT,AT,AT);
    const roleId=f.database.prepare('SELECT id FROM roles WHERE tenant_id=? AND key=?').pluck().get(f.tenantId,targetRole) as string;
    f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,id,roleId,AT);
  }
  for(const issuerRole of ['owner','admin','compliance','member'] as const)for(const targetRole of ['owner','admin','compliance','member'] as const){
    const result=await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:targetIds.get(targetRole)!},[issuerRole]));
    const allowed=issuerRole==='owner'||(issuerRole==='admin'&&targetRole==='member');
    assert.equal(result.status??200,allowed?200:403,`${issuerRole} -> ${targetRole}`);
    if(allowed)assert.equal((result.body as {credentialLink:{purpose:string}}).credentialLink.purpose,'reset');
  }
  const self=await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:f.userId},['owner']));
  assert.equal(self.status,403,'nobody may issue their own credential link');
  for(const status of ['suspended','deprovisioned'] as const){
    const id=randomUUID();f.database.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,f.tenantId,`${status}@matrix.test`,status,'hash',status,AT,AT);
    const result=await f.adapter.execute('admin.users.credentialLink',f.request({}, {id},['owner']));assert.equal(result.status,409,status);
  }
  const deleted=randomUUID();f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,deleted_at,created_at,updated_at) VALUES(?,?,?,'Deleted','hash','deprovisioned',?,?,?)").run(deleted,f.tenantId,'deleted@matrix.test',AT,AT,AT);
  assert.equal((await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:deleted},['owner']))).status,404);
  f.database.close();
});

test('account actions enforce the complete caller, target, self, and role-assignment matrix',async()=>{
  const f=fixture(),roleId=(role:Role)=>f.database.prepare('SELECT id FROM roles WHERE tenant_id=? AND key=?').pluck().get(f.tenantId,role) as string;
  const seed=(role:Role,status:'active'|'suspended'|'invited',tag:string)=>{const id=randomUUID();f.database.prepare('INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,f.tenantId,`${tag}@matrix.test`,tag,status==='invited'?null:'hash',status,AT,AT);f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,id,roleId(role),AT);const session=randomUUID();f.database.prepare("INSERT INTO sessions(id,tenant_id,user_id,token_hash,jwt_id,auth_method,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,'password',?,?,?)").run(session,f.tenantId,id,createHash('sha256').update(tag).digest('hex'),randomUUID(),AT,AT,AT+60_000);return{id,session}};
  const request=(actor:string,callerRole:Role,body:unknown,target:string,version=true)=>{const base=f.request(body,{id:target},[callerRole]),principal={...base.tenant!.principal,userId:actor,membershipId:actor,roles:[callerRole]};return{...base,tenant:{...base.tenant!,principal},headers:new Headers({...Object.fromEntries(base.headers),...(version?{'If-Match':`"${AT}"`}:{})})} as RouteRequest};
  const snapshot=(id:string)=>({user:f.database.prepare('SELECT status,deleted_at,updated_at FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,id),roles:f.database.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY r.key').pluck().all(f.tenantId,id),sessions:f.database.prepare('SELECT id,revoked_at,revoke_reason FROM sessions WHERE tenant_id=? AND user_id=? ORDER BY id').all(f.tenantId,id),links:f.database.prepare('SELECT purpose,consumed_at,superseded_at FROM credential_links WHERE tenant_id=? AND user_id=? ORDER BY created_at,id').all(f.tenantId,id)});
  const general=(caller:Role,target:Role,self:boolean)=>!self&&(caller==='owner'||(caller==='admin'&&(target==='admin'||target==='member')));
  const expectedActions=(caller:Role,target:Role,self:boolean,status:'active'|'suspended'|'invited')=>{
    const mayAct=general(caller,target,self);
    return {
      changeStatus:mayAct&&(status==='active'||status==='suspended'),
      changeRole:mayAct,
      deprovision:mayAct,
      signOut:self||mayAct,
      credentialLink:status==='invited'?(mayAct?'setup':null):status==='active'?(!self&&(caller==='owner'||(caller==='admin'&&target==='member'))?'reset':null):null,
    };
  };
  const actions=[
    {name:'suspend',status:'active' as const,operation:'admin.users.update',body:{status:'suspended'},version:true,allowed:(c:Role,t:Role,s:boolean)=>general(c,t,s)},
    {name:'re-enable',status:'suspended' as const,operation:'admin.users.update',body:{status:'active'},version:true,allowed:(c:Role,t:Role,s:boolean)=>general(c,t,s)},
    ...(['member','admin','compliance'] as const).map(role=>({name:`role-${role}`,status:'active' as const,operation:'admin.users.update',body:{role},version:true,allowed:(c:Role,t:Role,s:boolean)=>general(c,t,s)&&(role!=='compliance'||c==='owner')})),
    {name:'deprovision',status:'active' as const,operation:'admin.users.delete',body:null,version:true,allowed:(c:Role,t:Role,s:boolean)=>general(c,t,s)},
    {name:'sign-out',status:'active' as const,operation:'admin.users.forceLogout',body:{},version:false,allowed:(c:Role,t:Role,s:boolean)=>s||general(c,t,s)},
    {name:'reset-link',status:'active' as const,operation:'admin.users.credentialLink',body:{},version:false,allowed:(c:Role,t:Role,s:boolean)=>!s&&(c==='owner'||(c==='admin'&&t==='member'))},
    {name:'setup-link',status:'invited' as const,operation:'admin.users.credentialLink',body:{},version:false,allowed:(c:Role,t:Role,s:boolean)=>general(c,t,s)},
  ];
  for(const callerRole of ['owner','admin','compliance','member'] as const)for(const targetKind of ['owner','admin','compliance','member','self'] as const)for(const [index,action] of actions.entries()){
    const actor=seed(callerRole,'active',`${callerRole}-${targetKind}-${action.name}-${index}-actor`),self=targetKind==='self',targetRole=self?callerRole:targetKind,target=self?actor:seed(targetRole,action.status,`${callerRole}-${targetKind}-${action.name}-${index}-target`);
    if(self&&action.status!=='active')f.database.prepare('UPDATE users SET status=? WHERE tenant_id=? AND id=?').run(action.status,f.tenantId,target.id);
    const stableBefore=snapshot(target.id),expected=expectedActions(callerRole,targetRole,self,action.status);
    let advertised=expected;
    if(callerRole!=='member'){
      const listed=await f.adapter.execute('admin.users.list',request(actor.id,callerRole,null,target.id,false)),detail=await f.adapter.execute('admin.users.get',request(actor.id,callerRole,null,target.id,false));assert.equal(listed.status??200,200);assert.equal(detail.status??200,200);
      advertised=((listed.body as {items:Array<{id:string;actions:typeof expected}>}).items.find(item=>item.id===target.id))!.actions;
      assert.deepEqual(advertised,expected,`${callerRole} -> ${targetKind}: ${action.name} list advertisement`);
      assert.deepEqual((detail.body as {actions:typeof expected}).actions,expected,`${callerRole} -> ${targetKind}: ${action.name} detail advertisement`);
    }
    const role=action.name.startsWith('role-')?action.name.slice(5) as Role:null;
    const advertisedAllowed=action.name==='suspend'||action.name==='re-enable'?advertised.changeStatus:role!==null?advertised.changeRole&&(role!=='compliance'||callerRole==='owner'):action.name==='deprovision'?advertised.deprovision:action.name==='sign-out'?advertised.signOut:advertised.credentialLink===(action.name==='setup-link'?'setup':'reset');
    const result=await f.adapter.execute(action.operation,request(actor.id,callerRole,action.body,target.id,action.version)),allowed=action.allowed(callerRole,targetRole,self);
    assert.equal(advertisedAllowed,allowed,`${callerRole} -> ${targetKind}: ${action.name} advertisement`);
    assert.equal(result.status??200,allowed?(action.name==='deprovision'?204:200):403,`${callerRole} -> ${targetKind}: ${action.name}`);
    if(!allowed)assert.deepEqual(snapshot(target.id),stableBefore,`${callerRole} -> ${targetKind}: ${action.name} changed state on refusal`);
  }
  f.database.close();
});

test('account mutations return 404 for a missing target before applying the privilege ceiling',async()=>{
  const f=fixture(),missing=randomUUID();
  const requests:[string,RouteRequest][]=[
    ['admin.users.update',withMatch(f.request({},{id:missing},['admin']),AT)],
    ['admin.users.update',withMatch(f.request({status:'suspended'},{id:missing},['admin']),AT)],
    ['admin.users.delete',withMatch(f.request(null,{id:missing},['admin']),AT)],
    ['admin.users.forceLogout',f.request({}, {id:missing},['admin'])],
    ['admin.users.credentialLink',f.request({}, {id:missing},['admin'])],
  ];
  for(const [operation,request] of requests)assert.equal((await f.adapter.execute(operation,request)).status,404,operation);
  f.database.close();
});

test('user updates reject bodies naming no mutable field and audit only recognised fields',async()=>{
  const f=fixture(),adminId=randomUUID(),adminRoleId=f.database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='admin'").pluck().get(f.tenantId) as string;
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Administrator','hash','active',?,?)").run(adminId,f.tenantId,'empty-update-admin@acme.test',AT,AT);
  f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,adminId,adminRoleId,AT);
  const adminRequest=(body:unknown,idempotent:boolean)=>{
    const base=f.request(body,{id:f.userId},['admin']),headers=new Headers(base.headers);
    headers.set('If-Match',`"${AT}"`);if(!idempotent)headers.delete('Idempotency-Key');
    return {...base,headers,tenant:{...base.tenant!,principal:{...base.tenant!.principal,userId:adminId,membershipId:adminId,roles:['admin']}}} as RouteRequest;
  };
  const owner=()=>f.database.prepare('SELECT * FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.userId);
  const unchanged=owner(),eventCount=f.events.length;
  for(const body of [{},{foo:1}])for(const idempotent of [false,true]){
    const result=await f.adapter.execute('admin.users.update',adminRequest(body,idempotent));
    assert.equal(result.status,422,`${JSON.stringify(body)} with${idempotent?'':'out'} idempotency`);
    assert.deepEqual(owner(),unchanged,`${JSON.stringify(body)} with${idempotent?'':'out'} idempotency changed the owner`);
    assert.equal(f.events.length,eventCount,`${JSON.stringify(body)} with${idempotent?'':'out'} idempotency added an audit event`);
  }
  const changed=await f.adapter.execute('admin.users.update',adminRequest({displayName:'x',foo:1},false));
  assert.equal(changed.status??200,200);
  assert.deepEqual(f.auditInputs.at(-1)?.metadata,{fields:['displayName']});
  f.database.close();
});

test('the account ceiling does not block an administrator from editing owner profile fields',async()=>{
  const f=fixture(),adminId=randomUUID(),adminRoleId=f.database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='admin'").pluck().get(f.tenantId) as string,ownerRoleId=f.database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='owner'").pluck().get(f.tenantId) as string;
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Administrator','hash','active',?,?)").run(adminId,f.tenantId,'profile-admin@acme.test',AT,AT);
  f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,adminId,adminRoleId,AT);
  f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,f.userId,ownerRoleId,AT);
  const base=f.request({displayName:'Owner Renamed',locale:'ja'},{id:f.userId},['admin']),principal={...base.tenant!.principal,userId:adminId,membershipId:adminId};
  const changed=await f.adapter.execute('admin.users.update',withMatch({...base,tenant:{...base.tenant!,principal}},AT));
  assert.equal(changed.status??200,200);
  assert.deepEqual(f.database.prepare('SELECT display_name,locale,status FROM users WHERE tenant_id=? AND id=?').get(f.tenantId,f.userId),{display_name:'Owner Renamed',locale:'ja',status:'active'});
  const refusalBase=f.request({status:'suspended'},{id:f.userId},['admin']);
  const refused=await f.adapter.execute('admin.users.update',withMatch({...refusalBase,tenant:{...refusalBase.tenant!,principal}},AT+1));
  assert.equal(refused.status,403);assert.equal(errorReason(refused),'account_above_caller');
  f.database.close();
});

test('duplicate invitation and self refusals expose stable reasons without changing their legacy envelope',async()=>{
 const f=fixture(),email=f.database.prepare('SELECT email FROM users WHERE tenant_id=? AND id=?').pluck().get(f.tenantId,f.userId) as string,duplicate=await f.adapter.execute('admin.users.create',f.request({email,displayName:'Duplicate'}));
 assert.deepEqual({status:duplicate.status,code:errorCode(duplicate),message:errorMessage(duplicate),reason:errorReason(duplicate)},{status:409,code:'CONFLICT',message:'A user with this email already exists',reason:'email_taken'});
 const self=await f.adapter.execute('admin.users.update',withMatch(f.request({status:'suspended'},{id:f.userId}),AT));
 assert.deepEqual({status:self.status,code:errorCode(self),message:errorMessage(self),reason:errorReason(self)},{status:403,code:'FORBIDDEN',message:'You cannot disable your own account',reason:'self_status_change'});
 f.database.close();
});

test('invited-user re-issue requires invite and the target-role assignment permission',async()=>{
  const f=fixture(),created=await f.adapter.execute('admin.users.create',f.request({email:'setup-role@acme.test',displayName:'Setup Role',role:'admin'})),target=String((created.body as {item:{id:string}}).item.id);
  assert.equal((await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:target},['owner']))).status??200,200);
  assert.equal((await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:target},['admin']))).status??200,200);
  for(const role of ['compliance','member'] as const)assert.equal((await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:target},[role]))).status,403,role);
  f.database.close();
});

test('only the owner can invite a compliance reviewer',async()=>{
  const f=fixture(),adminId=randomUUID(),adminRoleId=f.database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='admin'").pluck().get(f.tenantId) as string;
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Administrator','hash','active',?,?)").run(adminId,f.tenantId,'invite-admin@acme.test',AT,AT);
  f.database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(f.tenantId,adminId,adminRoleId,AT);
  const adminBase=f.request({email:'admin-reviewer@acme.test',displayName:'Admin Reviewer',role:'compliance'}, {},['admin']),adminPrincipal={...adminBase.tenant!.principal,userId:adminId,membershipId:adminId};
  const refused=await f.adapter.execute('admin.users.create',{...adminBase,tenant:{...adminBase.tenant!,principal:adminPrincipal}});
  assert.equal(refused.status,403);assert.equal(f.count('SELECT count(*) FROM users WHERE tenant_id=? AND email=?',f.tenantId,'admin-reviewer@acme.test'),0);
  const accepted=await f.adapter.execute('admin.users.create',f.request({email:'owner-reviewer@acme.test',displayName:'Owner Reviewer',role:'compliance'}));
  assert.equal(accepted.status,201);assert.deepEqual((accepted.body as {item:{roles:string[]}}).item.roles,['compliance']);
  f.database.close();
});

test('mail delivery failure preserves the invited user and never logs the link',async()=>{
  const f=fixture(false,{async send(){throw new Error('mail exploded')}}),result=await f.adapter.execute('admin.users.create',f.request({email:'mail-fail@acme.test',displayName:'Mail Failure'}));
  const setup=(result.body as {setup:{url:string;emailSent:boolean;emailFailure:string}}).setup,token=new URL(setup.url).hash.slice(1);
  assert.deepEqual({emailSent:setup.emailSent,emailFailure:setup.emailFailure},{emailSent:false,emailFailure:'delivery_failed'});
  assert.equal(f.count('SELECT count(*) FROM users WHERE tenant_id=? AND email=?',f.tenantId,'mail-fail@acme.test'),1);
  assert.doesNotMatch(JSON.stringify(f.warnings),new RegExp(token,'u'));
  f.database.close();
  const noSmtp=fixture(false,null),unconfigured=await noSmtp.adapter.execute('admin.users.create',noSmtp.request({email:'no-smtp@acme.test',displayName:'No SMTP'})),unconfiguredSetup=(unconfigured.body as {setup:{url:string;emailSent:boolean;emailFailure:string}}).setup;
  assert.deepEqual({emailSent:unconfiguredSetup.emailSent,emailFailure:unconfiguredSetup.emailFailure},{emailSent:false,emailFailure:'smtp_unconfigured'});assert.match(unconfiguredSetup.url,/\/setup#[A-Za-z0-9_-]{43}$/u);assert.equal(noSmtp.count('SELECT count(*) FROM users WHERE tenant_id=? AND email=?',noSmtp.tenantId,'no-smtp@acme.test'),1);noSmtp.database.close();
});

test('invite, re-issue, forgot, and operator links never persist or log plaintext tokens',async()=>{
  const f=fixture(false,undefined,':memory:',true),tokens:string[]=[];
  const invited=await f.adapter.execute('admin.users.create',f.request({email:'secret-invite@acme.test',displayName:'Secret Invite'})),invitedBody=invited.body as {item:{id:string};setup:{url:string}};
  tokens.push(new URL(invitedBody.setup.url).hash.slice(1));
  const reissued=await f.adapter.execute('admin.users.credentialLink',f.request({}, {id:invitedBody.item.id},['owner']));tokens.push(new URL((reissued.body as {credentialLink:{url:string}}).credentialLink.url).hash.slice(1));
  const identity=createIdentityService({database:f.database,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,1)},recoveryPepper:'pepper',appOrigin:'https://app.example.test',now:()=>AT+1,mailer:{async send(message){f.mail.push(message)}},logger:{warn(message,details){f.warnings.push(details?{message,details}:{message})}},audit:{append(){}}});
  await identity.execute('auth.passwordForgot',{tenant:null,requestId:'forgot-secret',params:{},query:{},headers:new Headers(),body:{email:'member@acme.test',tenantSlug:'acme'},rawBody:null});
  await new Promise<void>(resolve=>setImmediate(resolve));
  tokens.push(new URL(f.mail.at(-1)!.text.match(/https?:\/\/\S+#\S+/u)![0]).hash.slice(1));
  const operatorAudit=createAuditService({database:f.database,ipHmacKey:Buffer.alloc(32,7),transcriptKey:()=>Buffer.alloc(32,8),retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT}),now:()=>AT+2});
  const operator=issueOperatorPasswordLink(f.database,operatorAudit,{workspaceSlug:'acme',email:'member@acme.test',appOrigin:'https://app.example.test',now:AT+2});tokens.push(new URL(operator.url).hash.slice(1));
  const tables=f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
  for(const token of tokens)for(const table of tables){
    const columns=(f.database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{name:string;type:string}>).filter(column=>/TEXT|CHAR|CLOB/u.test(column.type));
    for(const column of columns){const count=f.database.prepare(`SELECT count(*) FROM ${JSON.stringify(table)} WHERE instr(CAST(${JSON.stringify(column.name)} AS TEXT),?)>0`).pluck().get(token) as number;assert.equal(count,0,`${table}.${column.name}`)}
    assert.doesNotMatch(JSON.stringify(f.warnings),new RegExp(token,'u'));
  }
  f.database.close();
});

test('no admin statement is refused by the tenant-binding guard', () => {
  // Cheap standing check. Every one of these is reachable from the console, most are reachable from
  // exactly one screen, and a statement the guard refuses is a 500 on that screen and nowhere else —
  // which is how ten of them shipped.
  const database = new Database(':memory:'); runMigrations(database);
  const statements = prepareAdminStatements(database) as unknown as Record<string,{source?:string}>;
  const refused = Object.entries(statements)
    .map(([name, statement]) => [name, typeof statement.source === 'string' ? assertTenantFirst(statement.source) : null] as const)
    .filter(([, problem]) => problem !== null);
  assert.deepEqual(refused, [], `admin statements the guard refuses: ${refused.map(([name, problem]) => `${name} (${problem})`).join(', ')}`);
  database.close();
});

test('legal holds enforce roles, validation, workspace scope, replay, release and audit metadata',async()=>{
  const f=fixture(false,undefined,':memory:',true);
  const projectId=randomUUID(),conversationId=randomUUID();
  f.database.prepare("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Matter',?,?)").run(projectId,f.tenantId,f.userId,AT,AT);
  f.database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Private matter','active',?,?)").run(conversationId,f.tenantId,f.userId,AT,AT);
  const otherTenant=randomUUID(),otherUser=randomUUID();
  f.database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'legal-hold-other','Other','active',?,?)").run(otherTenant,AT,AT);
  f.database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,'other@example.test','Other','hash','active',?,?)").run(otherUser,otherTenant,AT,AT);

  for(const roles of [['admin'],['member']] as Role[][]){
    assert.equal((await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'tenant',reason:'Case'}, {},roles))).status,403);
    assert.equal((await f.adapter.execute('admin.legalHolds.release',f.request({reason:'Done'},{id:randomUUID()},roles))).status,403);
  }
  assert.equal((await f.adapter.execute('admin.legalHolds.list',f.request(null,{},['admin']))).status,undefined,'administrators may list holds');

  const invalid=[
    {scopeType:'unknown',reason:'x'},
    {scopeType:'user',reason:'x'},
    {scopeType:'user',scopeId:42,reason:'x'},
    {scopeType:'user',scopeId:projectId,reason:'x'},
    {scopeType:'conversation',scopeId:projectId,reason:'x'},
    {scopeType:'project',scopeId:conversationId,reason:'x'},
    {scopeType:'tenant',scopeId:f.userId,reason:'x'},
    {scopeType:'date_range',reason:'x'},
    {scopeType:'date_range',startsAt:'not-a-date',reason:'x'},
    {scopeType:'date_range',startsAt:'2025-02-01T00:00:00.000Z',endsAt:'2025-02-01T00:00:00.000Z',reason:'x'},
    {scopeType:'date_range',startsAt:'2025-02-02T00:00:00.000Z',endsAt:'2025-02-01T00:00:00.000Z',reason:'x'},
    {scopeType:'tenant',reason:null},
    {scopeType:'tenant',reason:'   '},
    {scopeType:'tenant',reason:'x'.repeat(1001)},
    {scopeType:'user',scopeId:otherUser,reason:'x'},
  ];
  for(const body of invalid){const result=await f.adapter.execute('admin.legalHolds.create',f.request(body));assert.equal(result.status,422,JSON.stringify(body));}
  for(const [field,value] of [['startsAt','2026-02-01'],['endsAt','2026-02-01T08:00:00']] as const){const result=await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'date_range',[field]:value,reason:'x'}));assert.equal(result.status,422);assert.equal(errorCode(result),'VALIDATION_FAILED');assert.match(String(errorMessage(result)),new RegExp(field));}
  const missing=await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'user',scopeId:randomUUID(),reason:'x'}));
  const foreign=await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'user',scopeId:otherUser,reason:'x'}));
  assert.deepEqual({status:foreign.status,code:errorCode(foreign),message:errorMessage(foreign)},{status:missing.status,code:errorCode(missing),message:errorMessage(missing)},'foreign and missing target ids are indistinguishable');
  const reversed=await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'date_range',startsAt:'2025-02-02T00:00:00.000Z',endsAt:'2025-02-01T00:00:00.000Z',reason:'x'}));assert.equal(errorReason(reversed),'date_order_invalid');
  f.database.prepare("INSERT INTO audit_legal_holds(id,tenant_id,scope_type,reason,created_by_user_id,created_at_ms) VALUES(?,?,'tenant','Other',?,?)").run(randomUUID(),otherTenant,otherUser,AT);
  const otherHold=f.database.prepare('SELECT id FROM audit_legal_holds WHERE tenant_id=?').pluck().get(otherTenant) as string;
  assert.equal((await f.adapter.execute('admin.legalHolds.release',f.request({reason:'Done'},{id:otherHold}))).status,404);

  for(const roles of [['owner'],['compliance'],['admin','compliance']] as Role[][]){
    const request=f.request({scopeType:'conversation',scopeId:conversationId,reason:'  Litigation request  '},{},roles);request.headers.set('Idempotency-Key',`place-${roles.join('-')}`);
    const placed=await f.adapter.execute('admin.legalHolds.create',request),replay=await f.makeAdapter().execute('admin.legalHolds.create',request);
    assert.equal(placed.status,201);assert.deepEqual(replay,placed);
    const holdId=String(item(placed).id),release=f.request({reason:'  Matter closed  '},{id:holdId},roles);release.headers.set('Idempotency-Key',`release-${roles.join('-')}`);
    assert.equal((await f.adapter.execute('admin.legalHolds.release',f.request({reason:' '},{id:holdId},roles))).status,422);assert.equal((await f.adapter.execute('admin.legalHolds.release',f.request({reason:'x'.repeat(1001)},{id:holdId},roles))).status,422);
    const released=await f.adapter.execute('admin.legalHolds.release',release),releaseReplay=await f.makeAdapter().execute('admin.legalHolds.release',release);
    assert.deepEqual(releaseReplay,released);assert.equal((await f.adapter.execute('admin.legalHolds.release',f.request({reason:'Again'},{id:holdId},roles))).status,409);
  }
  const events=f.database.prepare("SELECT action,metadata_json FROM audit_events WHERE tenant_id=? AND action IN ('admin.legal_hold_placed','admin.legal_hold_released') ORDER BY sequence").all(f.tenantId) as Array<{action:string;metadata_json:string}>;
  assert.equal(events.length,6);
  for(const event of events){const metadata=JSON.parse(event.metadata_json) as Record<string,unknown>;assert.deepEqual(Object.keys(metadata).sort(),['holdId','reasonLength','scopeId','scopeType']);assert.equal(metadata.reasonLength,event.action.endsWith('placed')?18:13);assert.doesNotMatch(event.metadata_json,/Litigation|closed/);}
  f.database.close();
});

test('legal holds may target departed users and labels never expose conversation titles',async()=>{
  const f=fixture(),conversationId=randomUUID(),conversationCreatedAt=Date.parse('2026-02-09T23:00:00.000Z');
  f.database.prepare("UPDATE users SET status='deprovisioned',deleted_at=? WHERE tenant_id=? AND id=?").run(AT,f.tenantId,f.memberId);
  const userHold=await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'user',scopeId:f.memberId,reason:'Employment matter'}));assert.equal(userHold.status,201);
  f.database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Never expose this title','active',?,?)").run(conversationId,f.tenantId,f.userId,conversationCreatedAt,conversationCreatedAt);
  assert.equal((await f.adapter.execute('admin.legalHolds.create',f.request({scopeType:'conversation',scopeId:conversationId,reason:'Conversation matter'}))).status,201);
  const listRequest={...f.request(null),query:{status:'all',limit:'1'}},first=await f.adapter.execute('admin.legalHolds.list',listRequest),firstBody=first.body as {items:Array<Record<string,unknown>>;nextCursor:string|null};
  assert.equal(firstBody.items.length,1);assert.ok(firstBody.nextCursor);assert.doesNotMatch(JSON.stringify(firstBody.items),/Never expose this title/);
  const second=await f.adapter.execute('admin.legalHolds.list',{...f.request(null),query:{status:'all',limit:'1',cursor:firstBody.nextCursor!}}),items=[...firstBody.items,...(second.body as {items:Array<Record<string,unknown>>}).items];
  assert.ok(items.some(item=>item.scopeType==='user'&&item.scopeLabel==='Member'));
  assert.ok(items.some(item=>item.scopeType==='conversation'&&item.scopeLabel==='Owner'&&item.scopeCreatedAt==='2026-02-09T23:00:00.000Z'));
  assert.doesNotMatch(JSON.stringify(items),/Never expose this title/);
  const searched=await f.adapter.execute('admin.legalHolds.users',{...f.request(null),query:{search:'member@acme'}});assert.equal((searched.body as {items:Array<{id:string}>}).items[0]?.id,f.memberId);
  assert.equal((await f.adapter.execute('admin.legalHolds.list',{...f.request(null),query:{status:'invalid'}})).status,422);
  f.database.close();
});

test('settings publish exactly the extraction registry upload types',async()=>{
  const f=fixture(),result=await f.adapter.execute('admin.settings.get',f.request(null));
  const body=result.body as {accepted_upload_mime_types:string[]};
  assert.deepEqual(body.accepted_upload_mime_types.sort(),['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/csv','text/markdown','text/plain'].sort());
  f.database.close();
});

test('workspace timezone is canonicalized, returned, audited, and rejected atomically',async()=>{
  const f=fixture(),alias='asia/taipei',expected=new Intl.DateTimeFormat('en',{timeZone:alias}).resolvedOptions().timeZone;
  const accepted=await f.adapter.execute('admin.settings.update',withMatch(f.request({timezone:alias}),AT));
  assert.equal(accepted.status,undefined);assert.equal(item(accepted).timezone,expected);
  assert.equal(((await f.adapter.execute('admin.settings.get',f.request(null))).body as {timezone:string}).timezone,expected);
  assert.equal(((await f.adapter.execute('admin.capabilities',f.request(null))).body as {tenantTimezone:string}).tenantTimezone,expected);
  assert.deepEqual((f.auditInputs.at(-1)?.metadata as {fields?:string[]}).fields,['timezone']);
  const version=Number(item(accepted).updated_at);
  for(const invalid of ['Taipei','GMT+8','+08:00','',8]){
    const result=await f.adapter.execute('admin.settings.update',withMatch(f.request({timezone:invalid}),version));
    assert.equal(result.status,422);assert.equal(errorMessage(result),'timezone must be a valid IANA time zone');
    assert.equal(f.database.prepare('SELECT timezone FROM tenant_settings WHERE tenant_id=?').pluck().get(f.tenantId),expected);
  }
  f.database.close();
});

test('settings numeric limits reject wrong types, fractions, and out-of-range values without a write',async()=>{
  const f=fixture();
  for(const [field,max] of [['retentionDays',3650],['requestsPerMinute',10000],['concurrentStreams',100]] as const){
    const message=`${field} must be an integer between 1 and ${max}`;
    for(const value of ['2',1.5,max+1]){const result=await f.adapter.execute('admin.settings.update',withMatch(f.request({[field]:value}),AT));assert.equal(result.status,422);assert.equal(errorMessage(result),message);assert.equal(f.database.prepare('SELECT updated_at FROM tenant_settings WHERE tenant_id=?').pluck().get(f.tenantId),AT);}
  }
  f.database.close();
});

test('budget create validates enum fields and zones, defaults to the workspace zone, and update validates its zone',async()=>{
  const f=fixture(),groupId=randomUUID();
  f.database.prepare('UPDATE tenant_settings SET timezone=? WHERE tenant_id=?').run('Asia/Taipei',f.tenantId);
  f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(groupId,f.tenantId,'Budget group',AT,AT);
  const valid={scope:'tenant',period:'monthly',metric:'tokens',hardLimit:100};
  const created=await f.adapter.execute('budgets.create',f.request(valid));assert.equal(item(created).timezone,'Asia/Taipei');
  const inverted=await f.adapter.execute('budgets.create',f.request({...valid,softLimit:101}));assert.equal(inverted.status,422);assert.equal(errorReason(inverted),'soft_limit_above_hard');
  for(const [body,message] of [[{...valid,scope:'Group',scopeId:groupId},'scope must be one of tenant, group, user'],[{...valid,period:'Weekly'},'period must be one of daily, weekly, monthly'],[{...valid,metric:'USD'},'metric must be one of tokens, usd'],[{...valid,period:'daily',timezone:'GMT+8'},'timezone must be a valid IANA time zone']] as const){
    const before=f.count('SELECT COUNT(*) FROM budgets WHERE tenant_id=?',f.tenantId),result=await f.adapter.execute('budgets.create',f.request(body));assert.equal(result.status,422);assert.equal(errorMessage(result),message);assert.equal(f.count('SELECT COUNT(*) FROM budgets WHERE tenant_id=?',f.tenantId),before);
  }
  const id=String(item(created).id);
  for(const [body,message] of [[{timezone:'Taipei'},'timezone must be a valid IANA time zone']] as const){
    const updated=await f.adapter.execute('budgets.update',withMatch(f.request(body,{id}),AT));assert.equal(updated.status,422);assert.equal(errorMessage(updated),message);
    assert.deepEqual(f.database.prepare('SELECT scope_type,period,metric,timezone FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,id),{scope_type:'tenant',period:'monthly',metric:'tokens',timezone:'Asia/Taipei'});
  }
  f.database.close();
});

test('budget PATCH refuses identity fields without changing the row or recording an audit event',async()=>{
  const f=fixture(),groupId=randomUUID();
  f.database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(groupId,f.tenantId,'Budget group',AT,AT);
  const created=await f.adapter.execute('budgets.create',f.request({scope:'tenant',period:'monthly',metric:'tokens',softLimit:80,hardLimit:100,timezone:'UTC'}));
  const id=String(item(created).id),before=f.database.prepare('SELECT * FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,id),auditCount=f.auditInputs.length;
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/budgets/:id');
  assert.ok(route);
  const app=new Hono<{Variables:AppVariables}>();app.onError(handleRequestError);
  const base=f.request(null).tenant!;
  app.use('*',async(c,next)=>{const principal={...base.principal,permissions:new Set<Permission>(['budget:write'])};c.set('requestId','immutable-budget-field');c.set('tenant',{...base,principal,requestId:'immutable-budget-field'});await next()});
  mountDefinitions(app,{execute:(operation,request)=>f.adapter.execute(operation,request)},[route]);
  for(const [field,body] of [
    ['scope',{scope:'group'}],
    ['scopeType',{scopeType:'group'}],
    ['scopeId',{scopeId:groupId}],
    ['period',{period:'weekly'}],
    ['metric',{metric:'usd'}],
  ] as const){
    const response=await app.request(`/budgets/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':`"${AT}"`,'Idempotency-Key':`immutable-${field}`},body:JSON.stringify(body)});
    const result=await response.json() as {error:{code:string;message:string}};
    assert.equal(response.status,422,field);assert.equal(result.error.code,'VALIDATION_FAILED',field);
    assert.equal(result.error.message,`${field} cannot be changed; create a new budget instead`,field);
    assert.deepEqual(f.database.prepare('SELECT * FROM budgets WHERE tenant_id=? AND id=?').get(f.tenantId,id),before,field);
    assert.equal(f.auditInputs.length,auditCount,field);
  }
  assert.equal(f.count("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='admin-budget-update:budgets.update'",f.tenantId),0);
  const updated=await f.adapter.execute('budgets.update',withMatch(f.request({hardLimit:200},{id}),AT));
  assert.equal(updated.status,undefined);assert.equal(item(updated).hardLimit,200);
  f.database.close();
});
