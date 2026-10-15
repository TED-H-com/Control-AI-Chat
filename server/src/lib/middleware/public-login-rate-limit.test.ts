import assert from 'node:assert/strict';
import test from 'node:test';
import {Hono} from 'hono';
import {verifiedClientAddress} from '../http/client-ip.js';
import type {AppVariables} from '../http/index.js';
import {PublicLoginIpLimiter,publicLoginRateLimit} from './public-login-rate-limit.js';

const proxySecret='proxy-secret-that-is-long-enough-for-a-test';

function appWithBoundary(limiter:PublicLoginIpLimiter,now:()=>number):Hono<{Variables:AppVariables}>{
 const app=new Hono<{Variables:AppVariables}>();
 app.use('*',async(c,next)=>{
  c.set('requestId','login-rate-request');
  c.set('verifiedClientIp',verifiedClientAddress({peer:'172.20.0.3',forwarded:c.req.header('X-Gateway-Proxy-Client-IP'),suppliedSecret:c.req.header('X-Gateway-Proxy-Secret'),trustedProxySecret:proxySecret}));
  await next();
 });
 app.use('/api/v1/auth/login',publicLoginRateLimit({limiter,now}));
 app.post('/api/v1/auth/login',c=>c.json({ok:true}));app.post('/api/v1/auth/other',c=>c.json({ok:true}));
 return app;
}

const login=(app:Hono<{Variables:AppVariables}>,headers:Record<string,string>={})=>app.request('/api/v1/auth/login',{method:'POST',headers});

test('the default public-login budget is thirty requests per fixed minute',()=>{
 const limiter=new PublicLoginIpLimiter();for(let attempt=0;attempt<30;attempt++)assert.equal(limiter.consume('203.0.113.8',0).allowed,true);
 const denied=limiter.consume('203.0.113.8',0);assert.deepEqual(denied,{allowed:false,limit:30,remaining:0,retryAfterSeconds:60});
});

test('spoofed proxy addresses share the verified socket-peer login bucket',async()=>{
 const at=1_800_000_000_000,app=appWithBoundary(new PublicLoginIpLimiter({limit:2}),()=>at);
 assert.equal((await login(app,{'X-Gateway-Proxy-Client-IP':'203.0.113.8'})).status,200);
 assert.equal((await login(app,{'X-Gateway-Proxy-Client-IP':'198.51.100.9','X-Gateway-Proxy-Secret':'wrong'})).status,200);
 const denied=await login(app,{'X-Gateway-Proxy-Client-IP':'192.0.2.10'});
 assert.equal(denied.status,429);assert.equal(denied.headers.get('Retry-After'),'60');assert.equal(denied.headers.get('X-RateLimit-Limit'),'2');assert.equal(denied.headers.get('X-RateLimit-Remaining'),'0');
 assert.equal(denied.headers.get('X-API-Version'),'1');
 const body=await denied.text();assert.doesNotMatch(body,/172\.20\.0\.3|192\.0\.2\.10|203\.0\.113\.8|198\.51\.100\.9/u);assert.deepEqual(JSON.parse(body),{error:{code:'RATE_LIMITED',message:'Request rate limit exceeded',requestId:'login-rate-request',retryable:true}});
});

test('an authenticated proxy assertion selects the forwarded client bucket',async()=>{
 const at=1_800_000_000_000,app=appWithBoundary(new PublicLoginIpLimiter({limit:1}),()=>at),trusted=(address:string)=>({'X-Gateway-Proxy-Client-IP':address,'X-Gateway-Proxy-Secret':proxySecret});
 assert.equal((await login(app,trusted('203.0.113.8'))).status,200);
 assert.equal((await login(app,trusted('198.51.100.9'))).status,200,'a different verified client has an independent bucket');
 assert.equal((await login(app,trusted('203.0.113.8'))).status,429);
});

test('the fixed-window map cleans up on time, stays capped, and fails safely into one overflow bucket',()=>{
 const limiter=new PublicLoginIpLimiter({limit:2,windowMs:1_000,maxEntries:2});
 assert.equal(limiter.consume('198.51.100.1',0).allowed,true);assert.equal(limiter.consume('198.51.100.2',0).allowed,true);assert.equal(limiter.trackedEntries,2);
 assert.equal(limiter.consume('198.51.100.3',0).allowed,true);assert.equal(limiter.consume('198.51.100.4',0).allowed,true);assert.equal(limiter.consume('198.51.100.5',0).allowed,false,'untracked addresses share a bounded overflow budget');assert.equal(limiter.trackedEntries,2);
 assert.equal(limiter.consume('198.51.100.6',1_000).allowed,true);assert.equal(limiter.trackedEntries,1,'the new fixed window discards prior address keys');
});

test('unknown peers share one bucket and non-login routes are not throttled',async()=>{
 const limiter=new PublicLoginIpLimiter({limit:1}),app=new Hono<{Variables:AppVariables}>();app.use('/api/v1/auth/login',publicLoginRateLimit({limiter,now:()=>1_800_000_000_000}));app.post('/api/v1/auth/login',c=>c.json({ok:true}));app.post('/api/v1/auth/other',c=>c.json({ok:true}));
 assert.equal((await login(app)).status,200);assert.equal((await login(app)).status,429);
 for(let attempt=0;attempt<40;attempt++)assert.equal((await app.request('/api/v1/auth/other',{method:'POST'})).status,200);
 assert.equal(limiter.trackedEntries,1);
});

test('forgot and reset use independent public rate-limit instances on their own paths',async()=>{
 const app=new Hono<{Variables:AppVariables}>(),at=1_800_000_000_000;
 app.use('*',async(c,next)=>{c.set('requestId','credential-rate-request');c.set('verifiedClientIp','203.0.113.8');await next()});
 app.use('/api/v1/auth/password/forgot',publicLoginRateLimit({limiter:new PublicLoginIpLimiter({limit:1}),now:()=>at,path:'/api/v1/auth/password/forgot'}));
 app.use('/api/v1/auth/password/reset',publicLoginRateLimit({limiter:new PublicLoginIpLimiter({limit:1}),now:()=>at,path:'/api/v1/auth/password/reset'}));
 app.post('/api/v1/auth/password/forgot',c=>c.json({accepted:true},202));app.post('/api/v1/auth/password/reset',c=>c.json({changed:true}));
 for(const path of ['/api/v1/auth/password/forgot','/api/v1/auth/password/reset']){
  assert.notEqual((await app.request(path,{method:'POST'})).status,429,path);
  assert.equal((await app.request(path,{method:'POST'})).status,429,path);
 }
});
