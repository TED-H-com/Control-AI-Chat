import { Hono } from 'hono';
import { apiError, errorEnvelope } from '../lib/http/index.js';
import { PINNABLE_PROVIDERS, type ApiError, type ChatInput, type ChatMode, type ChatRun, type EditResendInput, type GateAction, type GateDirection, type Message, type RegenerateInput, type StreamEvent, type UsageSummary } from '../shared/api.js';
import { beginWarningConfirmation, resumeConfirmedRun, type ConfirmRunDependencies } from '../app/chat/confirm-run.js';
import {chatErrorReason,governedPipelineError} from '../app/chat/pipeline-error.js';
export {governedPipelineError} from '../app/chat/pipeline-error.js';
import { planStreamRelease, StreamProtectionAccumulator, type StreamReplacement } from '../app/chat/stream-release.js';
import type { RouteEnv } from './types.js';

export interface ChatGateResult { readonly decisionId:string; readonly action:GateAction; readonly direction?:GateDirection; readonly protectedItemCount:number|null; readonly effectiveText:string; readonly replacements?:readonly StreamReplacement[]; readonly message:string; readonly confirmationToken?:string; readonly approvalId?:string; }
export interface ChatReservation { readonly id:string; }
export type ProviderChunk = {readonly type:'text';readonly text:string}|{readonly type:'reasoning';readonly text:string}|{readonly type:'usage';readonly inputTokens:number;readonly outputTokens:number;readonly costUsd:number};
export interface ChatPipelineServices {
  createRun(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,input:ChatInput|RegenerateInput|EditResendInput,mode:'create'|'regenerate'|'edit-resend',idempotency:{key:string;requestHash:string;method:string;path:string}):Promise<{run:ChatRun;assistant:Message;providerRequest:unknown;outboundText:string;replay?:boolean}>;
  gate(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,input:{direction:GateDirection;text:string;runId:string},signal:AbortSignal):Promise<ChatGateResult>;
  reserveBudget(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun):Promise<ChatReservation>;
  heartbeatReservation?(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun,reservation:ChatReservation):Promise<void>;
  dispatchStarted(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun,reservation:ChatReservation):Promise<void>;
  streamProvider(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,request:unknown,authorized:{preflightDecisionId:string;reservationId:string;effectiveText:string},signal:AbortSignal):AsyncIterable<ProviderChunk>;
  persistEvent(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,runId:string,eventId:number,event:StreamEvent):Promise<void>;
  complete(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun,assistant:Message,text:string,usage:UsageSummary,reservation:ChatReservation,protectedItemCount:number):Promise<Message>;
  fail(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun,reservation:ChatReservation|null,error:ApiError['error'],replay:{partialMessageId:string|null;gateNotice?:Extract<StreamEvent,{event:'gate.notice'}>['data']}):Promise<void>;
  audit(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,run:ChatRun,outcome:'success'|'failure'|'denied',metadata:Readonly<Record<string,unknown>>):Promise<void>;
  getRun(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,id:string):Promise<ChatRun|null>;
  replay(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,id:string,after:number,signal:AbortSignal):AsyncIterable<{id:number;event:StreamEvent}>;
  cancel(tenant:NonNullable<import('../lib/http/index.js').TenantContext>,id:string):Promise<'accepted'|'terminal'|'missing'>;
}

