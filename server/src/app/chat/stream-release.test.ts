import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { defaultPolicy } from '../../lib/gate/default-policy.js';
import { DefaultGateEngine, deterministicDetectors, resolvePolicy } from '../../lib/gate/index.js';
import type { GateContext, GateVerdict, GateVault, ResolvedRule } from '../../lib/gate/types.js';
import { planStreamRelease, POSTFLIGHT_STREAM_MAX_RETAINED_CODE_POINTS, StreamProtectionAccumulator } from './stream-release.js';

const tenant=randomUUID(),user=randomUUID(),now=Date.now();
const defaultPii=defaultPolicy.detectors.find(detector=>detector.key==='default-pii')!;
const defaultInboundRule:ResolvedRule={id:randomUUID(),revision:1,name:defaultPii.key,detectorKind:'pii',action:'redact',passMask:'postflight',priority:1000,scopeType:'org',scopeId:tenant,config:defaultPii.config,failureMode:'closed',sourceOrder:0};

const stableVault:GateVault={
  async redact(context,matches){
    const redactions:Array<GateVerdict['redactions'][number]>=[],masks:Array<GateVerdict['masks'][number]>=[];
    const parts=context.parts.map(part=>{const points=Array.from(part.text),selected=matches.filter(match=>match.partId===part.id&&match.span&&(match.action==='redact'||match.action==='mask')).sort((a,b)=>b.span!.start-a.span!.start);for(const match of selected){const span=match.span!;if(match.action==='redact'){const label=match.replacementLabel??'REDACTED',token=`⟦REDACTED:${label}⟧`;points.splice(span.start,span.end-span.start,token);redactions.push({token,label,partId:part.id,originalSpan:span,ruleIds:[match.ruleId]});}else{const rule=context.policySnapshot.rules.find(item=>item.id===match.ruleId),replacement=String(rule?.config.maskReplacement??'protected');points.splice(span.start,span.end-span.start,replacement);masks.push({label:match.replacementLabel??'MASKED',partId:part.id,originalSpan:span,replacement,ruleIds:[match.ruleId]});}}return{...part,text:points.join('')}});
    return{parts,redactions,masks};
  },
};

function context(text:string,rules:readonly ResolvedRule[]):GateContext {const subject={tenantId:tenant,userId:user,groupIds:[],roles:['member'] as const};return{evaluationId:randomUUID(),requestId:randomUUID(),pass:'postflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs:now,parts:[{id:'response',source:'provider_response',text,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:resolvePolicy({tenantId:tenant,modelId:'test',subject,pass:'postflight',policyVersion:1,rules,nowMs:now}),abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{direction:'inbound'}}}
function result(verdict:GateVerdict){return{decisionId:verdict.evaluationId,action:verdict.action,protectedItemCount:verdict.redactions.length+verdict.masks.length,effectiveText:verdict.displayParts?.[0]?.text??'',replacements:[...verdict.redactions.map(item=>({originalSpan:item.originalSpan,replacement:item.token})),...verdict.masks.map(item=>({originalSpan:item.originalSpan,replacement:item.replacement}))]}}
async function stream(text:string,engine:DefaultGateEngine,rules:readonly ResolvedRule[],chunkSize=7){let tail='',display='';const protection=new StreamProtectionAccumulator<ReturnType<typeof result>>(),notices:ReturnType<typeof result>[]=[];const points=Array.from(text);for(let offset=0;offset<points.length;offset+=chunkSize){tail+=points.slice(offset,offset+chunkSize).join('');const verdict=await engine.evaluate(context(tail,rules)),gate=result(verdict),release=planStreamRelease(tail,gate),notice=protection.observe(gate,release.protectedItemCount);if(notice)notices.push(notice);display+=release.displayText;tail=release.rawTail;}const verdict=await engine.evaluate(context(tail,rules)),gate=result(verdict),release=planStreamRelease(tail,gate,true),notice=protection.observe(gate,release.protectedItemCount);if(notice)notices.push(notice);return{display:display+release.displayText,count:protection.protectedItemCount,notices}}

test('raw-coordinate releases match a whole default-policy email evaluation in seven-character chunks',async()=>{
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:stableVault}),email='jane.long@corp.invalid',raw=`Contact ${email} now. ${'y'.repeat(2_500)}`,streamed=await stream(raw,engine,[defaultInboundRule]),whole=await engine.evaluate(context(raw,[defaultInboundRule])),expected=whole.displayParts?.[0]?.text??'';
  assert.equal(streamed.display,expected);assert.equal(streamed.count,1);assert.equal((streamed.display.match(/⟦REDACTED:EMAIL⟧/gu)??[]).length,1);for(const fragment of ['jane.long','corp.invalid','orp.invalid'])assert.doesNotMatch(streamed.display,new RegExp(fragment.replace('.','\\.')));
});

