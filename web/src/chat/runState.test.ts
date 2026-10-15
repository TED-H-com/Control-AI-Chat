// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiClientError} from '../api.js';
import { chatApi } from './api.js';
import { routingSelection } from './routing.js';
import { bindPendingMessage, chatOwnerKey, failureFromStartCatch, ownerMatchesRoute, reconcileCompletedMessages, regenerateForSelection, retryForFailure, revisePendingMessage, runAfterFailure, startApprovalPolling } from './runState.js';
import {ChatHttpError} from './stream.js';

function message(id:string,role:'user'|'assistant',content:string) {
  return {
    id,conversationId:'conversation-1',parentMessageId:null,role,content,
    modelId:role === 'assistant' ? 'model-1' : null,provider:role === 'assistant' ? 'openai' : null,
    createdAt:'2026-08-09T12:00:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,
    gate:null,attachments:[],version:1,
  };
}

test('run creation binds the optimistic user turn to canonical server ids', () => {
  const pending = {...message('temporary-id','user','Review this policy'),conversationId:''};
  const bound = bindPendingMessage(pending,'conversation-1','user-message-1');
  assert.equal(bound?.id,'user-message-1');
  assert.equal(bound?.conversationId,'conversation-1');
  assert.equal(bound?.content,'Review this policy');
});

test('run completion keeps the just-sent user turn beside the assistant response', () => {
  const pending = message('user-message-1','user','Review this policy');
  const assistant = message('assistant-message-1','assistant','The policy is ready.');
  const completed = reconcileCompletedMessages([],pending,assistant);
  assert.deepEqual(completed.map(item => [item.role,item.content]),[
    ['user','Review this policy'],
    ['assistant','The policy is ready.'],
  ]);
});

test('canonical user and assistant ids are not duplicated during completion reconciliation', () => {
  const pending = message('user-message-1','user','Review this policy');
  const oldAssistant = message('assistant-message-1','assistant','Partial');
  const completedAssistant = {...oldAssistant,content:'Complete',version:2};
  const completed = reconcileCompletedMessages([pending,oldAssistant],pending,completedAssistant);
  assert.deepEqual(completed.map(item => item.id),['user-message-1','assistant-message-1']);
  assert.equal(completed[1]?.content,'Complete');
  assert.equal(completed[1]?.version,2);
});

test('warning revision restores the pending content to the composer draft', () => {
  assert.deepEqual(revisePendingMessage(message('user-message-1','user','Remove the account number')),{draft:'Remove the account number',pending:null});
  assert.deepEqual(revisePendingMessage(null),{draft:null,pending:null});
});

test('run ownership never follows the user into a different conversation',()=>{
  const owner=chatOwnerKey('conversation-a');
  assert.equal(ownerMatchesRoute(owner,'chat','conversation-a'),true);
  assert.equal(ownerMatchesRoute(owner,'chat','conversation-b'),false);
  assert.equal(ownerMatchesRoute(owner,'projects','conversation-a'),false);
  assert.equal(ownerMatchesRoute(chatOwnerKey(null),'chat',null),true);
  assert.equal(ownerMatchesRoute(chatOwnerKey(null),'chat','conversation-a'),false);
});

test('an interrupted retry preserves the exact text request and idempotency identity',()=>{
  const request=chatApi.runRequest({
    conversationId:'conversation-a',content:'Review this note',mode:'single',modelId:'model-a',
    reasoningEffort:'high',tone:'formal',role:'coach',clientRequestId:'request-a',
  });
  const retried=retryForFailure({kind:'interrupted'},request,()=>assert.fail('an interrupted request must not regenerate'));
  assert.strictEqual(retried,request);
  assert.equal('fileIds' in (retried?.body as object),false);
  assert.equal((retried?.body as {clientRequestId:string}).clientRequestId,'request-a');
  assert.equal((retried?.body as {tone:string}).tone,'formal');
  assert.equal((retried?.body as {role:string}).role,'coach');
});

