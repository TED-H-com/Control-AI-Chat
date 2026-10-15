import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DefaultGateEngine, assertProviderTransportAuthorized } from './engine.js';
import { KeywordDetector } from './detectors/keyword.js';
import { SecretDetector } from './detectors/secrets.js';
import { resolvePolicy } from './resolve-policy.js';
import { StatelessGateVault } from './vault.js';
import type { GateAction, GateContext, GatePass, ResolvedRule } from './types.js';

const tenantId=randomUUID(),userId=randomUUID();
const text='Restricted material from Acme: AKIA1234567890ABCDEF';
function rule(action:GateAction,term:string,overrides:Partial<ResolvedRule>={}):ResolvedRule {
  return {id:randomUUID(),revision:1,name:term,detectorKind:'keyword',action,passMask:'both',
    priority:100,scopeType:'org',scopeId:tenantId,sourceOrder:0,failureMode:'closed',
    config:{terms:[term],regexes:[],wholeWord:true,maxMatches:20,maskReplacement:'a company'},...overrides};
}
function context(rules:readonly ResolvedRule[],pass:GatePass):GateContext {
  const subject={tenantId,userId,groupIds:[],roles:['member'] as const},nowMs=Date.now();
  return {evaluationId:randomUUID(),requestId:randomUUID(),pass,subject,conversationId:null,
    messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs,
    parts:[{id:'part',source:pass==='preflight'?'user_prompt':'provider_response',text,
      mimeType:'text/plain',fileId:null,provenance:{}}],
    policySnapshot:resolvePolicy({tenantId,modelId:'test',subject,pass,policyVersion:1,rules,nowMs}),
    abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};
}
function engine(transform:'mask'|'redact') {
  return new DefaultGateEngine({detectors:[new KeywordDetector(),new SecretDetector()],
    ...(transform==='redact'?{vault:new StatelessGateVault()}:{})});
}

for(const transform of ['mask','redact'] as const)test(`${transform} content is returned only for an authorized destination`,async()=>{
  const gate=engine(transform),overlay=rule(transform,'Acme');
  for(const pass of ['preflight','postflight'] as const){
    const allowed=await gate.evaluate(context([overlay],pass));
    assert.equal(allowed.action,transform);
    assert.equal(allowed.disposition,pass==='preflight'?'allow_provider_call':'release_to_user');
    const parts=pass==='preflight'?allowed.providerParts:allowed.displayParts;
    assert.ok(parts?.length,'an allowed transform must still return content');
    assert.doesNotMatch(parts[0]!.text,/Acme/);
    assert.match(parts[0]!.text,transform==='mask'?/a company/:/⟦REDACTED:POLICY_TERM:/);
    assert.equal(pass==='preflight'?allowed.displayParts:allowed.providerParts,null);
    for(const action of ['block','require_approval'] as const){
      const restriction=rule(action,'Restricted');
      const withheld=await gate.evaluate(context([overlay,restriction],pass));
      assert.deepEqual(new Set(withheld.matches.map(match=>match.ruleId)),new Set([overlay.id,restriction.id]));
      assert.equal(withheld.action,action);
      assert.equal(withheld.disposition,pass==='preflight'&&action==='require_approval'?'pending_approval':'blocked');
      assert.equal(withheld.masks.length+withheld.redactions.length,1,'the transform must actually run');
      assert.equal(withheld.providerParts,null);
      assert.equal(withheld.displayParts,null,`${pass}/${action}/${transform}: withheld content must not become display content`);
      assert.throws(()=>assertProviderTransportAuthorized(withheld),/gate_provider_transport_not_authorized/u);
    }
  }
});
