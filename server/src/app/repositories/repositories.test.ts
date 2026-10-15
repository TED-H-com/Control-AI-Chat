import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {Hono} from 'hono';
import { runMigrations } from '../../lib/migrations/index.js';
import type {AppVariables, TenantContext} from '../../lib/http/index.js';
import { forTenant } from '../../lib/db.js';
import type {ConversationDetail, RequestPrincipal, TenantId} from '../../shared/types.js';
import {routeDefinitions} from '../../routes/catalog.js';
import {mountDefinitions} from '../../routes/http.js';
import { assembleProjectContext } from './context.js';
import { ConversationRepository } from './conversations.js';
import { RepositoryError } from './errors.js';
import { MessageRepository } from './messages.js';
import { ProjectRepository } from './projects.js';
import { SkillRepository } from './skills.js';
import { UserPreferenceRepository } from './preferences.js';
import { createAuditService } from '../../lib/audit/index.js';

function fixture(){const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);const tenantId=crypto.randomUUID() as TenantId,userId=crypto.randomUUID(),now=1_700_000_000_000;database.prepare('INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,\'active\',?,?)').run(tenantId,'repo-test','Repo Test',now,now);database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)`).run(userId,tenantId,'user@example.test','User','hash',now,now);const tenantDb=forTenant({tenantId});const principal:RequestPrincipal={tenantId,userId,membershipId:crypto.randomUUID(),roles:['member'],permissions:new Set(['project:read','project:write','skill:read','skill:write']),sessionId:crypto.randomUUID()};const context:TenantContext={principal,db:tenantDb,requestId:'test-request',now:new Date(now)};const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:true,effectiveAtMs:now})});return{database,context,audit}}

const events=(database:Database.Database)=>database.prepare('SELECT action,actor_id,actor_session_id session_id,request_id,target_type,target_id,project_id,conversation_id,metadata_json FROM audit_events ORDER BY sequence').all() as Array<{action:string;actor_id:string|null;session_id:string|null;request_id:string;target_type:string;target_id:string|null;project_id:string|null;conversation_id:string|null;metadata_json:string}>;

test('conversation lifecycle writes dimension-accurate audit rows with caller attribution',()=>{
  const {database,context,audit}=fixture(),projects=new ProjectRepository(database,audit),conversations=new ConversationRepository(database,audit);
  const first=projects.create(context,{name:'First'}),second=projects.create(context,{name:'Second'}),conversation=conversations.create(context,{title:'Before',projectId:first.id});
  const created=events(database).find(row=>row.action==='chat.conversation_created')!;
  assert.deepEqual(JSON.parse(created.metadata_json),{projectId:first.id});assert.equal(created.project_id,first.id);assert.equal(created.conversation_id,conversation.id);
  const before=events(database).length;
  conversations.update(context,conversation.id,{title:'After',projectId:second.id,pinned:false,status:'active'});
  conversations.update(context,conversation.id,{title:'After',projectId:second.id,pinned:true,status:'archived'});
  conversations.delete(context,conversation.id);conversations.restore(context,conversation.id);
  const rows=events(database).slice(before),actions=rows.map(row=>row.action);
  assert.deepEqual(actions,['chat.conversation_renamed','chat.project_conversation_moved','chat.conversation_pinned','chat.conversation_archived','chat.conversation_deleted','chat.conversation_restored']);
  assert.deepEqual(rows.map(row=>JSON.parse(row.metadata_json)),[{titleLength:5},{fromProjectId:first.id,toProjectId:second.id},{pinned:true},{archived:true},{soft:true},{}]);
  assert.ok(rows.every(row=>row.actor_id===context.principal.userId&&row.session_id===context.principal.sessionId&&row.request_id===context.requestId&&row.conversation_id===conversation.id));
  database.close();
});

test('project lifecycle writes created, changed-field, and deleted audit rows',()=>{
  const {database,context,audit}=fixture(),projects=new ProjectRepository(database,audit),project=projects.create(context,{name:'Project'});
  projects.update(context,project.id,{name:'Renamed',instructions:'Rules'});projects.delete(context,project.id);
  const rows=events(database).filter(row=>row.action.startsWith('chat.'));assert.deepEqual(rows.map(row=>row.action),['chat.project_created','chat.project_updated','chat.project_deleted']);
  assert.deepEqual(rows.map(row=>JSON.parse(row.metadata_json)),[{projectId:project.id},{changedFields:['name','instructions']},{projectId:project.id}]);
  database.close();
});

test('skill lifecycle writes create, update, publish, invoke, and delete audit rows',()=>{
  const {database,context,audit}=fixture(),skills=new SkillRepository(database,audit),skill=skills.create(context,{scope:'personal',name:'Brief',template:'Hi {{name}}',parameters:[{name:'name',required:true}],published:false});
  const updated=skills.update(context,skill.id,{description:'Useful',published:true});skills.render(context,skill.id,{name:'Ada'});skills.delete(context,skill.id);
  const rows=events(database).filter(row=>row.action.startsWith('chat.'));assert.deepEqual(rows.map(row=>row.action),['chat.skill_created','chat.skill_updated','chat.skill_published','chat.skill_invoked','chat.skill_deleted']);
  assert.deepEqual(rows.map(row=>JSON.parse(row.metadata_json)),[{skillId:skill.id,scope:'personal'},{skillId:skill.id,revision:updated.version,changedFields:['description']},{skillId:skill.id,scope:'personal'},{skillId:skill.id,revision:updated.version,parameterNames:['name']},{skillId:skill.id}]);
  database.close();
});

test('conversation and project repositories isolate ownership and keyset paginate',()=>{const {database,context,audit}=fixture();const projects=new ProjectRepository(database,audit),conversations=new ConversationRepository(database,audit),project=projects.create(context,{name:'Research',instructions:'Use citations.'});for(let i=0;i<3;i++)conversations.create(context,{title:`Thread ${i}`,projectId:project.id});const first=conversations.list(context,{projectId:project.id,limit:2});assert.equal(first.data.length,2);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);const second=conversations.list(context,{projectId:project.id,limit:2,cursor:first.nextCursor!});assert.equal(second.data.length,1);assert.equal(new Set([...first.data,...second.data].map(x=>x.id)).size,3);conversations.delete(context,first.data[0]!.id);assert.equal(conversations.get(context,first.data[0]!.id).status,'deleted');conversations.restore(context,first.data[0]!.id);assert.equal(conversations.get(context,first.data[0]!.id).status,'active');database.close()});

test('conversation assistant updates validate shape and tenant ownership',()=>{
  const {database,context,audit}=fixture(),conversations=new ConversationRepository(database,audit),conversation=conversations.create(context),now=context.now.getTime();
  const otherTenant=crypto.randomUUID() as TenantId,ownedModel=crypto.randomUUID(),otherModel=crypto.randomUUID(),ownedAssistant=crypto.randomUUID(),otherAssistant=crypto.randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Other tenant','active',?,?)").run(otherTenant,`other-${otherTenant.slice(0,8)}`,now,now);
  const insertModel=database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at) VALUES(?,?, 'openai',?,?,4096,512,1,1,?,?)");
  insertModel.run(ownedModel,context.principal.tenantId,'owned-model','Owned model',now,now);
  insertModel.run(otherModel,otherTenant,'other-model','Other model',now,now);
  const insertAssistant=database.prepare('INSERT INTO assistants(id,tenant_id,name,system_prompt,model_catalog_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  insertAssistant.run(ownedAssistant,context.principal.tenantId,'Owned assistant','Help.',ownedModel,now,now);
  insertAssistant.run(otherAssistant,otherTenant,'Other assistant','Help.',otherModel,now,now);

  conversations.update(context,conversation.id,{assistantId:ownedAssistant});
  assert.equal(conversations.get(context,conversation.id).assistantId,ownedAssistant);
  for(const assistantId of [crypto.randomUUID(),otherAssistant])assert.throws(()=>conversations.update(context,conversation.id,{assistantId}),(error:unknown)=>error instanceof RepositoryError&&error.code==='NOT_FOUND');
  conversations.update(context,conversation.id,{assistantId:null});
  assert.equal(conversations.get(context,conversation.id).assistantId,null);
  for(const assistantId of ['short',42])assert.throws(()=>conversations.update(context,conversation.id,{assistantId:assistantId as string}),(error:unknown)=>error instanceof RepositoryError&&error.code==='VALIDATION_FAILED');
  database.close();
});

test('project deletion uses the real tenant guard and soft-deletes the owned project',()=>{
  const {database,context,audit}=fixture(),projects=new ProjectRepository(database,audit);
  const project=projects.create(context,{name:'Temporary workspace'});
  projects.delete(context,project.id,project.version);
  assert.throws(()=>projects.get(context,project.id),/Project not found/);
  assert.equal(database.prepare('SELECT deleted_at FROM projects WHERE tenant_id=? AND id=?').pluck().get(context.principal.tenantId,project.id),context.now.getTime());
  database.close();
});

test('message reads and GET conversation expose protected item and distinct detector counts',async()=>{
  const {database,context,audit}=fixture(),conversations=new ConversationRepository(database,audit),messages=new MessageRepository(database);
  const conversation=conversations.create(context,{title:'Policy review'}),messageId=crypto.randomUUID(),decisionId=crypto.randomUUID(),now=context.now.getTime();
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,protected_item_count,created_at,completed_at) VALUES(?,?,?,?, 'user','complete',0,3,?,?)")
    .run(messageId,context.principal.tenantId,conversation.id,context.principal.userId,now,now+1);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,?, 'text',?,'{}',?)")
    .run(crypto.randomUUID(),context.principal.tenantId,messageId,0,'blocked employee text',now);
  database.prepare("INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,protected_item_count,redacted_excerpt,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,'outbound','redact','final',?,'[]','[\"pii\",\"pii\"]',3,'[EMAIL]',1,0,?)")
    .run(decisionId,context.principal.tenantId,context.principal.userId,conversation.id,messageId,'a'.repeat(64),now);
  const page=messages.list(context,conversation.id),item=page.data[0]!;
  assert.equal(item.content,'blocked employee text');assert.equal(item.gate?.decisionId,decisionId);assert.equal(item.gate?.action,'redact');assert.equal(item.gate?.detectorCount,1);assert.equal(item.gate?.protectedItemCount,3);
  assert.deepEqual(messages.all(context,conversation.id),page.data);
  const app=new Hono<{Variables:AppVariables}>();
  app.use('*',async(c,next)=>{c.set('requestId',context.requestId);c.set('tenant',context);await next()});
  mountDefinitions(app,{async execute(operation,request){assert.equal(operation,'conversations.get');const id=request.params.id!;return{body:{conversation:conversations.get(context,id),messages:messages.all(context,id)}}}},routeDefinitions.filter(route=>route.operation==='conversations.get'));
  const response=await app.request(`/conversations/${conversation.id}`),detail=await response.json() as ConversationDetail;
  assert.equal(response.status,200);assert.equal(detail.messages[0]?.gate?.detectorCount,1);assert.equal(detail.messages[0]?.gate?.protectedItemCount,3);
  assert.throws(()=>messages.list(member(database,context.principal.tenantId),conversation.id),/Conversation not found/);
  database.close();
});

/** A second colleague in the same tenant. Cross-tenant is the easy case; the interesting one is here. */
function member(database:Database.Database,tenantId:TenantId,now=1_700_000_000_000):TenantContext{
  const userId=crypto.randomUUID();
  database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)`).run(userId,tenantId,`${userId}@example.test`,'Colleague','hash',now,now);
  const db=forTenant({tenantId});
  return {principal:{tenantId,userId,membershipId:crypto.randomUUID(),roles:['member'],permissions:new Set(['project:read','project:write']),sessionId:crypto.randomUUID()},db,requestId:'test',now:new Date(now)};
}

