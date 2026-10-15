// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test'; import assert from 'node:assert/strict'; import { ChatHttpError,parseSse, streamRequest } from './stream.js';
import {ApiClientError} from '../api.js';
test('parser handles split UTF-8 and CRLF frames',async()=>{const bytes=new TextEncoder().encode('id: 1\r\nevent: run.status\r\ndata: {"runId":"r","status":"streaming"}\r\n\r\n');const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.slice(0,9));c.enqueue(bytes.slice(9));c.close()}});const events=[];for await(const event of parseSse(stream))events.push(event);assert.equal(events.length,1);assert.equal(events[0]?.id,1);assert.equal(events[0]?.event.event,'run.status')});

test('a run request carries the Idempotency-Key the server requires',async()=>{
  // Without it the server answers 400 `Idempotency-Key is required`, so no message sent from a
  // browser ever reached a model. Every run route is declared idempotency:true, and every caller
  // already mints a clientRequestId, so the key must be that value — a fresh uuid per attempt would
  // bill a retried message twice. Asserting on the header the browser would actually send, because
  // the same call made by hand with a header added is what kept reporting the surface as healthy.
  const originalFetch=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(_url,init)=>{seen.push(new Headers(init.headers));
    return {ok:true,body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('id: 1\nevent: run.status\ndata: {"runId":"r","status":"awaiting_confirmation"}\n\n'));c.close()}})};};
  try {
    await streamRequest('/api/v1/chat/runs',{clientRequestId:'a1b2c3d4-0000-4000-8000-000000000000',content:'hi'},new AbortController().signal,()=>{});
    await streamRequest('/api/v1/chat/runs',{content:'hi'},new AbortController().signal,()=>{});
  } finally { globalThis.fetch=originalFetch; }
  assert.equal(seen[0].get('Idempotency-Key'),'a1b2c3d4-0000-4000-8000-000000000000');
  assert.match(seen[1].get('Idempotency-Key')??'',/^[0-9a-f-]{36}$/,'a body with no clientRequestId still needs a key');
});

test('a stream setup retries once after refresh without changing its body or idempotency key',async()=>{
  const originalFetch=globalThis.fetch;
  const streamCalls=[];const refreshCalls=[];const events=[];
  globalThis.fetch=async(input,init={})=>{
    if(String(input)==='/api/v1/auth/refresh'){
      refreshCalls.push(init);
      return new Response(JSON.stringify({expiresAt:'later'}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    streamCalls.push(init);
    if(streamCalls.length===1)return new Response(JSON.stringify({error:{code:'SESSION_EXPIRED',message:'Expired',requestId:'request-id',retryable:false}}),{status:401,headers:{'Content-Type':'application/json'}});
    return new Response('id: 1\nevent: run.status\ndata: {"runId":"run-1","status":"awaiting_confirmation"}\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  };
  try {
    await streamRequest('/api/v1/chat/runs',{clientRequestId:'stream-request-key',content:'hi'},new AbortController().signal,event=>events.push(event));
  } finally { globalThis.fetch=originalFetch; }

  assert.equal(refreshCalls.length,1);
  assert.equal(streamCalls.length,2);
  assert.equal(streamCalls[0].body,streamCalls[1].body);
  assert.equal(streamCalls[0].body,'{"clientRequestId":"stream-request-key","content":"hi"}');
  assert.equal(new Headers(streamCalls[0].headers).get('Idempotency-Key'),'stream-request-key');
  assert.equal(new Headers(streamCalls[1].headers).get('Idempotency-Key'),'stream-request-key');
  assert.notEqual(new Headers(refreshCalls[0].headers).get('Idempotency-Key'),'stream-request-key');
  assert.equal(events[0]?.event,'run.status');
});

test('a non-terminal EOF rejects instead of leaving the composer busy forever',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('id: 1\nevent: run.status\ndata: {"runId":"run-1","status":"streaming"}\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  try {
    await assert.rejects(streamRequest('/api/v1/chat/runs',{clientRequestId:'live-run',content:'hi'},new AbortController().signal,()=>{}),/before a terminal state/);
  } finally { globalThis.fetch=originalFetch; }
});

test('a pre-stream JSON refusal preserves the API error envelope',async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'BUDGET_HARD_LIMIT',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false}}),{status:422,headers:{'Content-Type':'application/json'}});
 try {await assert.rejects(streamRequest('/api/v1/chat/runs',{clientRequestId:'budget',content:'hi'},new AbortController().signal,()=>{}),error=>error instanceof ApiClientError&&error.status===422&&error.body.error.code==='BUDGET_HARD_LIMIT');}
 finally{globalThis.fetch=originalFetch;}
});

test('a non-JSON chat refusal preserves only its HTTP status',async()=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('gateway unavailable',{status:502,headers:{'Content-Type':'text/plain'}});
 try {await assert.rejects(streamRequest('/api/v1/chat/runs',{clientRequestId:'proxy',content:'hi'},new AbortController().signal,()=>{}),error=>error instanceof ChatHttpError&&error.status===502);}
 finally{globalThis.fetch=originalFetch;}
});
