import {createHmac,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {deduplicateMatches,strongestAction} from './action.js';
import {applicableRules,makeMatch} from './match.js';
import {clearCodePointIndexCache} from './normalize.js';
import {PostflightScanner} from './stream-scanner.js';
import {maskWithoutVault} from './vault.js';
import type {Detector,DetectorMatch,GateContext,GateDisposition,GateEngine,GateEngineOptions,GateVerdict} from './types.js';

export const POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS=2048;
function disposition(pass:GateContext['pass'],action:GateVerdict['action'],confirmed:boolean):GateDisposition{if(pass==='postflight')return action==='block'||action==='require_approval'?'blocked':'release_to_user';if(action==='require_approval')return'pending_approval';if(action==='block')return'blocked';if(action==='warn'&&!confirmed)return'await_user_confirmation';return'allow_provider_call'}

async function runDetector(detector:Detector,context:GateContext,audit?:GateEngineOptions['audit']):Promise<{matches:readonly DetectorMatch[];degraded:boolean;codes:readonly string[]}>{
  const began=performance.now(),controller=new AbortController(),relay=()=>controller.abort();context.abortSignal.addEventListener('abort',relay,{once:true});const timer=setTimeout(()=>controller.abort(),detector.timeoutMs);
  try{return await Promise.race([detector.detect({...context,abortSignal:controller.signal}),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('gate_detector_timeout')),{once:true}))]).then(result=>({matches:result.matches,degraded:result.degraded,codes:result.diagnostics}));}
  catch{
    const code=controller.signal.aborted?'detector_timeout':'detector_failed',direction=typeof context.metadata.direction==='string'?context.metadata.direction:context.parts.some(part=>part.source==='provider_response')?'inbound':context.parts.some(part=>part.source==='file_extraction')?'file':'outbound';
    audit?.append({tenantId:context.subject.tenantId,action:'gate.detector_failed',actor:{type:'user',id:context.subject.userId,sessionId:null,ip:null,userAgent:null,authMethod:null},target:{type:'message',id:context.messageId},outcome:'failure',context:{requestId:context.requestId,traceId:null,source:'http',occurredAtMs:context.nowMs},subjectUserId:context.subject.userId,conversationId:context.conversationId,messageId:context.messageId,modelId:context.modelId,providerId:context.providerId,detector:detector.id,metadata:{detector:detector.id,reasonCode:code,direction}});
    if(detector.failureMode==='open')return {matches:[],degraded:true,codes:[`${detector.id}_${code}`]};
    const fallback=detector.failureMode==='closed'?'block':'flag',rules=applicableRules(context,detector.kind);
    return {matches:rules.map(rule=>makeMatch({tenantId:context.subject.tenantId,detectorId:detector.id,kind:detector.kind,rule:{...rule,action:fallback},partId:context.parts[0]?.id??'engine',category:code,confidence:'low',span:null,text:'',label:'DETECTOR_FAILURE'})),degraded:true,codes:[`${detector.id}_${code}_${Math.round((performance.now()-began)*1000)>0?'handled':'handled'}`]};
  }finally{clearTimeout(timer);context.abortSignal.removeEventListener('abort',relay)}
}

export class DefaultGateEngine implements GateEngine {
  readonly detectors:readonly Detector[];readonly maxPart:number;readonly maxAggregate:number;
  constructor(readonly options:GateEngineOptions){this.detectors=[...options.detectors].sort((a,b)=>a.stage-b.stage||a.id.localeCompare(b.id));this.maxPart=options.maxPartCodePoints??1048576;this.maxAggregate=options.maxAggregateCodePoints??4194304}
  async evaluate(context:GateContext):Promise<GateVerdict>{
   try{
    const totalStart=performance.now();if(context.policySnapshot.tenantId!==context.subject.tenantId)throw new Error('gate_tenant_mismatch');let aggregate=0;
    for(const part of context.parts){const size=Array.from(part.text).length;if(size>this.maxPart||(aggregate+=size)>this.maxAggregate)throw new Error('gate_input_too_large');if(!part.id)throw new Error('gate_part_id_required')}
    const deterministicStart=performance.now(),matches:DetectorMatch[]=[],codes:string[]=[];let degraded=false,semanticUs=0;
    for(const detector of this.detectors){if(!detector.supportedPasses.has(context.pass))continue;const started=performance.now(),result=await runDetector(detector,context,this.options.audit);if(detector.stage>=100)semanticUs+=Math.round((performance.now()-started)*1000);matches.push(...result.matches);codes.push(...result.codes);degraded ||= result.degraded;if(detector.stage<100&&['block','require_approval'].includes(strongestAction(matches)))continue}
    const deterministicUs=Math.round((performance.now()-deterministicStart)*1000)-semanticUs,unique=deduplicateMatches(matches),action=strongestAction(unique),confirmed=action==='warn'&&Boolean(context.confirmedWarningToken),finalDisposition=disposition(context.pass,action,confirmed);let providerParts:readonly typeof context.parts[number][]|null=null,displayParts:readonly typeof context.parts[number][]|null=null,redactions:GateVerdict['redactions']=[],masks:GateVerdict['masks']=[],vaultUs=0;
    if(action==='redact'||action==='mask'||unique.some(x=>x.action==='redact'||x.action==='mask')){const hasRedaction=unique.some(x=>x.action==='redact');if(hasRedaction&&!this.options.vault)throw new Error('gate_vault_unavailable');const start=performance.now(),transformed=this.options.vault?await this.options.vault.redact(context,unique):maskWithoutVault(context,unique);vaultUs=Math.round((performance.now()-start)*1000);providerParts=finalDisposition==='allow_provider_call'?transformed.parts:null;displayParts=finalDisposition==='release_to_user'?transformed.parts:null;redactions=transformed.redactions;masks=transformed.masks}else if(finalDisposition==='allow_provider_call')providerParts=context.parts;else if(finalDisposition==='release_to_user')displayParts=context.parts;
    const warningToken=finalDisposition==='await_user_confirmation'?this.warningToken(context):null,elapsed=Math.round((performance.now()-totalStart)*1000);return {evaluationId:context.evaluationId,pass:context.pass,action,disposition:finalDisposition,matches:unique,providerParts,displayParts,redactions,masks,warningToken,approvalRequestId:finalDisposition==='pending_approval'?randomUUID():null,policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:context.policySnapshot.fingerprint,degraded,failureCodes:codes,timings:{resolveUs:0,normalizeUs:0,deterministicUs,semanticUs,vaultUs,totalUs:elapsed}}
   }finally{// Concurrent evaluations only interleave at awaits; an early clear may cause one harmless rebuild in another evaluation.
    clearCodePointIndexCache()
   }
  }
  warningToken(context:GateContext):string{if(!this.options.warningSecret)return randomUUID();const payload=Buffer.from(JSON.stringify({e:context.evaluationId,u:context.subject.userId,p:context.policySnapshot.fingerprint,x:context.nowMs+600000})).toString('base64url');return `${payload}.${createHmac('sha256',this.options.warningSecret).update(payload).digest('base64url')}`}
  createPostflightStream(context:GateContext){if(context.pass!=='postflight')throw new Error('gate_stream_requires_postflight');return new PostflightScanner(this,context,Math.max(POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS,this.options.streamHoldbackCodePoints??0))}
}
export function assertProviderTransportAuthorized(verdict:GateVerdict):asserts verdict is GateVerdict&{providerParts:readonly NonNullable<GateVerdict['providerParts']>[number][]}{if(verdict.pass!=='preflight'||verdict.disposition!=='allow_provider_call'||!verdict.providerParts)throw new Error('gate_provider_transport_not_authorized')}
