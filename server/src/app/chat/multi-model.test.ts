import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GateVerdict } from '../../lib/gate/index.js';
import { runMultiModel, type FastModelTarget, type MultiModelExecution, type MultiModelExecutionResult } from './multi-model.js';
import { enforceMultiModelApprovalBoundary } from './service.js';

const targets:FastModelTarget[]=[
  {catalogId:'openai-fast',provider:'openai',modelKey:'fast-a',displayName:'Fast A'},
  {catalogId:'anthropic-fast',provider:'anthropic',modelKey:'fast-b',displayName:'Fast B'},
  {catalogId:'google-fast',provider:'google',modelKey:'fast-c',displayName:'Fast C'},
];

test('multi-model runs exactly five stable fast executions and returns only the consolidation',async()=>{
  const calls:MultiModelExecution[]=[],gated:string[]=[];
  const result=await runMultiModel({workflowId:'workflow-1',originalPrompt:'Choose an approach',targets,signal:new AbortController().signal,port:{
    async execute(input){calls.push(input);return{text:`raw-${input.step}`,inputTokens:10,outputTokens:2,providerCostMicrousd:101,providerRequestId:`request-${input.ordinal}`}},
    async authorizeOutput(input){gated.push(input.text);return `safe-${input.step}`},
  }});
  assert.deepEqual(calls.map(call=>[call.ordinal,call.step,call.idempotencyKey,call.target.provider]),[
    [1,'draft','multi:workflow-1:1','openai'],[2,'critique','multi:workflow-1:2','anthropic'],[3,'alternative','multi:workflow-1:3','google'],[4,'refine','multi:workflow-1:4','openai'],[5,'consolidate','multi:workflow-1:5','anthropic'],
  ]);
  assert.deepEqual(gated,['raw-draft','raw-critique','raw-alternative','raw-refine','raw-consolidate']);
  assert.equal(result.text,'safe-consolidate');assert.equal(result.inputTokens,50);assert.equal(result.outputTokens,10);assert.equal(result.providerCostMicrousd,505);
  assert.match(calls[1]!.prompt,/safe-draft/);assert.doesNotMatch(calls[1]!.prompt,/raw-draft/);
  assert.match(calls[4]!.prompt,/Return the final answer only/);
});

test('multi-model requires distinct provider families and gates every intermediate result',async()=>{
  await assert.rejects(runMultiModel({workflowId:'w',originalPrompt:'x',targets:[targets[0]!,{...targets[0]!,catalogId:'openai-2'}],signal:new AbortController().signal,port:{execute:async()=>assert.fail(),authorizeOutput:async()=>assert.fail()}}),/two provider families/);
  let calls=0;
  await assert.rejects(runMultiModel({workflowId:'blocked',originalPrompt:'x',targets,signal:new AbortController().signal,port:{
    async execute(input):Promise<MultiModelExecutionResult>{calls++;return{text:input.step,inputTokens:1,outputTokens:1,providerCostMicrousd:1,providerRequestId:null}},
    async authorizeOutput(input){if(input.ordinal===2)throw new Error('blocked by policy');return input.text},
  }}),/blocked by policy/);
  assert.equal(calls,2,'a blocked intermediate result must stop later provider calls');
});

test('multi-model uses stable execution keys so a durable port can replay after restart',async()=>{
  const completed=new Map<string,MultiModelExecutionResult>(),dispatches:string[]=[];
  const port={
    async execute(input:MultiModelExecution){const replay=completed.get(input.idempotencyKey);if(replay)return replay;dispatches.push(input.idempotencyKey);const result={text:`answer-${input.ordinal}`,inputTokens:1,outputTokens:1,providerCostMicrousd:1,providerRequestId:null};completed.set(input.idempotencyKey,result);return result},
    async authorizeOutput(input:{text:string}){return input.text},
  };
  const options={workflowId:'resume',originalPrompt:'x',targets,signal:new AbortController().signal,port};
  await runMultiModel(options);await runMultiModel(options);
  assert.equal(dispatches.length,5);assert.equal(new Set(dispatches).size,5);
});

test('multi-model fails closed before queueing a one-call approval release',()=>{
  const approval:GateVerdict={evaluationId:'evaluation',pass:'preflight',action:'require_approval',disposition:'pending_approval',matches:[],providerParts:null,
    displayParts:null,redactions:[],masks:[],warningToken:null,approvalRequestId:'approval',policySnapshotId:'snapshot',policyFingerprint:'fingerprint',degraded:false,
    failureCodes:[],timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};
  const blocked=enforceMultiModelApprovalBoundary('multi_model',approval);
  assert.equal(blocked.action,'block');assert.equal(blocked.disposition,'blocked');assert.equal(blocked.approvalRequestId,null);
  assert.deepEqual(blocked.failureCodes,['multi_model_approval_requires_single_route']);
  assert.equal(enforceMultiModelApprovalBoundary('single',approval),approval);
});