test('a project lists only its own conversations, and only to the person whose project it is',()=>{
  const {database,context,audit}=fixture();const projects=new ProjectRepository(database,audit),conversations=new ConversationRepository(database,audit);
  const project=projects.create(context,{name:'Vendor Review'}),inside=[0,1].map(i=>conversations.create(context,{title:`Filed ${i}`,projectId:project.id}));
  conversations.create(context,{title:'Unfiled'});
  const page=projects.conversations(context,project.id);
  assert.deepEqual(page.data.map(row=>row.title).sort(),['Filed 0','Filed 1'],'the loose conversation must not appear under the project');
  assert.deepEqual(page.data.map(row=>row.projectId),[project.id,project.id]);
  const first=projects.conversations(context,project.id,{limit:1});
  assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
  assert.deepEqual(projects.conversations(context,project.id,{limit:1,cursor:first.nextCursor!}).data.map(row=>row.id),
    [inside.map(row=>row.id).find(id=>id!==first.data[0]!.id)],'the cursor must advance rather than repeat the first row');
  // Not an empty page. The conversation query is already scoped to the caller, so without the
  // ownership check this call would succeed with zero rows and confirm the id exists.
  assert.throws(()=>projects.conversations(member(database,context.principal.tenantId),project.id),/Project not found/,'another member must not learn that the project exists');
  database.close();
});

