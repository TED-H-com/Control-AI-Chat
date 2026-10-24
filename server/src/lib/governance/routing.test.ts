import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations/index.js';
import { GovernanceError } from './errors.js';
import { loadRoutingCandidates,selectFastMultiModelPlan,selectSingleRoute,type RoutingCandidate } from './router.js';

const NOW=Date.UTC(2026,7,10);

function routingDatabase():Database.Database {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  return database;
}

function tenant(database:Database.Database,id=randomUUID(),slug=`tenant-${id.slice(0,8)}`):string {
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Tenant','active',?,?)").run(id,slug,NOW,NOW);return id;
}

test('single-tier prices keep requests below vendor long-context billing thresholds',()=>{
  const database=routingDatabase();
  const rows=database.prepare<[],{provider_key:string;model_key:string;context_window:number;max_output_tokens:number}>(`SELECT provider_key,model_key,context_window,max_output_tokens
    FROM platform_model_versions
    WHERE authoritative=1 AND (provider_key IN ('openai','xai') OR (provider_key='google' AND model_key='gemini-3.1-pro-preview'))`).all();
  assert.ok(rows.length>0);
  for(const row of rows){
    const inputCeiling=row.context_window-row.max_output_tokens;
    const shortTierCeiling=row.provider_key==='openai'?272_000:200_000;
    assert.ok(inputCeiling<shortTierCeiling,`${row.provider_key}/${row.model_key} can cross its verified price tier`);
  }
  database.close();
});

test('new governance foreign keys reject cross-tenant references',()=>{
  const database=routingDatabase(),tenantA=tenant(database),tenantB=tenant(database),userA=randomUUID(),userB=randomUUID();
  const user=database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?)");
  user.run(userA,tenantA,'a@test.invalid',NOW,NOW);user.run(userB,tenantB,'b@test.invalid',NOW,NOW);
  const route=database.prepare(`INSERT INTO routing_decisions(id,tenant_id,idempotency_key,run_id,user_id,mode,requested_effort,status,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,'auto','fast','planned',?,?)`);
  assert.throws(()=>route.run(randomUUID(),tenantA,'cross-user','cross-user',userB,NOW,NOW),/FOREIGN KEY/);
  const routingId=randomUUID();route.run(routingId,tenantA,'good','good',userA,NOW,NOW);
  assert.throws(()=>database.prepare(`INSERT INTO usage_records(id,tenant_id,provider_key,model_key,input_tokens,output_tokens,cost_microusd,started_at,status,routing_decision_id)
    VALUES(?,?,'openai','x',0,0,0,?,'success',?)`).run(randomUUID(),tenantB,NOW,routingId),/another tenant/);
  database.close();
});