test('retry after run.failed regenerates the failed reply under a new idempotency identity',()=>{
  const original=chatApi.runRequest({content:'Review this note',mode:'single',modelId:'model-a',reasoningEffort:'high',clientRequestId:'request-a'});
  let regeneratedMessageId=null;
  const retried=retryForFailure({kind:'run',error:{code:'PROVIDER_UNAVAILABLE',message:'hidden',requestId:'request-1',retryable:true},partialMessageId:'failed-reply'},original,messageId=>{
    regeneratedMessageId=messageId;
    return chatApi.regenerateRequest(messageId,{mode:'single',modelId:'model-b'},'high','formal','coach',null);
  });
  assert.equal(retried?.path,'/api/v1/chat/runs/regenerate');assert.equal(regeneratedMessageId,'failed-reply');assert.equal(retried?.body.messageId,'failed-reply');assert.equal(retried?.body.modelId,'model-b');assert.notEqual(retried?.body.clientRequestId,original.body.clientRequestId);
});

test('JSON refusals that can make progress retry the same request under a new identity',()=>{
  const request=chatApi.runRequest({content:'Review this note',mode:'auto',reasoningEffort:'medium',clientRequestId:'request-a'});
  for(const [status,code,retryable] of [[429,'RATE_LIMITED',true],[500,'INTERNAL_ERROR',false]]){
    const retried=retryForFailure({kind:'api',status,error:{code,message:'hidden',requestId:'request-1',retryable}},request,()=>assert.fail('an API refusal must not regenerate'));
    assert.equal(retried?.path,request.path);assert.deepEqual({...retried?.body,clientRequestId:undefined},{...request.body,clientRequestId:undefined});assert.notEqual(retried?.body.clientRequestId,request.body.clientRequestId);
  }
});

test('a retryable HTTP status and an interrupted stream reuse the exact request object',()=>{
  const request=chatApi.runRequest({content:'Review this note',mode:'auto',reasoningEffort:'medium',clientRequestId:'request-a'});
  assert.strictEqual(retryForFailure({kind:'status',status:502},request,()=>assert.fail()),request);
  assert.strictEqual(retryForFailure({kind:'interrupted'},request,()=>assert.fail()),request);
});

test('a bare HTTP 429 retry reuses the exact request and idempotency identity',()=>{
  const request=chatApi.runRequest({content:'Review this note',mode:'auto',reasoningEffort:'medium',clientRequestId:'request-a'});
  const retried=retryForFailure({kind:'status',status:429},request,()=>assert.fail('a bare HTTP refusal must not regenerate'));
  assert.strictEqual(retried,request);assert.equal(retried?.body.clientRequestId,'request-a');
});

test('permanent failures and failures without a request produce no retry or regeneration',()=>{
  const request=chatApi.runRequest({content:'Review this note',mode:'auto',reasoningEffort:'medium',clientRequestId:'request-a'});
  let builderCalls=0;const regenerate=()=>{builderCalls+=1;return request;};
  assert.equal(retryForFailure({kind:'run',error:{code:'BUDGET_HARD_LIMIT',message:'hidden',requestId:'request-1',retryable:true},partialMessageId:'reply'},request,regenerate),null);
  assert.equal(retryForFailure({kind:'status',status:422},request,regenerate),null);
  assert.equal(retryForFailure({kind:'api',status:404,error:{code:'RESOURCE_NOT_FOUND',message:'hidden',requestId:'request-1',retryable:false}},request,regenerate),null);
  assert.equal(retryForFailure({kind:'api',status:429,error:{code:'RATE_LIMITED',message:'hidden',requestId:'request-1',retryable:true}},null,regenerate),null);
  assert.equal(builderCalls,0);
});

test('the regenerate builder rejects an incomplete single-provider selection',()=>{
  assert.equal(regenerateForSelection('reply','single','',null,{mode:'single'},'medium','default','default'),null);
});

test('the regenerate builder uses the selection active when the action is invoked',()=>{
  const first=regenerateForSelection('reply','single','model-a',null,{mode:'single',provider:'openai'},'medium','default','default');
  const changed=regenerateForSelection('reply','single','model-b',null,{mode:'single',provider:'anthropic'},'medium','default','default');
  assert.equal(first?.body.provider,'openai');assert.equal(changed?.body.provider,'anthropic');assert.notDeepEqual(first?.body,changed?.body);
});

test('the shared regenerate builder gives the row action request for the same selection',()=>{
  const selection={mode:'single',provider:'openai'};const built=regenerateForSelection('reply','single','model-a','assistant-a',selection,'high','formal','coach');const row=chatApi.regenerateRequest('reply',selection,'high','formal','coach','assistant-a');
  const withoutKey=({clientRequestId:_key,...body})=>body;assert.equal(built?.path,row.path);assert.deepEqual(withoutKey(built?.body),withoutKey(row.body));
});