test('project conversation counts match the active conversations each project owner can list',()=>{
  const {database,context,audit}=fixture(),colleague=member(database,context.principal.tenantId),projects=new ProjectRepository(database,audit),conversations=new ConversationRepository(database,audit);
  const firstProject=projects.create(context,{name:'First owner project'}),secondProject=projects.create(colleague,{name:'Second owner project'});
  const firstOwn=conversations.create(context,{title:'First own',projectId:firstProject.id}),firstForeign=conversations.create(colleague,{title:'First foreign'});
  const secondOwn=conversations.create(colleague,{title:'Second own',projectId:secondProject.id}),secondForeign=conversations.create(context,{title:'Second foreign'});
  const attach=database.prepare('INSERT INTO project_conversations(project_id,conversation_id,added_by_user_id,added_at) VALUES(?,?,?,?)');
  attach.run(firstProject.id,firstForeign.id,context.principal.userId,context.now.getTime());
  attach.run(secondProject.id,secondForeign.id,colleague.principal.userId,colleague.now.getTime());
  assert.equal(projects.get(context,firstProject.id).conversationCount,1);
  assert.deepEqual(projects.conversations(context,firstProject.id).data.map(row=>row.id),[firstOwn.id]);
  assert.equal(projects.get(colleague,secondProject.id).conversationCount,1);
  assert.deepEqual(projects.conversations(colleague,secondProject.id).data.map(row=>row.id),[secondOwn.id]);
  database.close();
});