test('multi-model completed workflows alone carry a completion time',()=>{
  const database=routingDatabase(),tenantId=tenant(database),userId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?)").run(userId,tenantId,'workflow@test.invalid',NOW,NOW);
  const routingId=randomUUID();
  database.prepare(`INSERT INTO routing_decisions(id,tenant_id,idempotency_key,run_id,user_id,mode,requested_effort,status,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,'multi_model','fast','selected',?,?)`).run(routingId,tenantId,'workflow','workflow',userId,NOW,NOW);
  const insert=database.prepare(`INSERT INTO multi_model_workflows(id,tenant_id,routing_decision_id,run_id,user_id,status,created_at_ms,updated_at_ms,completed_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run(randomUUID(),tenantId,routingId,'failed',userId,'failed',NOW,NOW,null);
  assert.throws(()=>insert.run(randomUUID(),tenantId,routingId,'failed-time',userId,'failed',NOW,NOW,NOW),/CHECK constraint/);
  assert.throws(()=>insert.run(randomUUID(),tenantId,routingId,'missing-time',userId,'completed',NOW,NOW,null),/CHECK constraint/);
  assert.throws(()=>insert.run(randomUUID(),tenantId,routingId,'running-time',userId,'running',NOW,NOW,NOW),/CHECK constraint/);
  database.close();
});

function candidate(overrides:Partial<RoutingCandidate>={}):RoutingCandidate {
  return {tenantModelId:'openai-standard',platformModelVersionId:'version-openai-standard',provider:'openai',providerModel:'standard',displayName:'Standard',capabilities:['text','reasoning'],
    speedClass:'balanced',qualityTier:2,multiModelEligible:false,vendorJurisdiction:'us',processingRegion:'unknown',preferenceWeight:0,
    enabled:true,providerConfigured:true,credentialSource:'platform',estimatedProviderCostMicrousd:50,transport:'api',...overrides};
}

const routeCandidates:RoutingCandidate[]=[
  candidate({tenantModelId:'openai-deep',platformModelVersionId:'v-deep',providerModel:'deep',displayName:'Deep',speedClass:'slow',qualityTier:3,estimatedProviderCostMicrousd:100}),
  candidate(),
  candidate({tenantModelId:'openai-fast',platformModelVersionId:'v-fast',providerModel:'fast',displayName:'Fast',speedClass:'fast',qualityTier:1,multiModelEligible:true,estimatedProviderCostMicrousd:10}),
  candidate({tenantModelId:'anthropic-fast',platformModelVersionId:'v-anthropic',provider:'anthropic',providerModel:'fast',displayName:'Fast B',speedClass:'fast',qualityTier:1,multiModelEligible:true,estimatedProviderCostMicrousd:8}),
  candidate({tenantModelId:'google-fast',platformModelVersionId:'v-google',provider:'google',providerModel:'fast',displayName:'Fast G',speedClass:'fast',qualityTier:1,multiModelEligible:true,estimatedProviderCostMicrousd:9}),
];

test('auto and explicit single routes select deterministically',()=>{
  const deep=selectSingleRoute({mode:'auto',effort:'deep'},routeCandidates);assert.equal(deep.baseline.tenantModelId,'openai-deep');assert.equal(deep.selected.tenantModelId,'openai-deep');assert.equal(deep.reasoningEffort,'high');
  const explicit=selectSingleRoute({mode:'single',effort:'deep',preferredTenantModelId:'openai-deep'},routeCandidates);assert.equal(explicit.baseline.tenantModelId,'openai-deep');assert.equal(explicit.selected.provider,'openai');
  const standard=selectSingleRoute({mode:'auto',effort:'standard'},routeCandidates);assert.equal(standard.selected.tenantModelId,'openai-standard');
});

test('an expensive model is never downgraded to a cheaper one, whatever the run would cost',()=>{
  // Provider costs never silently substitute a cheaper model; configured budgets remain the cap.
  const costly=candidate({tenantModelId:'openai-deep',platformModelVersionId:'v-deep',providerModel:'deep',displayName:'Deep',speedClass:'slow',qualityTier:3,estimatedProviderCostMicrousd:5_000_000});
  const selection=selectSingleRoute({mode:'auto',effort:'deep'},[costly,...routeCandidates.slice(1)]);
  assert.equal(selection.selected.tenantModelId,'openai-deep');
  assert.equal(selection.selected,selection.baseline);
  assert.equal(selection.selectedProviderCostMicrousd,5_000_000);
  assert.equal(selection.baselineCostMicrousd,selection.selectedProviderCostMicrousd);
  assert.ok(!selection.reasons.some(reason=>reason.startsWith('allowance:')),selection.reasons.join(','));
  const explicit=selectSingleRoute({mode:'single',effort:'deep',preferredTenantModelId:'openai-deep'},[costly,...routeCandidates.slice(1)]);
  assert.equal(explicit.selected.tenantModelId,'openai-deep');
});

test('preference weight outranks cost between equal-quality models',()=>{
  const cheap=candidate({tenantModelId:'cheap',estimatedProviderCostMicrousd:1,preferenceWeight:0});
  const preferred=candidate({tenantModelId:'preferred',providerModel:'preferred',estimatedProviderCostMicrousd:10_000,preferenceWeight:5});
  assert.equal(selectSingleRoute({mode:'single',effort:'standard'},[cheap,preferred]).selected.tenantModelId,'preferred');
});

test('auto routing profiles the task locally while explicit choices remain authoritative',()=>{
  const candidates:RoutingCandidate[]=[
    candidate({tenantModelId:'openai-profile',provider:'openai',providerModel:'openai-profile',estimatedProviderCostMicrousd:90}),
    candidate({tenantModelId:'anthropic-profile',platformModelVersionId:'v-anthropic-profile',provider:'anthropic',providerModel:'anthropic-profile',estimatedProviderCostMicrousd:10}),
    candidate({tenantModelId:'google-profile',platformModelVersionId:'v-google-profile',provider:'google',providerModel:'google-profile',estimatedProviderCostMicrousd:20}),
    candidate({tenantModelId:'xai-profile',platformModelVersionId:'v-xai-profile',provider:'xai',providerModel:'xai-profile',estimatedProviderCostMicrousd:30}),
  ];
  const choose=(taskText:string,stableRoutingKey='stable')=>selectSingleRoute({mode:'auto',effort:'standard',taskText,stableRoutingKey},candidates).selected.provider;
  assert.equal(choose('Debug this TypeScript stack trace and fix the unit test'),'openai');
  assert.equal(choose('Rewrite this email with a concise, professional tone'),'anthropic');
  assert.equal(choose('Review the attached contract document and report'),'google');
  assert.equal(choose('Summarize the latest trending news on social media'),'xai');
  assert.equal(selectSingleRoute({mode:'single',effort:'standard',preferredProvider:'anthropic',taskText:'debug this code'},candidates).selected.provider,'anthropic');
  assert.equal(selectSingleRoute({mode:'single',effort:'standard',preferredTenantModelId:'xai-profile',taskText:'debug this code'},candidates).selected.provider,'xai');
});

test('general auto routing is stable per conversation and distributes across eligible families',()=>{
  const candidates:RoutingCandidate[]=[
    candidate({tenantModelId:'openai-profile',provider:'openai',providerModel:'openai-profile'}),
    candidate({tenantModelId:'anthropic-profile',platformModelVersionId:'v-anthropic-profile',provider:'anthropic',providerModel:'anthropic-profile'}),
    candidate({tenantModelId:'google-profile',platformModelVersionId:'v-google-profile',provider:'google',providerModel:'google-profile'}),
    candidate({tenantModelId:'xai-profile',platformModelVersionId:'v-xai-profile',provider:'xai',providerModel:'xai-profile'}),
  ];
  const choose=(key:string)=>selectSingleRoute({mode:'auto',effort:'standard',taskText:'Help me think through this question',stableRoutingKey:key},candidates).selected.provider;
  assert.equal(choose('tenant:user:conversation-7'),choose('tenant:user:conversation-7'));
  assert.deepEqual(new Set(Array.from({length:64},(_,index)=>choose(`tenant:user:conversation-${index}`))),new Set(['openai','anthropic','google','xai']));
});

test('pinning each provider routes only to that provider and exact models never cross provider boundaries',()=>{
  const providerCandidates=(['openai','anthropic','google','xai'] as const).map(provider=>candidate({tenantModelId:`${provider}-deep`,platformModelVersionId:`v-${provider}-deep`,provider,providerModel:'deep',displayName:`${provider} deep`,qualityTier:3}));
  for(const provider of ['openai','anthropic','google','xai'] as const){
    const selection=selectSingleRoute({mode:'single',effort:'deep',preferredProvider:provider},providerCandidates);
    assert.equal(selection.baseline.provider,provider);assert.equal(selection.selected.provider,provider);
  }
  const model=selectSingleRoute({mode:'single',effort:'deep',preferredTenantModelId:'openai-deep'},providerCandidates);
  assert.equal(model.selected.tenantModelId,'openai-deep');
});

test('jurisdiction and processing filters apply only when requested',()=>{
  const unconstrained=selectSingleRoute({mode:'auto',effort:'fast'},routeCandidates);assert.equal(unconstrained.selected.processingRegion,'unknown');assert.ok(unconstrained.reasons.includes('vendor:any'));assert.ok(unconstrained.reasons.includes('processing:any'));
  assert.throws(()=>selectSingleRoute({mode:'auto',effort:'fast',processingRegion:'us'},routeCandidates),(error:unknown)=>error instanceof GovernanceError&&error.code==='no_models_available');
  const unrestricted=[candidate({tenantModelId:'unknown-vendor',vendorJurisdiction:'unknown'})];
  assert.equal(selectSingleRoute({mode:'auto',effort:'fast'},unrestricted).selected.tenantModelId,'unknown-vendor');
  assert.throws(()=>selectSingleRoute({mode:'auto',effort:'fast',vendorJurisdiction:'us'},unrestricted),(error:unknown)=>error instanceof GovernanceError&&error.code==='no_models_available');
  const explicit=selectSingleRoute({mode:'auto',effort:'fast',vendorJurisdiction:'us'},routeCandidates);assert.ok(explicit.reasons.includes('vendor:us'));assert.ok(explicit.selected.vendorJurisdiction==='us');
});

test('fast multi-model selects exactly five rounds across at least two families',()=>{
  const plan=selectFastMultiModelPlan(routeCandidates);assert.deepEqual(plan.executions.map(item=>[item.ordinal,item.role]),[[1,'draft'],[2,'critique'],[3,'alternative'],[4,'refine'],[5,'consolidate']]);
  assert.equal(plan.executions.length,5);assert.ok(new Set(plan.executions.map(item=>item.candidate.provider)).size>=2);assert.ok(plan.executions.every(item=>item.candidate.qualityTier===1&&item.candidate.speedClass==='fast'));
  assert.throws(()=>selectFastMultiModelPlan(routeCandidates.filter(item=>item.provider==='openai')),/at least two/);
});

test('fast multi-model accepts two non-US-vendor provider families',()=>{
  const plan=selectFastMultiModelPlan([
    candidate({tenantModelId:'openrouter-fast',provider:'openrouter',providerModel:'router',vendorJurisdiction:'unknown',speedClass:'fast',qualityTier:1,multiModelEligible:true}),
    candidate({tenantModelId:'venice-fast',provider:'venice',providerModel:'venice',vendorJurisdiction:'non_us',speedClass:'fast',qualityTier:1,multiModelEligible:true}),
  ]);
  assert.deepEqual(plan.providerFamilies,['openrouter','venice']);
});

test('candidate loader honors group grants and requires an encrypted tenant credential',()=>{
  const database=routingDatabase(),tenantId=tenant(database),userId=randomUUID(),groupId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?)").run(userId,tenantId,'user@test.invalid',NOW,NOW);
  database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Everyone',?,?)").run(groupId,tenantId,NOW,NOW);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,created_at) VALUES(?,?,?,?)").run(tenantId,groupId,userId,NOW);
  const add=(provider:'openai'|'anthropic',model:string,source:'environment'|'encrypted')=>{
    const version=database.prepare<[string,string],{id:string}>('SELECT id FROM platform_model_versions WHERE provider_key=? AND model_key=?').get(provider,model)!.id;
    const modelId=randomUUID(),configId=randomUUID();
    database.prepare(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at,platform_model_version_id)
      VALUES(?,?,?,?,?,4096,128,1,1,?,?,?)`).run(modelId,tenantId,provider,model,model,NOW,NOW,version);
    database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at)
      VALUES(?,?,?,1,?,?,?,?,?)`).run(configId,tenantId,provider,source,source==='encrypted'?'sealed':null,source==='encrypted'?1:null,NOW,NOW);
    database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id) VALUES(?,?)').run(groupId,modelId);database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id) VALUES(?,?)').run(groupId,configId);
  };
  add('openai','gpt-5.6-luna','environment');add('anthropic','claude-haiku-4-5-20251001','encrypted');
  const loaded=loadRoutingCandidates(database,{tenantId,userId,inputTokens:100,outputTokens:20,now:NOW});
  assert.equal(loaded.length,2);assert.equal(loaded.find(item=>item.provider==='openai')!.providerConfigured,false);assert.equal(loaded.find(item=>item.provider==='anthropic')!.credentialSource,'byok');assert.equal(loaded.find(item=>item.provider==='anthropic')!.providerConfigured,true);
  database.close();
});

test('tenant catalogue remains routable after an obsolete platform price expires',()=>{
  const database=routingDatabase(),tenantId=tenant(database),userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),configId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?)").run(userId,tenantId,'sonnet@test.invalid',NOW,NOW);
  database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Everyone',?,?)").run(groupId,tenantId,NOW,NOW);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,created_at) VALUES(?,?,?,?)").run(tenantId,groupId,userId,NOW);
  const version=database.prepare<[],{id:string;effective_from:number;effective_to:number|null}>("SELECT id,effective_from,effective_to FROM platform_model_versions WHERE provider_key='anthropic' AND model_key='claude-sonnet-5' AND authoritative=1").get()!,expiry=version.effective_from+1;
  database.prepare('UPDATE platform_model_versions SET effective_to=? WHERE id=?').run(expiry,version.id);
  database.prepare(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at,platform_model_version_id)
    VALUES(?,?,'anthropic','claude-sonnet-5','Claude Sonnet 5',200000,8192,2000000,10000000,?,?,?)`).run(modelId,tenantId,NOW,NOW,version.id);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'anthropic',1,'encrypted','fixture',1,?,?)").run(configId,tenantId,NOW,NOW);
  database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id) VALUES(?,?)').run(groupId,modelId);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id) VALUES(?,?)').run(groupId,configId);
  const load=(now:number)=>loadRoutingCandidates(database,{tenantId,userId,inputTokens:100,outputTokens:20,now});
  assert.equal(selectSingleRoute({mode:'auto',effort:'standard'},load(expiry-1)).selected.tenantModelId,modelId);
  assert.equal(selectSingleRoute({mode:'auto',effort:'standard'},load(expiry)).selected.tenantModelId,modelId);
  database.close();
});


test('message routing rejects invalid constraints', () => {
  const unconstrained = selectSingleRoute({ mode: 'auto', effort: 'fast' }, routeCandidates);
  assert.ok(unconstrained.selected);

  assert.throws(() => selectSingleRoute({ mode: 'auto', effort: 'fast', processingRegion: 'us' }, routeCandidates),
    (error) => error instanceof GovernanceError && error.code === 'no_models_available');
});
