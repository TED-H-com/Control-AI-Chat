import type { ChatRun,RoleKey,StreamEvent,ToneKey } from '@shared/types';
import {ApiClientError} from '../api.js';
import {chatApi,type ChatSelection} from './api.js';
import {chatFailureCanRetry} from './failures.js';
import type {ChatMode,ReasoningEffort} from './routing.js';
import {ChatHttpError} from './stream.js';
import type { ActiveRun,ChatFailure, ChatRunRequest, ChatView, ConversationDetail, Message } from './types.js';

export const NEW_CHAT_OWNER = 'chat:new';

export function chatOwnerKey(conversationId:string|null):string {
  return conversationId ? `chat:${conversationId}` : NEW_CHAT_OWNER;
}

export function ownerMatchesRoute(ownerKey:string|null,view:ChatView,conversationId:string|null):boolean {
  return ownerKey !== null && view === 'chat' && ownerKey === chatOwnerKey(conversationId);
}

function requestWithNewClientId(request:ChatRunRequest):ChatRunRequest {
  const body=request.body;
  if(typeof body!=='object'||body===null||!('clientRequestId' in body))return request;
  return {...request,body:{...body,clientRequestId:crypto.randomUUID()}};
}

export function retryForFailure(failure:ChatFailure,request:ChatRunRequest|null,regenerate:(messageId:string)=>ChatRunRequest|null):ChatRunRequest|null {
  if(!chatFailureCanRetry(failure))return null;
  if(failure.kind==='run')return failure.partialMessageId===null?null:regenerate(failure.partialMessageId);
  if(request===null)return null;
  if(failure.kind==='api')return requestWithNewClientId(request);
  return request;
}

export function regenerateForSelection(messageId:string,chatMode:ChatMode,modelId:string,assistantId:string|null,selection:ChatSelection,effort:ReasoningEffort,tone:ToneKey,role:RoleKey):ChatRunRequest|null {
  if(chatMode==='single'&&!modelId&&!assistantId)return null;
  return chatApi.regenerateRequest(messageId,selection,effort,tone,role,assistantId);
}

type RunFailedData=Extract<StreamEvent,{event:'run.failed'}>['data'];
export function runAfterFailure<T extends ActiveRun>(old:T,data:RunFailedData):T {
  const failure:ChatFailure={kind:'run',error:data.error,partialMessageId:data.partialMessageId};
  return {...old,status:'error',failure,text:data.error.code==='GATE_BLOCKED'?'':old.text};
}

export function failureFromStartCatch(caught:unknown):ChatFailure {
  if(caught instanceof ApiClientError)return {kind:'api',error:caught.body.error,status:caught.status};
  if(caught instanceof ChatHttpError)return {kind:'status',status:caught.status};
  return {kind:'interrupted'};
}
export function bindPendingMessage(pending:Message|null,conversationId:string,userMessageId:string): Message|null {
  return pending ? {...pending,id:userMessageId,conversationId} : null;
}

export function reconcileCompletedMessages(stored:readonly Message[],pending:Message|null,assistant:Message): Message[] {
  const messages = [...stored];
  if (pending && !messages.some(message => message.id === pending.id)) messages.push(pending);
  const assistantIndex = messages.findIndex(message => message.id === assistant.id);
  if (assistantIndex < 0) messages.push(assistant);
  else messages[assistantIndex] = assistant;
  return messages;
}

export function revisePendingMessage(pending:Message|null): {draft:string|null;pending:null} {
  return {draft:pending?.content ?? null,pending:null};
}

export const APPROVAL_POLL_INTERVAL_MS = 2_000;
export const APPROVAL_POLL_MAX_BACKOFF_MS = 16_000;

export interface ApprovalPollOptions {
  fetchRun:(signal:AbortSignal)=>Promise<Pick<ChatRun,'status'>>;
  fetchConversation:(signal:AbortSignal)=>Promise<ConversationDetail>;
  onResolved:(detail:ConversationDetail,status:'completed'|'failed'|'cancelled')=>void;
  intervalMs?:number;
  maxBackoffMs?:number;
  setTimer?:(callback:()=>void,delayMs:number)=>ReturnType<typeof setTimeout>;
  clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void;
}

export function startApprovalPolling(options:ApprovalPollOptions):()=>void {
  const interval=options.intervalMs??APPROVAL_POLL_INTERVAL_MS;
  const maxBackoff=Math.max(interval,options.maxBackoffMs??APPROVAL_POLL_MAX_BACKOFF_MS);
  const setTimer=options.setTimer??((callback,delay)=>setTimeout(callback,delay));
  const clearTimer=options.clearTimer??clearTimeout;
  let cancelled=false;
  let failures=0;
  let timer:ReturnType<typeof setTimeout>|null=null;
  let request:AbortController|null=null;

  const schedule=(delay:number):void=>{
    if(cancelled)return;
    timer=setTimer(()=>{timer=null;void poll();},delay);
  };
  const poll=async():Promise<void>=>{
    request=new AbortController();
    try {
      const run=await options.fetchRun(request.signal);
      if(run.status!=='completed'&&run.status!=='failed'&&run.status!=='cancelled'){
        request=null;
        if(cancelled)return;
        failures=0;
        schedule(interval);
        return;
      }
      const detail=await options.fetchConversation(request.signal);
      request=null;
      if(cancelled)return;
      options.onResolved(detail,run.status);
    } catch {
      request=null;
      if(cancelled)return;
      failures+=1;
      schedule(Math.min(maxBackoff,interval*(2**Math.min(failures,16))));
    }
  };

  schedule(interval);
  return ()=>{
    cancelled=true;
    if(timer!==null)clearTimer(timer);
    timer=null;
    request?.abort();
    request=null;
  };
}