test('skills render validated arguments and persist invocation metadata',()=>{const {database,context,audit}=fixture();const skills=new SkillRepository(database,audit),skill=skills.create(context,{scope:'personal',name:'Brief',template:'Hello {{audience}}',parameters:[{name:'audience',required:true,maxLength:20}]});const rendered=skills.render(context,skill.id,{audience:'board'});assert.equal(rendered.rendered,'Hello board');assert.equal(database.prepare<[],{count:number}>('SELECT count(*) count FROM skill_invocations').get()!.count,1);assert.throws(()=>skills.render(context,skill.id,{}),/required/);database.close()});

test('context assembly reserves output, truncates at paragraphs, and keeps newest history',()=>{const assembled=assembleProjectContext({modelContextWindow:100,configuredMaxOutput:20,system:['system'],projectInstructions:'first\n\nsecond',projectFiles:[{id:'a',text:'abcdefghij',relevance:1,createdAt:1},{id:'b',text:'klmnopqrst',relevance:2,createdAt:2}],history:[{id:'old',text:'x'.repeat(80)},{id:'new',text:'new'}],userMessage:'ask'},x=>x.length);assert.equal(assembled.budget.output,20);assert.equal(assembled.parts.at(-1)?.source,'user');assert.ok(assembled.parts.some(x=>x.source==='history'&&x.sourceId==='new'));assert.ok(!assembled.parts.some(x=>x.sourceId==='old'))});

