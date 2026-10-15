import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminInstantIso,budgetWire,detectorWire,groupWire,modelWire,providerWire } from './wire.js';

const AT=1_700_000_000_000;
test('admin wire DTOs expose stable camelCase fields and ISO dates',()=>{
  assert.deepEqual(groupWire({id:'g',name:'Engineering',description:null,is_system:1,member_count:4,created_at:AT,updated_at:AT}),{id:'g',name:'Engineering',description:null,memberCount:4,system:true,version:AT,createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT).toISOString()});
  assert.deepEqual(modelWire({id:'m',display_name:'Fast',provider_key:'openai',model_key:'fast',enabled:1,is_default:0,capabilities_json:'["text"]',context_window:100,max_output_tokens:20,input_microusd_per_million:1,output_microusd_per_million:2,cached_input_microusd_per_million:0,speed_class:'fast',quality_tier:1,multi_model_eligible:1,vendor_jurisdiction:'us',processing_region:'global',preference_weight:4,enabled_group_count:3,created_at:AT,updated_at:AT}),{id:'m',displayName:'Fast',provider:'openai',providerModelId:'fast',transport:'api',systemPromptEligible:true,enabled:true,isTenantDefault:false,capabilities:['text'],contextWindowTokens:100,maxOutputTokens:20,inputPriceMicroUsdPerMillion:1,outputPriceMicroUsdPerMillion:2,cachedInputPriceMicroUsdPerMillion:0,speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'us',processingRegion:'global',preferenceWeight:4,enabledGroupCount:3,version:AT,createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT).toISOString()});
  assert.equal(budgetWire({id:'b',scope_type:'tenant',scope_id:null,period:'monthly',metric:'usd',soft_limit:null,hard_limit:10,timezone:'UTC',enabled:1,created_at:AT,updated_at:AT}).hardLimit,10);
  assert.equal(detectorWire({id:'d',key:'secret',kind:'secret',enabled:1,builtin:1,config_json:'{}',created_at:AT,updated_at:AT}).detectorKind,'secret');
});

test('admin wire dates normalize ISO strings plus epoch seconds and milliseconds without throwing',()=>{
  assert.equal(adminInstantIso(1_700_000_000),new Date(1_700_000_000_000).toISOString());
  assert.equal(adminInstantIso(1_700_000_000_000),new Date(1_700_000_000_000).toISOString());
  assert.equal(adminInstantIso('1700000000'),new Date(1_700_000_000_000).toISOString());
  assert.equal(adminInstantIso('2026-08-10T12:34:56.000Z'),'2026-08-10T12:34:56.000Z');
  assert.equal(adminInstantIso('not-a-date'),null);
  assert.equal(adminInstantIso(Number.POSITIVE_INFINITY),null);
});

test('provider rows aggregate group access without exposing stored credentials',()=>{
  const items=providerWire([
    {provider_key:'openai',enabled:0,credential_source:'encrypted',credential_configured:0,base_url:null,updated_at:AT,group_id:'group-engineering',group_name:'Engineering',group_enabled:1,group_version:3},
    {provider_key:'openai',enabled:0,credential_source:'encrypted',credential_configured:0,base_url:null,updated_at:AT,group_id:'group-sales',group_name:'Sales',group_enabled:0,group_version:2},
    {provider_key:'anthropic',enabled:1,credential_source:'encrypted',credential_configured:1,credential_masked_suffix:'secret',base_url:null,updated_at:AT,group_id:null,group_name:null,group_enabled:0,group_version:null,credential_ciphertext:'never-return-me'},
  ]);
  assert.deepEqual(items.map(item=>[item.provider,item.credentialSource,item.enabledGroups]),[['anthropic','byok',[]],['openai','unconfigured',['Engineering']]]);
  assert.deepEqual(items.map(item=>item.groupAccess),[[],[
    {groupId:'group-engineering',enabled:true,version:3},
    {groupId:'group-sales',enabled:false,version:2},
  ]]);
  assert.deepEqual(items.map(item=>item.maskedSuffix),['cret',null]);
  assert.doesNotMatch(JSON.stringify(items),/never-return-me/);
});
