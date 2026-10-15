import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Hono} from 'hono';
import {csrfProtection} from './csrf.js';
import {requestSizeLimit} from './body-limit.js';
import {applicationCsp,securityHeaders} from './security-headers.js';

test('CSRF rejects untrusted unsafe requests and permits trusted origins',async()=>{
  const app=new Hono();app.use('*',csrfProtection({allowedOrigins:new Set(['https://legacy.example.test'])}));app.post('/write',c=>c.text('ok'));
  assert.equal((await app.request('/write',{method:'POST'})).status,403);
  assert.equal((await app.request('/write',{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await app.request('/write',{method:'POST',headers:{Origin:'https://legacy.example.test'}})).status,200);
});

test('request limit measures streamed bodies',async()=>{
  const app=new Hono();app.use('*',requestSizeLimit({maxBytes:4}));app.post('/',async c=>c.text(await c.req.text()));
  assert.equal((await app.request('/',{method:'POST',body:'12345'})).status,413);
  assert.equal((await app.request('/',{method:'POST',body:'1234'})).status,200);
});

test('security middleware supplies browser controls and disables API caching',async()=>{
  const previous=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://chat.acme.example';
  const app=new Hono();app.use('*',securityHeaders());app.get('/api/value',c=>c.json({ok:true}));
  const response=await app.request('/api/value');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy')??'',/https:\/\/chat\.acme\.example/);
  assert.doesNotMatch(response.headers.get('content-security-policy')??'',/app\.example\.invalid/);
  if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;
});

test('application CSP matches the exact security contract',async()=>{
  const expected="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://chat.acme.example; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests";
  // This policy is a security contract, so a change to it must change this test in the same commit.
  const previous=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://chat.acme.example';
  try{
    const app=new Hono();app.use('*',securityHeaders());app.get('/',c=>c.text('ok'));
    const response=await app.request('/');
    assert.equal(response.headers.get('content-security-policy'),expected);
    assert.equal(applicationCsp('https://chat.acme.example'),expected);
    assert.equal(applicationCsp('https://chat.acme.example/'),expected);
  }finally{
    if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;
  }
});
