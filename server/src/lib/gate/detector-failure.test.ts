import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DefaultGateEngine } from './engine.js';
import { resolvePolicy } from './resolve-policy.js';
import type { Detector, GateContext, GateFailureMode, GatePass, ResolvedRule } from './types.js';

const tenantId=randomUUID(),userId=randomUUID();
function rule(overrides:Partial<ResolvedRule>={}):ResolvedRule {
  return {id:randomUUID(),revision:1,name:'Secret rule',detectorKind:'secret',action:'block',
    passMask:'both',priority:1000,scopeType:'org',scopeId:tenantId,config:{},failureMode:'closed',
    sourceOrder:0,...overrides};
}
function context(rules:readonly ResolvedRule[],pass:GatePass='preflight'):GateContext {
  const subject={tenantId,userId,groupIds:[],roles:['member'] as const},nowMs=1000;
  return {evaluationId:randomUUID(),requestId:randomUUID(),pass,subject,conversationId:null,
    messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs,
    parts:[{id:'part',source:pass==='preflight'?'user_prompt':'provider_response',text:'restricted',
      mimeType:'text/plain',fileId:null,provenance:{}}],
    policySnapshot:resolvePolicy({tenantId,modelId:'test',subject,pass,policyVersion:1,rules,nowMs}),
    abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};
}
function failingDetector(failureMode:GateFailureMode,timeout:boolean):Detector {
  return {id:'failing-secret',kind:'secret',stage:20,supportedPasses:new Set(['preflight','postflight']),
    failureMode,timeoutMs:5,async detect(){
      if(timeout)return new Promise<never>(()=>{});
      throw new Error('forced detector failure');
    }};
}

test('detector failure preserves every applicable rule and the configured failure mode',async()=>{
  const first=rule({priority:2000}),second=rule(),unrelated=rule({detectorKind:'keyword'});
  for(const mode of ['closed','escalate','open'] as const)for(const timeout of [false,true]){
    const verdict=await new DefaultGateEngine({detectors:[failingDetector(mode,timeout)]})
      .evaluate(context([first,second,unrelated]));
    assert.equal(verdict.degraded,true);
    assert.deepEqual(verdict.matches.map(match=>match.ruleId).sort(),
      mode==='open'?[]:[first.id,second.id].sort(),`${mode}/${timeout}: every affected rule needs failure evidence`);
    assert.equal(verdict.action,mode==='closed'?'block':mode==='escalate'?'flag':'allow');
    for(const match of verdict.matches)assert.equal(match.category,timeout?'detector_timeout':'detector_failed');
  }
});
