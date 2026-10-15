import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {Hono} from 'hono';
import {createIdentityService,type IdentityAuditInput} from './app/identity/service.js';
import {actorIpHmac,createAuditService} from './lib/audit/index.js';
import {verifiedClientAddress} from './lib/http/client-ip.js';
import type {AppVariables} from './lib/http/index.js';
import {hashPassword} from './lib/identity/password.js';
import {runMigrations} from './lib/migrations/index.js';
import {routeDefinitions} from './routes/catalog.js';
import {mountDefinitions} from './routes/http.js';
import type {TenantId} from './shared/types.js';
import {provisionTestTenant} from './test/tenant-fixture.js';

test('an unmapped identity action records its rejection and preserves the legacy fallback',async()=>{
  process.env.DB_PATH=':memory:';
  const [{audit,createIdentityAuditAdapter},{db}]=await Promise.all([import('./integration-services.js'),import('./lib/db.js')]);
  const tenant=provisionTestTenant(db,{email:`owner@identity-gap-${randomUUID()}.test`,name:'Identity Gap',now:1_700_000_000_000}),tenantId=tenant.tenantId as TenantId;
  const originalError=console.error;let message='';console.error=(...values:unknown[])=>{message=values.map(String).join(' ')};
  try{
    createIdentityAuditAdapter(audit).append({tenantId,action:'auth.future_action',actorUserId:tenant.ownerUserId,actorSessionId:'session-1',requestId:'request-1',targetId:'target-1',clientIp:null,userAgent:null,metadata:{detail:'retained'}});
  }finally{console.error=originalError;}
  assert.match(message,/AUDIT MAPPING GAP/);
  const rows=db.prepare("SELECT action,metadata_json FROM audit_events WHERE tenant_id=? AND action IN ('system.unknown_action_rejected','identity.session_created') ORDER BY sequence").all(tenantId) as Array<{action:string;metadata_json:string}>;
  assert.deepEqual(rows.map(row=>[row.action,JSON.parse(row.metadata_json)]),[
    ['system.unknown_action_rejected',{source:'integration-services.IDENTITY_ACTIONS',suppliedAction:'auth.future_action'}],
    ['identity.session_created',{detail:'retained',identityAction:'auth.future_action'}],
  ]);
  db.close();
});

test('identity HTTP audit accepts only verified client addresses and stores their HMAC with the user agent',async()=>{
  process.env.DB_PATH=':memory:';
  const {createIdentityAuditAdapter}=await import('./integration-services.js');
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const at=1_700_000_000_000,password='correct horse battery staple',email=`owner@identity-http-${randomUUID()}.test`;
  const provisioned=provisionTestTenant(database,{email,name:'Identity HTTP',now:at,passwordHash:await hashPassword(password)}),tenantId=provisioned.tenantId as TenantId;
  const ipKey=Buffer.alloc(32,17),peer='198.51.100.23',forwarded='2001:db8::42',spoofedProxy='203.0.113.99',spoofedInternal='192.0.2.88';
  const directUserAgent='Gateway direct attribution test/1.0',proxyUserAgent='Gateway proxy attribution test/1.0',unknownUserAgent='Gateway unknown attribution test/1.0';
  const productAudit=createAuditService({database,ipHmacKey:ipKey,transcriptKey:()=>Buffer.alloc(32,18),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:at}),now:()=>at});
  const adapter=createIdentityAuditAdapter(productAudit),adapterInputs:IdentityAuditInput[]=[];
  const identity=createIdentityService({database,jwtSecret:'j'.repeat(32),encryptionKey:{id:'test',key:Buffer.alloc(32,19)},recoveryPepper:'pepper',appOrigin:'https://app.test',audit:{append(input){adapterInputs.push(input);adapter.append(input);}},now:()=>at});
  const app=new Hono<{Variables:AppVariables}>();
  let socketPeer=peer;
  app.use('*',async(c,next)=>{
    c.set('requestId','identity-http-attribution');
    c.set('verifiedClientIp',verifiedClientAddress({peer:socketPeer,forwarded:c.req.header('X-Gateway-Proxy-Client-IP'),suppliedSecret:c.req.header('X-Gateway-Proxy-Secret'),trustedProxySecret:'real-proxy-secret'}));
    await next();
  });
  const v1=new Hono<{Variables:AppVariables}>();
  mountDefinitions(v1,{async execute(operation,request){return await identity.execute(operation,request)??{status:501};}},routeDefinitions);
  app.route('/api/v1',v1);

  const directResponse=await app.request('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':directUserAgent,
    'X-Gateway-Proxy-Client-IP':spoofedProxy,'X-Gateway-Proxy-Secret':'wrong-proxy-secret','X-Gateway-Client-IP':spoofedInternal},body:JSON.stringify({email,password})});
  assert.equal(directResponse.status,200);
  const proxyResponse=await app.request('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':proxyUserAgent,
    'X-Gateway-Proxy-Client-IP':forwarded,'X-Gateway-Proxy-Secret':'real-proxy-secret'},body:JSON.stringify({email,password})});
  assert.equal(proxyResponse.status,200);
  socketPeer='not-an-address';
  const unknownResponse=await app.request('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':unknownUserAgent},body:JSON.stringify({email,password})});
  assert.equal(unknownResponse.status,200);

  assert.deepEqual(adapterInputs.map(input=>({clientIp:input.clientIp,userAgent:input.userAgent})),[
    {clientIp:peer,userAgent:directUserAgent},{clientIp:forwarded,userAgent:proxyUserAgent},{clientIp:null,userAgent:unknownUserAgent},
  ]);
  const rows=database.prepare("SELECT actor_ip_hmac,actor_user_agent,request_id,metadata_json FROM audit_events WHERE tenant_id=? AND action='identity.login_succeeded' ORDER BY sequence").all(tenantId) as Array<{actor_ip_hmac:string|null;actor_user_agent:string;request_id:string;metadata_json:string}>;
  assert.deepEqual(rows.map(row=>row.actor_ip_hmac),[actorIpHmac(ipKey,tenantId,peer),actorIpHmac(ipKey,tenantId,forwarded),null]);
  assert.notEqual(rows[0]!.actor_ip_hmac,actorIpHmac(ipKey,tenantId,spoofedProxy));
  assert.notEqual(rows[0]!.actor_ip_hmac,actorIpHmac(ipKey,tenantId,spoofedInternal));
  assert.deepEqual(rows.map(row=>row.actor_user_agent),[directUserAgent,proxyUserAgent,unknownUserAgent]);
  assert.deepEqual(rows.map(row=>row.request_id),['identity-http-attribution','identity-http-attribution','identity-http-attribution']);
  for(const row of rows){
    assert.deepEqual(JSON.parse(row.metadata_json),{identityAction:'auth.login_succeeded',mfaRequired:false});
    assert.doesNotMatch(row.metadata_json,new RegExp(`${peer}|${forwarded}|${spoofedProxy}|${spoofedInternal}|real-proxy-secret`,'u'),'raw addresses and proxy secrets do not belong in audit metadata');
  }
  database.close();
});
