// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClientError, apiFetch } from './api.js';

const apiError = (message='Session expired') => new Response(JSON.stringify({
  error:{code:'SESSION_EXPIRED',message,requestId:'request-id',retryable:false},
}),{status:401,headers:{'Content-Type':'application/json'}});

const invalidCredentials = () => new Response(JSON.stringify({
  error:{code:'INVALID_CREDENTIALS',message:'Current password is invalid',requestId:'request-id',retryable:false},
}),{status:401,headers:{'Content-Type':'application/json'}});

const json = (body:unknown) => new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});

test('concurrent 401 responses share one refresh and each original request retries once', async () => {
  const originalFetch = globalThis.fetch;
  const attempts = new Map<string,number>();
  const refreshCalls:RequestInit[] = [];
  let releaseRefresh:(response:Response)=>void = () => {};
  let markRefreshStarted:()=>void = () => {};
  const refreshStarted = new Promise<void>(resolve => { markRefreshStarted=resolve; });

  globalThis.fetch = async (input,init={}) => {
    const url = String(input);
    if (url === '/api/v1/auth/refresh') {
      refreshCalls.push(init);
      markRefreshStarted();
      return new Promise<Response>(resolve => { releaseRefresh=resolve; });
    }
    const count = (attempts.get(url) ?? 0) + 1;
    attempts.set(url,count);
    return count === 1 ? apiError() : json({url});
  };

  try {
    const requests = Promise.all([
      apiFetch<{url:string}>('/api/v1/projects'),
      apiFetch<{url:string}>('/api/v1/models'),
    ]);
    await refreshStarted;
    assert.equal(attempts.get('/api/v1/projects'),1);
    assert.equal(attempts.get('/api/v1/models'),1);
    assert.equal(refreshCalls.length,1);
    releaseRefresh(json({expiresAt:'later'}));
    assert.deepEqual(await requests,[{url:'/api/v1/projects'},{url:'/api/v1/models'}]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts.get('/api/v1/projects'),2);
  assert.equal(attempts.get('/api/v1/models'),2);
  const refresh = refreshCalls[0]!;
  assert.equal(refresh.method,'POST');
  assert.equal(refresh.body,'{}');
  assert.equal(refresh.credentials,'include');
  assert.match(new Headers(refresh.headers).get('Idempotency-Key') ?? '',/^[0-9a-f-]{36}$/i);
});

test('a retried mutation preserves its body, caller headers, and idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  const mutationCalls:RequestInit[] = [];
  const refreshKeys:string[] = [];
  globalThis.fetch = async (input,init={}) => {
    if (String(input) === '/api/v1/auth/refresh') {
      refreshKeys.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
      return json({expiresAt:'later'});
    }
    mutationCalls.push(init);
    return mutationCalls.length === 1 ? apiError() : json({saved:true});
  };

  try {
    assert.deepEqual(await apiFetch('/api/v1/projects/project-1',{
      method:'PATCH',
      headers:{'Idempotency-Key':'mutation-key','If-Match':'"7"','X-Trace':'trace-1'},
      body:'{"name":"Policy workspace"}',
    }),{saved:true});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(mutationCalls.length,2);
  for (const call of mutationCalls) {
    const headers = new Headers(call.headers);
    assert.equal(call.method,'PATCH');
    assert.equal(call.body,'{"name":"Policy workspace"}');
    assert.equal(headers.get('Idempotency-Key'),'mutation-key');
    assert.equal(headers.get('If-Match'),'"7"');
    assert.equal(headers.get('X-Trace'),'trace-1');
  }
  assert.equal(refreshKeys.length,1);
  assert.match(refreshKeys[0]!,/^[0-9a-f-]{36}$/i);
  assert.notEqual(refreshKeys[0],'mutation-key');
});

test('refresh failure returns the original 401 without a retry or refresh loop', async () => {
  const originalFetch = globalThis.fetch;
  let ordinaryCalls = 0;
  let refreshCalls = 0;
  globalThis.fetch = async input => {
    if (String(input) === '/api/v1/auth/refresh') { refreshCalls += 1; return apiError('Refresh expired'); }
    ordinaryCalls += 1;
    return apiError('Access expired');
  };
  try {
    await assert.rejects(apiFetch('/api/v1/models'),error => error instanceof ApiClientError && error.status === 401 && error.message === 'Access expired');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(ordinaryCalls,1);
  assert.equal(refreshCalls,1);
});

test('a 401 after successful refresh is returned after exactly one retry', async () => {
  const originalFetch = globalThis.fetch;
  let ordinaryCalls = 0;
  let refreshCalls = 0;
  globalThis.fetch = async input => {
    if (String(input) === '/api/v1/auth/refresh') { refreshCalls += 1; return json({expiresAt:'later'}); }
    ordinaryCalls += 1;
    return apiError();
  };
  try {
    await assert.rejects(apiFetch('/api/v1/models'),error => error instanceof ApiClientError && error.status === 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(ordinaryCalls,2);
  assert.equal(refreshCalls,1);
});

test('auth bootstrap endpoints never trigger session refresh', async () => {
  const originalFetch = globalThis.fetch;
  const called:string[] = [];
  globalThis.fetch = async input => { called.push(String(input)); return apiError(); };
  try {
    for (const path of ['/api/v1/auth/login','/api/v1/auth/refresh','/api/v1/auth/me']) {
      await assert.rejects(apiFetch(path),error => error instanceof ApiClientError && error.status === 401);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(called,['/api/v1/auth/login','/api/v1/auth/refresh','/api/v1/auth/me']);
});

test('an operation-specific 401 is returned without refresh or a login redirect',async()=>{
  const originalFetch=globalThis.fetch;
  const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  const assigned:string[]=[];let calls=0;
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://chat.example.test',pathname:'/settings',search:'',assign:(target:string)=>assigned.push(target)}});
  globalThis.fetch=async()=>{calls++;return invalidCredentials()};
  try {
    await assert.rejects(apiFetch('/api/v1/auth/password/change',{method:'POST',body:'{}'}),error=>error instanceof ApiClientError&&error.status===401&&error.body.error.code==='INVALID_CREDENTIALS');
  } finally {
    globalThis.fetch=originalFetch;
    if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;
  }
  assert.equal(calls,1);
  assert.deepEqual(assigned,[]);
});

test('a final protected 401 redirects once and preserves the current deep link',async()=>{
  const originalFetch=globalThis.fetch;
  const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  const assigned:string[]=[];
  Object.defineProperty(globalThis,'location',{configurable:true,value:{
    origin:'https://chat.example.test',pathname:'/projects/project-1',search:'?tab=files',
    assign:(target:string)=>assigned.push(target),
  }});
  globalThis.fetch=async()=>apiError();
  try {
    await assert.rejects(apiFetch('/api/v1/projects/project-1'),error=>error instanceof ApiClientError&&error.status===401);
    // A sibling protected request must not schedule a second navigation while the first is pending.
    await assert.rejects(apiFetch('/api/v1/models'),error=>error instanceof ApiClientError&&error.status===401);
    // Login failures are expected validation responses, not expired protected sessions.
    await assert.rejects(apiFetch('/api/v1/auth/login',{method:'POST',body:'{}'}),error=>error instanceof ApiClientError&&error.status===401);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);
    else delete globalThis.location;
  }
  assert.deepEqual(assigned,['/login?returnTo=%2Fprojects%2Fproject-1%3Ftab%3Dfiles']);
});