test('a short substitution never releases a fragment of its long original',async()=>{
  const original=`policy-${'Q'.repeat(495)}`,rule:ResolvedRule={id:randomUUID(),revision:1,name:'short substitute',detectorKind:'keyword',action:'mask',passMask:'postflight',priority:1100,scopeType:'org',scopeId:tenant,config:{maskReplacement:'[x]'},failureMode:'closed',sourceOrder:0},detector={id:'test.long-substitution',kind:'keyword' as const,stage:40,supportedPasses:new Set(['postflight'] as const),failureMode:'closed' as const,timeoutMs:100,async detect(input:GateContext){const at=input.parts[0]!.text.indexOf(original),matches=at<0?[]:[{matchId:randomUUID(),detectorId:this.id,detectorKind:this.kind,ruleId:rule.id,ruleRevision:1,partId:'response',category:'long-original',action:'mask' as const,confidence:'high' as const,span:{start:Array.from(input.parts[0]!.text.slice(0,at)).length,end:Array.from(input.parts[0]!.text.slice(0,at+original.length)).length},normalizedFingerprint:'long-original',safeExcerpt:'[POLICY_TERM]',replacementLabel:'POLICY_TERM',metadata:{}}];return{matches,elapsedUs:1,cacheStatus:'not_applicable' as const,degraded:false,diagnostics:[]}}},engine=new DefaultGateEngine({detectors:[detector],vault:stableVault}),raw=`Before ${original} after ${'z'.repeat(2_500)}`,streamed=await stream(raw,engine,[rule]);
  assert.equal(streamed.count,1);assert.match(streamed.display,/Before \[x\] after/);assert.doesNotMatch(streamed.display,/policy-|QQQQ/);
});

test('a raw cut inside a match backs up and later releases one whole token',async()=>{
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:stableVault}),email='inside.cut@corp.invalid',raw=`abc ${email} ${'x'.repeat(2_048+10-5-Array.from(email).length)}`,verdict=await engine.evaluate(context(raw,[defaultInboundRule])),first=planStreamRelease(raw,result(verdict));
  assert.equal(first.displayText,'abc ');assert.ok(first.rawTail.startsWith(email));assert.equal(first.protectedItemCount,0);
  const rescanned=await engine.evaluate(context(first.rawTail,[defaultInboundRule])),drained=planStreamRelease(first.rawTail,result(rescanned),true);assert.match(drained.displayText,/^⟦REDACTED:EMAIL⟧/u);assert.equal(drained.protectedItemCount,1);
});

test('reasoning and answer boundary drains redact independently on both sides',async()=>{
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:stableVault}),reasoning='Reason about first.person@corp.invalid',answer='Answer second.person@corp.invalid',left=await engine.evaluate(context(reasoning,[defaultInboundRule])),leftRelease=planStreamRelease(reasoning,result(left),true),right=await engine.evaluate(context(answer,[defaultInboundRule])),rightRelease=planStreamRelease(answer,result(right),true);
  assert.equal(leftRelease.protectedItemCount+rightRelease.protectedItemCount,2);assert.match(leftRelease.displayText,/Reason about ⟦REDACTED:EMAIL⟧/u);assert.match(rightRelease.displayText,/Answer ⟦REDACTED:EMAIL⟧/u);
});

