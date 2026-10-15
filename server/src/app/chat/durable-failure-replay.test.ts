import assert from 'node:assert/strict';
import test from 'node:test';
import type {ChatRun,Message} from '../../shared/api.js';
import {durableReplayEvents} from './service.js';

const run:ChatRun={id:'run-1',conversationId:'conversation-1',userMessageId:'user-1',assistantMessageId:'assistant-1',status:'failed',streamUrl:'/events',createdAt:'2026-01-01T00:00:00.000Z'};
const assistant:Message={id:'assistant-1',conversationId:'conversation-1',parentMessageId:'user-1',role:'assistant',content:'',modelId:'model-1',provider:'openai',createdAt:run.createdAt,inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};

test('durable failed-run replay keeps the original retryable error envelope',()=>{
  const error={code:'PROVIDER_UNAVAILABLE' as const,message:'The selected provider is unavailable',requestId:'request-1',retryable:true};
  const failure=durableReplayEvents(run.id,{run,assistant,error}).at(-1);
  assert.deepEqual(failure?.event==='run.failed'?failure.data.error:null,error);
});

test('durable failed-run replay keeps the legacy generic envelope when no error was stored',()=>{
  const events=durableReplayEvents(run.id,{run,assistant}),failure=events.at(-1);
  assert.deepEqual(events.map(event=>event.event),['run.created','run.failed']);
  assert.deepEqual(failure?.event==='run.failed'?failure.data.error:null,{code:'INTERNAL_ERROR',message:'The model request could not be completed',requestId:run.id,retryable:false});
  assert.equal(failure?.event==='run.failed'?failure.data.partialMessageId:null,assistant.id);
});

test('durable failed-run replay preserves a stored outbound notice and null partial message id',()=>{
  const error={code:'GATE_BLOCKED' as const,message:'The request was blocked by policy',requestId:'request-1',retryable:false};
  const gateNotice={runId:run.id,direction:'outbound' as const,action:'block' as const,decisionId:'decision-1',protectedItemCount:3,message:'Request was not sent.'};
  const events=durableReplayEvents(run.id,{run,assistant,error,partialMessageId:null,gateNotice});
  assert.deepEqual(events,[
    {event:'run.created',data:{run}},
    {event:'gate.notice',data:gateNotice},
    {event:'run.failed',data:{runId:run.id,error,partialMessageId:null}},
  ]);
});