const encoder=new TextEncoder();
function frame(id:number,event:StreamEvent):Uint8Array { return encoder.encode(`id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); }
function terminal(action:GateAction):boolean { return action==='block'||action==='warn'||action==='require_approval'; }
function canonical(value:unknown):string { if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; }

export function createChatRoutes(services:ChatPipelineServices,confirmations?:ConfirmRunDependencies):Hono<RouteEnv> {
  const app=new Hono<RouteEnv>();
  for (const [path,mode] of [['/chat/runs','create'],['/chat/runs/regenerate','regenerate'],['/chat/runs/edit-resend','edit-resend']] as const) {
    app.post(path,async c => {
      const tenant=c.get('tenant'); if(!tenant) return apiError(c,401,'UNAUTHENTICATED','Authentication required');
      if(!tenant.principal.permissions.has('chat:use')) return apiError(c,403,'FORBIDDEN','Insufficient permission');
      const idempotencyKey=c.req.header('Idempotency-Key');if(!idempotencyKey) return apiError(c,400,'INVALID_REQUEST','Idempotency-Key is required');
      let input:ChatInput|RegenerateInput|EditResendInput; try { input=await c.req.json<ChatInput|RegenerateInput|EditResendInput>(); } catch { return apiError(c,400,'INVALID_REQUEST','Request body is not valid JSON'); }
      const fileIds=(input as {fileIds?:unknown}).fileIds;
      if(Array.isArray(fileIds)&&fileIds.length>10)return apiError(c,422,'VALIDATION_FAILED','fileIds must contain at most 10 attachment ids',{details:{reason:'chat_too_many_attachments'}});
      if(fileIds!==undefined&&(!Array.isArray(fileIds)||fileIds.some(id=>typeof id!=='string')||new Set(fileIds).size!==fileIds.length))
        return apiError(c,422,'VALIDATION_FAILED','fileIds must be a list of unique attachment ids',{details:{reason:'chat_attachments_invalid'}});
      if(mode!=='regenerate'&&(!('content' in input)||typeof input.content!=='string'||input.content.length>100_000||(!input.content.trim()&&(!Array.isArray(fileIds)||fileIds.length===0))))
        return apiError(c,422,'VALIDATION_FAILED','A message must contain text or at least one attachment',{details:{reason:'chat_message_empty'}});
      const reasoningEffort=(input as {reasoningEffort?:unknown}).reasoningEffort;
      if(reasoningEffort!==undefined&&!['low','medium','high'].includes(String(reasoningEffort)))return apiError(c,422,'VALIDATION_FAILED','reasoningEffort must be low, medium, or high',{details:{reason:'chat_option_invalid'}});
      const tone=(input as {tone?:unknown}).tone;
      if(tone!==undefined&&!['default','concise','detailed','formal','friendly'].includes(String(tone)))return apiError(c,422,'VALIDATION_FAILED','tone must be default, concise, detailed, formal, or friendly',{details:{reason:'chat_option_invalid'}});
      const role=(input as {role?:unknown}).role;
      if(role!==undefined&&!['default','coach','creative','critic','debate','support'].includes(String(role)))return apiError(c,422,'VALIDATION_FAILED','role must be default, coach, creative, critic, debate, or support',{details:{reason:'chat_option_invalid'}});
      const assistantId=(input as {assistantId?:unknown}).assistantId;
      if(assistantId!==undefined&&assistantId!==null&&(typeof assistantId!=='string'||assistantId.length!==36))return apiError(c,422,'VALIDATION_FAILED','assistantId must be a 36-character id',{details:{reason:'chat_option_invalid'}});
      const chatMode=(input as {mode?:unknown}).mode;
      if(chatMode!==undefined&&!['auto','single','multi_model'].includes(String(chatMode)))return apiError(c,422,'VALIDATION_FAILED','mode must be auto, single, or multi_model',{details:{reason:'chat_option_invalid'}});
      if('family' in input)return apiError(c,422,'VALIDATION_FAILED','family is not a valid field; use provider',{details:{reason:'chat_option_invalid'}});
      const provider=(input as {provider?:unknown}).provider;
      if(provider!==undefined&&!(PINNABLE_PROVIDERS as readonly unknown[]).includes(provider))return apiError(c,422,'VALIDATION_FAILED','provider must be openai, anthropic, google, or xai',{details:{reason:'chat_option_invalid'}});
      const modelId=(input as {modelId?:unknown}).modelId;
      if(modelId!==undefined&&(typeof modelId!=='string'||!modelId.trim()))return apiError(c,422,'VALIDATION_FAILED','modelId must be a non-empty model id',{details:{reason:'chat_option_invalid'}});
      if(chatMode==='single'&&modelId===undefined&&provider===undefined)return apiError(c,422,'VALIDATION_FAILED','single mode requires a modelId or provider',{details:{reason:'chat_single_target_required'}});
      if(chatMode==='multi_model'&&(modelId!==undefined||provider!==undefined))return apiError(c,422,'VALIDATION_FAILED','multi_model chooses its own fast models',{details:{reason:'chat_multi_model_target_refused'}});
      const requestMode=(chatMode??'auto') as ChatMode;
      const requestHash=await crypto.subtle.digest('SHA-256',encoder.encode(canonical(input))).then(bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join(''));
      let prepared;try{prepared=await services.createRun(tenant,input,mode,{key:idempotencyKey,requestHash,method:'POST',path:c.req.path});}catch(error){
        if(error instanceof Error&&error.message==='IDEMPOTENCY_KEY_REUSED')return apiError(c,409,'INVALID_REQUEST','Idempotency-Key was already used with a different request',{details:{reason:'chat_idempotency_reused'}});
        const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
        const ownReason=chatErrorReason(error);
        if(code==='RESOURCE_NOT_FOUND')return apiError(c,404,'RESOURCE_NOT_FOUND',error instanceof Error?error.message:'Resource was not found',ownReason?{details:{reason:ownReason}}:undefined);
        if(code==='VALIDATION_FAILED')return apiError(c,422,'VALIDATION_FAILED',error instanceof Error?error.message:'Request is not valid',ownReason?{details:{reason:ownReason}}:undefined);
        if(code==='model_not_allowed'||code==='provider_not_allowed'||code==='no_models_available'||code==='MODEL_NOT_ALLOWED'){
          const mapped=governedPipelineError(error,tenant.requestId,false,requestMode);
          return apiError(c,422,'MODEL_NOT_ALLOWED',error instanceof Error?error.message:'No eligible model is available',mapped.details?{details:mapped.details}:undefined);
        }
        throw error;
      }
      const abort=new AbortController(); c.req.raw.signal.addEventListener('abort',()=>abort.abort(),{once:true});
      if(prepared.replay){const stream=new ReadableStream<Uint8Array>({async start(controller){try{for await(const item of services.replay(tenant,prepared.run.id,0,abort.signal))controller.enqueue(frame(item.id,item.event));}finally{controller.close();}}});return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no','X-API-Version':'1','X-Request-Id':tenant.requestId}});}
      let eventId=0; let lastWrite=Date.now(); let closed=false;
      const stream=new ReadableStream<Uint8Array>({async start(controller){
        const emit=async(event:StreamEvent):Promise<void>=>{ if(closed)return; const id=++eventId; await services.persistEvent(tenant,prepared.run.id,id,event); controller.enqueue(frame(id,event)); lastWrite=Date.now(); };
        let reservation:ChatReservation|null=null,lastReservationHeartbeat=Date.now(),delivered=0;
        const heartbeat=setInterval(()=>{
          const now=Date.now();
          if(!closed&&now-lastWrite>=15_000){controller.enqueue(encoder.encode(`: keepalive ${now}\n\n`));lastWrite=now;}
          if(!closed&&reservation&&services.heartbeatReservation&&now-lastReservationHeartbeat>=60_000){lastReservationHeartbeat=now;void services.heartbeatReservation(tenant,prepared.run,reservation).catch(()=>abort.abort());}
        },1000);
        try {
          await emit({event:'run.created',data:{run:prepared.run}}); await emit({event:'run.status',data:{runId:prepared.run.id,status:'gating'}});
          const pre=await services.gate(tenant,{direction:'outbound',text:prepared.outboundText,runId:prepared.run.id},abort.signal);
          const emitGateNotice=async(result:ChatGateResult):Promise<Extract<StreamEvent,{event:'gate.notice'}>|null>=>{
            if(result.action==='allow'||result.action==='flag')return null;
            const notice:Extract<StreamEvent,{event:'gate.notice'}>={event:'gate.notice',data:{runId:prepared.run.id,direction:result.direction??'outbound',action:result.action,
              decisionId:result.decisionId,protectedItemCount:result.protectedItemCount,message:result.message,
              ...(result.confirmationToken?{confirmationToken:result.confirmationToken}:{}),...(result.approvalId?{approvalId:result.approvalId}:{})}};
            await emit(notice);return notice;
          };
          const preflightNotice=await emitGateNotice(pre);
          if(terminal(pre.action)) {
            if(pre.action==='warn') await emit({event:'run.status',data:{runId:prepared.run.id,status:'awaiting_confirmation'}});
            else if(pre.action==='require_approval') await emit({event:'run.status',data:{runId:prepared.run.id,status:'awaiting_approval'}});
            else { const error=errorEnvelope('GATE_BLOCKED','The request was blocked by policy',tenant.requestId).error; await services.fail(tenant,prepared.run,null,error,{partialMessageId:null,...(preflightNotice?{gateNotice:preflightNotice.data}:{})}); await services.audit(tenant,prepared.run,'denied',{decisionId:pre.decisionId}); await emit({event:'run.failed',data:{runId:prepared.run.id,error,partialMessageId:null}}); }
            return;
          }
          reservation=await services.reserveBudget(tenant,prepared.run);
          await services.dispatchStarted(tenant,prepared.run,reservation);
          await emit({event:'run.status',data:{runId:prepared.run.id,status:'streaming'}}); await emit({event:'message.created',data:{runId:prepared.run.id,message:prepared.assistant}});
          let rawTail=''; let text=''; let usage:UsageSummary|null=null; let index=0; let lastType:'text'|'reasoning'='text';const protection=new StreamProtectionAccumulator<ChatGateResult>();
          const observeInbound=async(result:ChatGateResult,releasedCount:number):Promise<void>=>{
            const notice=protection.observe(result,releasedCount);if(notice)await emitGateNotice(notice);
          };
          const emitDelta=async(kind:'text'|'reasoning',body:string):Promise<void>=>{await emit(kind==='text'
            ?{event:'assistant.delta',data:{runId:prepared.run.id,messageId:prepared.assistant.id,index:index++,text:body}}
            :{event:'reasoning.delta',data:{runId:prepared.run.id,messageId:prepared.assistant.id,index:index++,text:body,visibility:'user'}});};
          for await (const chunk of services.streamProvider(tenant,prepared.providerRequest,{preflightDecisionId:pre.decisionId,reservationId:reservation.id,effectiveText:pre.effectiveText},abort.signal)) {
            if(chunk.type==='usage') { usage={inputTokens:chunk.inputTokens,outputTokens:chunk.outputTokens,totalTokens:chunk.inputTokens+chunk.outputTokens,costUsd:chunk.costUsd,modelId:prepared.assistant.modelId!,provider:prepared.assistant.provider!,budgetWarnings:[]}; continue; }
            // Reasoning and answer shared one holdback buffer, so a reasoning chunk followed by an
            // answer chunk were concatenated and then cut by code-point count rather than at the
            // seam between them. Every Grok reply in the product was stored, and shown, as its own
            // chain-of-thought with the answer stuck on the end — xAI streams reasoning_content on
            // every request — and the same was true of any OpenAI model emitting a summary. Drain
            // the buffer at the boundary, and persist only what the model actually said.
            if(chunk.type!==lastType&&rawTail){
              const boundary=await services.gate(tenant,{direction:'inbound',text:rawTail,runId:prepared.run.id},abort.signal);
              if(boundary.action==='block'||boundary.action==='require_approval'||boundary.action==='warn'){await observeInbound(boundary,0);throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}
              const release=planStreamRelease(rawTail,boundary,true);await observeInbound(boundary,release.protectedItemCount);
              if(release.displayText){if(lastType==='text')text+=release.displayText;delivered+=Array.from(release.displayText).length;await emitDelta(lastType,release.displayText);}
              rawTail=release.rawTail;
            }
            rawTail+=chunk.text; lastType=chunk.type;
            const scanned=await services.gate(tenant,{direction:'inbound',text:rawTail,runId:prepared.run.id},abort.signal);
            if(scanned.action==='block'||scanned.action==='require_approval'||scanned.action==='warn'){await observeInbound(scanned,0);throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}
            const release=planStreamRelease(rawTail,scanned);await observeInbound(scanned,release.protectedItemCount);if(release.displayText){if(chunk.type==='text')text+=release.displayText;delivered+=Array.from(release.displayText).length;await emitDelta(chunk.type,release.displayText);}rawTail=release.rawTail;
          }
          if(!usage) throw new Error('Provider ended without usage');
          const finalScan=await services.gate(tenant,{direction:'inbound',text:rawTail,runId:prepared.run.id},abort.signal);if(finalScan.action==='block'||finalScan.action==='require_approval'||finalScan.action==='warn'){await observeInbound(finalScan,0);throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}const release=planStreamRelease(rawTail,finalScan,true),tail=release.displayText;await observeInbound(finalScan,release.protectedItemCount);if(lastType==='text')text+=tail;
          const completed=await services.complete(tenant,prepared.run,prepared.assistant,text,usage,reservation,protection.protectedItemCount); await services.audit(tenant,prepared.run,'success',{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costUsdMicros:Math.round(usage.costUsd*1_000_000)});
          if(tail)await emitDelta(lastType,tail);
          await emit({event:'usage.summary',data:{runId:prepared.run.id,usage}}); await emit({event:'run.completed',data:{runId:prepared.run.id,conversationId:prepared.run.conversationId,message:completed,usage}});
        } catch(error) {
          const cancelled=abort.signal.aborted; const api=governedPipelineError(error,tenant.requestId,cancelled,requestMode);
          await services.fail(tenant,prepared.run,reservation,api,{partialMessageId:prepared.assistant.id});
          // Streaming means deltas reach the user before the completion record can be written --
          // a completion cannot be audited before it completes. So when the completion append
          // fails, this failure append is the only durable trace that the run delivered anything.
          // Swallowing it silently left a run that had already streamed text to a user with no
          // record in the audit chain and none in `messages` either. The audit store is usually
          // the thing that is down, so there is nowhere durable left to write: log loudly enough
          // that the gap is reconstructible from the journal instead of vanishing.
          try{await services.audit(tenant,prepared.run,'failure',{cancelled});}
          catch(auditError){console.error(`AUDIT GAP run=${prepared.run.id} tenant=${tenant.principal.tenantId} deliveredCodePoints=${delivered}: the run streamed output but no completion or failure record could be written`,auditError);}
          if(cancelled) await emit({event:'run.cancelled',data:{runId:prepared.run.id,partialMessageId:prepared.assistant.id,usage:null}}); else await emit({event:'run.failed',data:{runId:prepared.run.id,error:api,partialMessageId:prepared.assistant.id}});
        } finally { closed=true;clearInterval(heartbeat);controller.close(); }
      }});
      return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no','X-API-Version':'1','X-Request-Id':tenant.requestId}});
    });
  }
  app.get('/chat/runs/:id/events',async c=>{
    const tenant=c.get('tenant');if(!tenant)return apiError(c,401,'UNAUTHENTICATED','Authentication required');
    const raw=c.req.header('Last-Event-ID')??c.req.query('after')??'0';const after=Number(raw);if(!Number.isInteger(after)||after<0)return apiError(c,400,'INVALID_REQUEST','Invalid event cursor');
    if(!await services.getRun(tenant,c.req.param('id')))return apiError(c,404,'RESOURCE_NOT_FOUND','Run not found');
    const stream=new ReadableStream<Uint8Array>({async start(controller){try{for await(const item of services.replay(tenant,c.req.param('id'),after,c.req.raw.signal))controller.enqueue(frame(item.id,item.event));}finally{controller.close();}}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
  });
  // Confirming a warning resumes the run the warning stopped, so it answers with the same event
  // stream the original send would have produced — which is why it cannot be a catalog route.
  // No Idempotency-Key: the confirmation token is single use, and that is the replay protection.
  if(confirmations) app.post('/gate/confirmations/:token',async c=>{
    const tenant=c.get('tenant');if(!tenant)return apiError(c,401,'UNAUTHENTICATED','Authentication required');
    if(!tenant.principal.permissions.has('chat:use'))return apiError(c,403,'FORBIDDEN','Insufficient permission');
    const begun=await beginWarningConfirmation(confirmations,tenant,c.req.param('token'));
    if(!begun.ok)return apiError(c,begun.status,begun.code,begun.message);
    const abort=new AbortController();c.req.raw.signal.addEventListener('abort',()=>abort.abort(),{once:true});
    let eventId=0,lastWrite=Date.now(),closed=false;
    const stream=new ReadableStream<Uint8Array>({async start(controller){
      const heartbeat=setInterval(()=>{if(!closed&&Date.now()-lastWrite>=15_000){controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));lastWrite=Date.now();}},1000);
      try{ for await(const event of resumeConfirmedRun(confirmations,tenant,begun.prepared,abort.signal)){
        const id=++eventId;await services.persistEvent(tenant,begun.prepared.run.id,id,event);controller.enqueue(frame(id,event));lastWrite=Date.now(); } }
      finally{ closed=true;clearInterval(heartbeat);controller.close(); }
    }});
    return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no','X-API-Version':'1','X-Request-Id':tenant.requestId}});
  });
  return app;
}
