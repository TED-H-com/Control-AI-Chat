import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations/index.js';
import { clearTenantProviderCredential,deriveProviderCredentialKey,openProviderCredential,rewrapTenantProviderCredentials,sealProviderCredential,setTenantProviderCredential,TenantProviderRegistry } from './tenant-registry.js';

const key=Buffer.alloc(32,7),otherKey=Buffer.alloc(32,8);
test('provider credentials are authenticated to tenant and provider',()=>{
  const sealed=sealProviderCredential({tenantId:'tenant-a',provider:'openai',secret:'sk-private-value',key});
  assert.equal(openProviderCredential({tenantId:'tenant-a',provider:'openai',ciphertext:sealed,key}),'sk-private-value');
  assert.throws(()=>openProviderCredential({tenantId:'tenant-b',provider:'openai',ciphertext:sealed,key}));
  assert.throws(()=>openProviderCredential({tenantId:'tenant-a',provider:'anthropic',ciphertext:sealed,key}));
  assert.throws(()=>openProviderCredential({tenantId:'tenant-a',provider:'openai',ciphertext:sealed,key:otherKey}));
});

test('provider credentials cannot be opened with an audit-root-derived key',()=>{
  const providerKey=deriveProviderCredentialKey('provider-root',1),auditKey=createHash('sha256').update('provider-credential:audit-root').digest();
  const sealed=sealProviderCredential({tenantId:'tenant-a',provider:'openai',secret:'sk-private-value',key:providerKey,keyVersion:1});
  assert.throws(()=>openProviderCredential({tenantId:'tenant-a',provider:'openai',ciphertext:sealed,key:auditKey,keyVersion:1}));
});

test('tenant BYOK is write-only, isolated, and clearing it disables the provider',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantA=randomUUID(),tenantB=randomUUID(),at=1_700_000_000_000;
  for(const [id,slug] of [[tenantA,'tenant-a'],[tenantB,'tenant-b']])database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(id,slug,slug,at,at);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,config_json,created_at,updated_at) VALUES(?,?,?,1,'environment','{}',?,?)").run(randomUUID(),tenantB,'openai',at,at);
  const shown=setTenantProviderCredential(database,{tenantId:tenantA,provider:'openai',secret:'sk-tenant-a-secret',key,now:at});assert.deepEqual(shown,{source:'byok',maskedSuffix:'cret'});
  const row=database.prepare('SELECT credential_source,credential_ciphertext,config_json FROM provider_config WHERE tenant_id=?').get(tenantA) as {credential_source:string;credential_ciphertext:string;config_json:string};
  assert.equal(row.credential_source,'encrypted');assert.doesNotMatch(row.credential_ciphertext,/tenant-a-secret/);assert.deepEqual(JSON.parse(row.config_json),{maskedSuffix:'cret'});
  const resolver=new TenantProviderRegistry({database,credentialKey:key});
  const first=resolver.get(tenantA,'openai');assert.equal(first.configured,true);assert.strictEqual(resolver.get(tenantA,'openai'),first,'the same credential version must retain its circuit-breaker instance');
  setTenantProviderCredential(database,{tenantId:tenantA,provider:'openai',secret:'sk-tenant-a-rotated',key,now:at});
  const rotated=resolver.get(tenantA,'openai');assert.notStrictEqual(rotated,first,'credential rotation must invalidate the cached provider even inside the same millisecond');assert.strictEqual(resolver.get(tenantA,'openai'),rotated);
  assert.throws(()=>resolver.get(tenantB,'openai'),/not configured/);
  assert.equal(clearTenantProviderCredential(database,{tenantId:tenantA,provider:'openai',now:at+1}),true);
  assert.throws(()=>resolver.get(tenantA,'openai'),/not configured/);
  assert.deepEqual(database.prepare('SELECT enabled,credential_source,credential_ciphertext,key_version,config_json FROM provider_config WHERE tenant_id=?').get(tenantA),{enabled:0,credential_source:'encrypted',credential_ciphertext:null,key_version:null,config_json:'{}'});
  database.close();
});

test('credential rotation is versioned and atomic per workspace',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);const tenant=randomUUID(),at=1_700_000_000_000;
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Tenant','active',?,?)").run(tenant,'rotation',at,at);
  setTenantProviderCredential(database,{tenantId:tenant,provider:'openai',secret:'sk-first-key',key,keyVersion:1,now:at});
  assert.equal(rewrapTenantProviderCredentials(database,{tenantId:tenant,keyring:{currentVersion:2,keys:new Map([[1,key],[2,otherKey]])},now:at+1}),1);
  const row=database.prepare('SELECT credential_ciphertext,key_version FROM provider_config WHERE tenant_id=?').get(tenant) as {credential_ciphertext:string;key_version:number};
  assert.equal(row.key_version,2);assert.equal(openProviderCredential({tenantId:tenant,provider:'openai',ciphertext:row.credential_ciphertext,key:otherKey,keyVersion:2}),'sk-first-key');
  const before=row.credential_ciphertext;assert.throws(()=>rewrapTenantProviderCredentials(database,{tenantId:tenant,keyring:{currentVersion:3,keys:new Map([[3,key]])}}),/version 2 is unavailable/);
  assert.deepEqual(database.prepare('SELECT credential_ciphertext,key_version FROM provider_config WHERE tenant_id=?').get(tenant),{credential_ciphertext:before,key_version:2});database.close();
});
