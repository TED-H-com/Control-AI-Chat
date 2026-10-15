import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import { provisionTenant } from '../../lib/identity/tenant-provision.js';
import { resolvePolicy } from '../../lib/gate/resolve-policy.js';
import { DefaultGateEngine, deterministicDetectors } from '../../lib/gate/index.js';
import type { ChatProvider, StreamEvent } from '../../lib/providers/types.js';
import type { GateVerdict } from '../../lib/gate/types.js';
import { DraftError, draftAssistantFromUrl } from './draft-from-url.js';

const NOW=1_800_000_000_000;
function provider(output:string):ChatProvider{return{id:'openai',protocols:['openai_responses'],configured:true,supports:()=>true,health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),async *stream(request){yield{type:'start',requestId:request.context.requestId,model:request.model,createdAt:NOW};yield{type:'text_delta',index:0,delta:output};yield{type:'finish',reason:'stop'} as StreamEvent;}};}
function fixture(output:string,gate:(text:string)=>{disposition:GateVerdict['disposition'];text?:string}){
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db);const tenantId=randomUUID(),userId=randomUUID();
  const provisioned=provisionTenant(db,{tenantId,ownerUserId:userId,slug:`draft-${tenantId.slice(0,8)}`,tenantName:'Draft',ownerEmail:`owner-${tenantId}@draft.example`,ownerDisplayName:'Owner',passwordHash:'hash',now:NOW});
  const modelCatalogId=provisioned.modelIds[0]!,fake=provider(output),subject={tenantId,userId,groupIds:[],roles:['owner'] as const};
  db.prepare("UPDATE provider_config SET enabled=1,credential_source='encrypted',credential_ciphertext='fixture',key_version=1 WHERE tenant_id=? AND provider_key=(SELECT provider_key FROM model_catalog WHERE id=?)").run(tenantId,modelCatalogId);
  const deps={db,now:()=>NOW,resolvePolicy,fetchText:async()=>({finalUrl:'https://example.test',contentType:'text/html',text:'Public product reference'}),providers:{get:()=>fake},tenantProviders:{resolve:()=>({provider:fake,credentialSource:'byok' as const})},gate:{async evaluate(context:any){const result=gate(context.parts[0].text);return{disposition:result.disposition,providerParts:result.text===undefined?null:[{...context.parts[0],text:result.text}]} as GateVerdict;}}};
  return{db,deps,input:{url:'https://example.test',modelCatalogId,subject,requestId:randomUUID()}};
}

test('returns only the gate-authorized drafted system prompt',async()=>{const f=fixture('{"name":"Helper","description":"Useful","systemPrompt":"Contact jane@example.com"}',()=>({disposition:'allow_provider_call',text:'Contact ⟦REDACTED:EMAIL:redacted⟧'}));try{assert.deepEqual(await draftAssistantFromUrl(f.deps,f.input),{name:'Helper',description:'Useful',systemPrompt:'Contact ⟦REDACTED:EMAIL:redacted⟧'});}finally{f.db.close();}});
test('blocked output never returns raw model text',async()=>{const f=fixture('{"name":"Helper","description":"","systemPrompt":"forbidden"}',()=>({disposition:'blocked'}));try{await assert.rejects(draftAssistantFromUrl(f.deps,f.input),error=>error instanceof DraftError&&error.code==='DRAFT_BLOCKED');}finally{f.db.close();}});
test('non-JSON provider output falls back to a still-gated system prompt',async()=>{const f=fixture('Plain provider prose',text=>({disposition:'allow_provider_call',text:`authorized:${text}`}));try{assert.equal((await draftAssistantFromUrl(f.deps,f.input)).systemPrompt,'authorized:Plain provider prose');}finally{f.db.close();}});
test('empty source fails before generation',async()=>{const f=fixture('unused',text=>({disposition:'allow_provider_call',text}));f.deps.fetchText=async()=>({finalUrl:'x',contentType:'text/plain',text:'  '});try{await assert.rejects(draftAssistantFromUrl(f.deps,f.input),error=>error instanceof DraftError&&error.code==='EMPTY_SOURCE');}finally{f.db.close();}});
test('a model outside the effective set is rejected',async()=>{const f=fixture('unused',text=>({disposition:'allow_provider_call',text}));try{await assert.rejects(draftAssistantFromUrl(f.deps,{...f.input,modelCatalogId:randomUUID()}),error=>error instanceof DraftError&&error.code==='MODEL_NOT_ALLOWED');}finally{f.db.close();}});

test('real gate redacts a group-scoped term from the drafted system prompt',async()=>{
  const f=fixture('{"name":"Helper","description":"Useful","systemPrompt":"Protect Project Halcyon details"}',text=>({disposition:'allow_provider_call',text}));
  const tenantId=f.input.subject.tenantId,userId=f.input.subject.userId,groupId=randomUUID(),policyId=randomUUID(),detectorId=randomUUID();
  f.db.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Controlled drafts',?,?)").run(groupId,tenantId,NOW,NOW);
  f.db.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,userId,NOW);
  f.db.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Draft policy',?,?)").run(policyId,tenantId,NOW,NOW);
  f.db.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detectorId,tenantId,`draft-${detectorId}`,'a'.repeat(64),NOW,NOW);
  f.db.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'outbound','mask','high',?,1,1000,?,?)").run(randomUUID(),tenantId,policyId,detectorId,groupId,JSON.stringify({terms:['Project Halcyon'],regexes:[],wholeWord:true,maxMatches:20,maskReplacement:'[REDACTED]'}),NOW,NOW);
  f.deps.gate=new DefaultGateEngine({detectors:deterministicDetectors()});
  try{assert.equal((await draftAssistantFromUrl(f.deps,f.input)).systemPrompt,'Protect [REDACTED] details');}finally{f.db.close();}
});