test('default repository context accounting uses multilingual UTF-8 bytes',()=>{
  const text='資料治理 🧑‍💻',expected=Math.ceil(Buffer.byteLength(text,'utf8')/3);
  const assembled=assembleProjectContext({modelContextWindow:100,configuredMaxOutput:20,system:[],userMessage:text});
  assert.equal(assembled.parts.at(-1)?.tokens,expected);assert.equal(assembled.tokenCount,expected);
  assert.throws(()=>assembleProjectContext({modelContextWindow:expected,configuredMaxOutput:1,system:[],userMessage:text}),/CONTEXT_WINDOW_EXCEEDED|mandatory reservations/);
});

/**
 * Appearance had no test at all, and its UPDATE was refused by the tenant-binding guard, so every
 * attempt to change the appearance answered 500. The same defect sat in eleven sibling statements:
 * renaming, pinning, deleting and restoring a conversation, editing and deleting a project, and
 * editing and deleting a skill. They shared a CTE whose first column was `tenant`, and the guard
 * accepts a leading CTE only when that column is `tenant_id` — the tests could not see it because
 * both fixtures hand-rolled a TenantDb that binds the tenant id without ever running the guard.
 */
test('a member can change their appearance, and it survives a re-read',()=>{
  const {database,context,audit}=fixture();
  const preferences=new UserPreferenceRepository(database);
  assert.equal(preferences.get(context).density,'comfortable');
  const saved=preferences.update(context,{density:'compact',colorMode:'dark'});
  assert.equal(saved.density,'compact');
  assert.equal(saved.colorMode,'dark');
  assert.equal(preferences.get(context).density,'compact','the choice must outlive the request that made it');
  assert.throws(()=>preferences.update(context,{density:'invalid' as 'compact'}),/VALIDATION_FAILED|Invalid user preferences/);
  assert.deepEqual(preferences.get(context),saved,'invalid input must not write any preference');
  database.close();
});

test('default model preference requires an enabled model the caller may use',()=>{
  const {database,context}=fixture(),preferences=new UserPreferenceRepository(database),now=context.now.getTime();
  const otherTenant=crypto.randomUUID() as TenantId,otherModel=crypto.randomUUID(),disabledModel=crypto.randomUUID(),deniedModel=crypto.randomUUID(),validModel=crypto.randomUUID(),groupId=crypto.randomUUID(),providerId=crypto.randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,'preference-other','Other','active',?,?)").run(otherTenant,now,now);
  const insertModel=database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at) VALUES(?,?, 'openai',?,?,?,4096,512,1,1,?,?)");
  insertModel.run(otherModel,otherTenant,'other','Other',1,now,now);insertModel.run(disabledModel,context.principal.tenantId,'disabled','Disabled',0,now,now);insertModel.run(deniedModel,context.principal.tenantId,'denied','Denied',1,now,now);insertModel.run(validModel,context.principal.tenantId,'valid','Valid',1,now,now);
  database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Members',?,?)").run(groupId,context.principal.tenantId,now,now);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(context.principal.tenantId,groupId,context.principal.userId,now);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,created_at,updated_at) VALUES(?,?,'openai',1,'environment',?,?)").run(providerId,context.principal.tenantId,now,now);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,providerId);
  database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,validModel);
  for(const modelId of [otherModel,disabledModel,deniedModel]){
    assert.throws(()=>preferences.update(context,{defaultModelId:modelId}),(error:unknown)=>error instanceof RepositoryError&&error.code==='VALIDATION_FAILED');
    assert.equal(preferences.get(context).defaultModelId,null,'invalid preference must not be written');
  }
  assert.equal(preferences.update(context,{defaultModelId:validModel}).defaultModelId,validModel);
  assert.equal(preferences.update(context,{defaultModelId:null}).defaultModelId,null);
  database.close();
});