test('three far-apart response emails are counted once across overlapping windows',async()=>{
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:stableVault}),raw=`a@corp.invalid ${'x'.repeat(2_100)} b@corp.invalid ${'y'.repeat(2_100)} c@corp.invalid ${'z'.repeat(2_100)}`,streamed=await stream(raw,engine,[defaultInboundRule]);
  assert.equal(streamed.count,3);assert.equal((streamed.display.match(/⟦REDACTED:EMAIL⟧/gu)??[]).length,3);assert.doesNotMatch(streamed.display,/[abc]@corp\.invalid/u);
});

test('one redaction in a long response produces bounded notices with a monotonic live count',async()=>{
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:stableVault}),streamed=await stream(`one@corp.invalid ${'x'.repeat(8_000)}`,engine,[defaultInboundRule]);
  assert.ok(streamed.notices.length<=2,`saw ${streamed.notices.length} notices`);assert.deepEqual(streamed.notices.map(notice=>notice.protectedItemCount),streamed.notices.length===1?[1]:[0,1]);assert.equal(streamed.count,1);
});

test('a changed display without replacement spans fails closed before an incremental release',()=>{
  const raw=`prefix alice@corp.invalid ${'x'.repeat(2_100)}`;
  assert.throws(()=>planStreamRelease(raw,{decisionId:'missing-spans',action:'redact',protectedItemCount:1,effectiveText:raw.replace('alice@corp.invalid','[EMAIL]')}),/display does not match replacement spans/);
});

test('a prefix-coincident changed display without spans fails closed before releasing the shared prefix',()=>{
  const raw=`0912345678${'x'.repeat(2_039)}`;
  assert.throws(()=>planStreamRelease(raw,{decisionId:'prefix-coincidence',action:'mask',protectedItemCount:1,effectiveText:`09XXXXXXXX${'x'.repeat(2_039)}`}),/display does not match replacement spans/);
});

test('an incremental release fails closed rather than cutting through an overlong growing match',()=>{
  const prefix='Contact ',secret=`a@b${'.cc'.repeat(Math.ceil((POSTFLIGHT_STREAM_MAX_RETAINED_CODE_POINTS+1)/3))}`,raw=prefix+secret;
  assert.throws(()=>planStreamRelease(raw,{decisionId:'growing-match',action:'redact',protectedItemCount:1,effectiveText:`${prefix}[EMAIL]`,replacements:[{originalSpan:{start:Array.from(prefix).length,end:Array.from(raw).length},replacement:'[EMAIL]'}]}),/retained tail exceeds safe limit/);
});

test('replacement text that disagrees with the gate display fails closed at drain',()=>{
  assert.throws(()=>planStreamRelease('secret tail',{decisionId:'wrong-replacement',action:'mask',protectedItemCount:1,effectiveText:'[safe] tail',replacements:[{originalSpan:{start:0,end:6},replacement:'[wrong]'}]},true),/display does not match replacement spans/);
});

test('overlapping replacement spans fail closed instead of being skipped',()=>{
  assert.throws(()=>planStreamRelease('overlap',{decisionId:'overlap',action:'redact',protectedItemCount:2,effectiveText:'[safe]',replacements:[{originalSpan:{start:0,end:4},replacement:'[a]'},{originalSpan:{start:3,end:7},replacement:'[b]'}]},true),/invalid replacement spans/);
});

test('planStreamRelease completes 50,000 tiny chunks without replacements in under a second', () => {
  const start = performance.now();
  let rawTail = '';
  let delivered = 0;

  for (let i = 0; i < 50_000; i++) {
    rawTail += 'x';
    const scanned = {
      decisionId: 'test',
      action: 'allow' as const,
      protectedItemCount: 0,
      effectiveText: rawTail,
      replacements: []
    };
    const release = planStreamRelease(rawTail, scanned);
    if (release.displayText) {
      delivered += Array.from(release.displayText).length;
    }
    rawTail = release.rawTail;
  }

  const end = performance.now();
  const elapsed = end - start;
  assert.ok(elapsed < 2000, `Performance regression: 50,000 chunks took ${elapsed}ms`);
});