const activeRun=(text='released text')=>({runId:'run-1',conversationId:'conversation-1',assistantMessageId:'reply',text,status:'streaming',gate:null,responseGate:null,warningToken:null,failure:null,ownerKey:'chat:conversation-1',request:null});

test('run failure state clears released text for a gate block and keeps it for provider failure',()=>{
  const blockedError={code:'GATE_BLOCKED',message:'hidden',requestId:'request-1',retryable:false};const providerError={code:'PROVIDER_UNAVAILABLE',message:'hidden',requestId:'request-2',retryable:true};
  const blocked=runAfterFailure(activeRun(),{runId:'run-1',error:blockedError,partialMessageId:'reply'});const provider=runAfterFailure(activeRun(),{runId:'run-1',error:providerError,partialMessageId:'reply'});
  assert.equal(blocked.text,'');assert.equal(provider.text,'released text');assert.deepEqual(blocked.failure,{kind:'run',error:blockedError,partialMessageId:'reply'});assert.deepEqual(provider.failure,{kind:'run',error:providerError,partialMessageId:'reply'});
});

test('start failure classification distinguishes API envelopes, HTTP statuses and interruptions',()=>{
  const envelope={error:{code:'RATE_LIMITED',message:'hidden',requestId:'request-1',retryable:true}};
  assert.deepEqual(failureFromStartCatch(new ApiClientError(429,envelope)),{kind:'api',error:envelope.error,status:429});assert.deepEqual(failureFromStartCatch(new ChatHttpError(502)),{kind:'status',status:502});assert.deepEqual(failureFromStartCatch(new Error('offline')),{kind:'interrupted'});
});

test('assistant binding is explicit in every run request and never expands into prompt content',()=>{
  const assistantId='12345678-1234-1234-1234-123456789012';
  const run=chatApi.runRequest({content:'Review',mode:'single',modelId:'model-a',reasoningEffort:'medium',assistantId,clientRequestId:'request-a'});
  assert.equal(run.body.assistantId,assistantId);
  assert.deepEqual(Object.keys(run.body).filter(key=>/assistant|prompt/i.test(key)),['assistantId']);

  const regenerate=chatApi.regenerateRequest('message-a',{mode:'single',modelId:'model-a'},'medium','default','default',assistantId);
  assert.equal(regenerate.body.assistantId,assistantId);
  const edit=chatApi.editRequest('message-a','Revised',{mode:'single',modelId:'model-a'},'medium','default','default',assistantId);
  assert.equal(edit.body.assistantId,assistantId);
  assert.equal(chatApi.regenerateRequest('message-a',{mode:'auto'},'low','default','default',null).body.assistantId,null);
  assert.equal(chatApi.editRequest('message-a','Revised',{mode:'auto'},'low','default','default',null).body.assistantId,null);
});

test('edit and resend builds the dedicated branch request',()=>{
  const request=chatApi.editRequest('message-a','Revised content',{mode:'single',modelId:'model-a'},'medium','friendly','critic',null);
  assert.equal(request.path,'/api/v1/chat/runs/edit-resend');
  assert.deepEqual(
    (({messageId,content,mode,modelId,reasoningEffort,tone,role})=>({messageId,content,mode,modelId,reasoningEffort,tone,role}))(request.body),
    {messageId:'message-a',content:'Revised content',mode:'single',modelId:'model-a',reasoningEffort:'medium',tone:'friendly',role:'critic'},
  );
  assert.equal('fileIds' in request.body,false);
});

test('provider selection sends the provider and effort without pinning a hidden exact model',()=>{
  const models=[{id:'claude-fast',provider:'anthropic',enabled:true}] as Parameters<typeof routingSelection>[0];
  const selection=routingSelection(models,'single','claude-fast');
  const request=chatApi.editRequest('message-a','Revised content',selection,'high','detailed','default',null);
  assert.deepEqual(selection,{mode:'single',provider:'anthropic'});
  assert.deepEqual(
    (({mode,provider,reasoningEffort})=>({mode,provider,reasoningEffort}))(request.body),
    {mode:'single',provider:'anthropic',reasoningEffort:'high'},
  );
  assert.equal('modelId' in request.body,false);
});

test('approval polling ignores a nonempty placeholder until the durable run completes',async()=>{
  const held=message('held-assistant','assistant','Approval is required');
  const releaseUser={...message('release-user','user','Approved request'),parentMessageId:held.id};
  const releaseAssistant={...message('release-assistant','assistant','Released answer'),parentMessageId:releaseUser.id};
  const queue:Array<{callback:()=>void;delay:number;cancelled:boolean}>=[];
  const setTimer=(callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};queue.push(item);return item as unknown as ReturnType<typeof setTimeout>;};
  const clearTimer=(timer:ReturnType<typeof setTimeout>)=>{(timer as unknown as {cancelled:boolean}).cancelled=true;};
  const statuses=['awaiting_approval','completed'];let conversationCalls=0,outcome:{status:string;messages:string[]}|null=null;
  const stop=startApprovalPolling({intervalMs:20,setTimer,clearTimer,
    fetchRun:async()=>({status:statuses.shift()}),
    fetchConversation:async()=>{conversationCalls+=1;return {conversation:{id:'conversation-1'},messages:[held,releaseUser,releaseAssistant]};},
    onResolved:(detail,status)=>{outcome={status,messages:detail.messages.map(item=>item.id)};},
  });
  const pending=queue.shift();assert.equal(pending?.delay,20);pending?.callback();await Promise.resolve();
  assert.equal(outcome,null,'placeholder text is not a terminal signal');assert.equal(conversationCalls,0,'pending polls do not fetch the transcript');
  const terminal=queue.shift();assert.equal(terminal?.delay,20);terminal?.callback();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(outcome,{status:'completed',messages:['held-assistant','release-user','release-assistant']});
  assert.equal(queue.length,0,'terminal completion stops polling');stop();
});

test('denied and expired approvals fetch their terminal conversation state',async()=>{
  for(const status of ['failed','cancelled'] as const){
    const queue:Array<()=>void>=[];let outcome:string|null=null,conversationCalls=0;
    const stop=startApprovalPolling({intervalMs:20,
      setTimer:callback=>{queue.push(callback);return callback as unknown as ReturnType<typeof setTimeout>;},clearTimer:()=>{},
      fetchRun:async()=>({status}),
      fetchConversation:async()=>{conversationCalls+=1;return {conversation:{id:'conversation-1'},messages:[message('held','assistant',status==='failed'?'Request denied':'Request expired')]};},
      onResolved:(_detail,terminal)=>{outcome=terminal;},
    });
    queue.shift()?.();await Promise.resolve();await Promise.resolve();
    assert.equal(outcome,status);assert.equal(conversationCalls,1);assert.equal(queue.length,0);stop();
  }
});

test('approval polling backs off transient failures and cancellation aborts in-flight work',async()=>{
  const queue:Array<{callback:()=>void;delay:number;cancelled:boolean}>=[];
  const setTimer=(callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};queue.push(item);return item as unknown as ReturnType<typeof setTimeout>;};
  const clearTimer=(timer:ReturnType<typeof setTimeout>)=>{(timer as unknown as {cancelled:boolean}).cancelled=true;};
  let calls=0,outcome:string|null=null;
  let inFlightSignal:AbortSignal|null=null;
  let releaseInFlight:((run:{status:string})=>void)|null=null;
  const stop=startApprovalPolling({
    intervalMs:20,maxBackoffMs:80,setTimer,clearTimer,
    fetchRun:async signal=>{
      calls+=1;
      if(calls===1)throw new Error('offline');
      if(calls===2)return {status:'awaiting_approval'};
      inFlightSignal=signal;
      return new Promise(resolve=>{releaseInFlight=resolve;});
    },
    fetchConversation:async()=>{throw new Error('a pending run must not fetch its conversation');},
    onResolved:(_detail,status)=>{outcome=status;},
  });
  const first=queue.shift();
  assert.equal(first?.delay,20,'first poll waits about one interval');
  first?.callback();
  await Promise.resolve();
  const backedOff=queue.shift();
  assert.equal(backedOff?.delay,40,'a transient network error backs off');
  backedOff?.callback();
  await Promise.resolve();
  const regular=queue.shift();
  assert.equal(regular?.delay,20,'a successful pending read resets the interval');
  regular?.callback();
  await Promise.resolve();
  assert.equal(inFlightSignal?.aborted,false);
  stop();
  assert.equal(inFlightSignal?.aborted,true,'navigation or idle cleanup aborts an in-flight read');
  releaseInFlight?.({status:'awaiting_approval'});
  await Promise.resolve();
  assert.equal(outcome,null,'a cancelled watcher cannot update UI state');
});
