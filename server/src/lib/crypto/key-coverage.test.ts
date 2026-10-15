import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {runMigrations} from '../migrations/index.js';
import {deriveProviderCredentialKey} from '../providers/tenant-registry.js';
import {assertStoredKeyCoverage,heldProviderCredentialVersions,type StoredKeyCoverageSource} from './key-coverage.js';

const NOW=1_700_000_000_000;
const source=(version=1,previous:Readonly<Record<number,string>>={}):StoredKeyCoverageSource=>({
  providerCredentialKeyVersion:version,providerCredentialPreviousKeys:previous,
});
function refusal(error:unknown):string {
  assert.ok(error instanceof Error);
  return error.message;
}
function withDatabase(run:(database:Database.Database)=>void):void {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  try{run(database);}finally{database.close();}
}
function tenant(database:Database.Database):string {
  const id=randomUUID();database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Coverage','active',?,?)`).run(id,id.replaceAll('-',''),NOW,NOW);return id;
}
function providerRow(database:Database.Database,tenantId:string,provider:string,enabled:0|1,keyVersion:number):void {
  database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at)
    VALUES(?,?,?,?,'encrypted','sealed',?,'{}',?,?)`).run(randomUUID(),tenantId,provider,enabled,keyVersion,NOW,NOW);
}
test('held provider credentials pass the startup guard',()=>{
  withDatabase(database=>{providerRow(database,tenant(database),'openai',1,1);assert.doesNotThrow(()=>assertStoredKeyCoverage(database,source()));});
});
test('an enabled provider credential on an absent version refuses startup',()=>{
  withDatabase(database=>{
    providerRow(database,tenant(database),'openai',1,4);
    assert.throws(()=>assertStoredKeyCoverage(database,source()),(error:unknown)=>{
      assert.equal(refusal(error),'Refusing to start: enabled provider credentials name encryption key version 4, which this process does not hold. Add version 4 to PROVIDER_CREDENTIAL_PREVIOUS_KEYS (JSON object of version to root key), or set PROVIDER_CREDENTIAL_KEY_VERSION=4 if version 4 is the current key.');
      return true;
    });
  });
});
test('disabled provider credentials do not participate in coverage',()=>{
  withDatabase(database=>{const tenantId=tenant(database);providerRow(database,tenantId,'openai',1,1);providerRow(database,tenantId,'anthropic',0,4);assert.doesNotThrow(()=>assertStoredKeyCoverage(database,source()));});
});
test('previous provider versions mirror the runtime key map',()=>{
  const currentRoot='provider-current-root',previous={1:'provider-previous-root',2:'stale-current-root'},currentVersion=2;
  const keys=new Map<number,Uint8Array>(Object.entries(previous).map(([version,root])=>[Number(version),deriveProviderCredentialKey(root,Number(version))]));
  keys.set(currentVersion,deriveProviderCredentialKey(currentRoot,currentVersion));
  const held=heldProviderCredentialVersions(previous,currentVersion);
  assert.deepEqual([...held].sort((left,right)=>left-right),[...keys.keys()].sort((left,right)=>left-right));
  assert.deepEqual([...held].sort((left,right)=>left-right),[1,2]);
  const overwritten=keys.get(currentVersion);
  assert.ok(overwritten);
  assert.deepEqual(overwritten,deriveProviderCredentialKey(currentRoot,currentVersion));
  assert.notDeepEqual(overwritten,deriveProviderCredentialKey(previous[currentVersion]!,currentVersion));
});
test('a held previous provider credential version passes the startup guard',()=>{
  withDatabase(database=>{
    providerRow(database,tenant(database),'openai',1,1);
    assert.doesNotThrow(()=>assertStoredKeyCoverage(database,source(2,{1:'provider-previous-root'})));
  });
});
test('all missing provider versions are reported together',()=>{
  withDatabase(database=>{const tenantId=tenant(database);providerRow(database,tenantId,'openai',1,4);providerRow(database,tenantId,'anthropic',1,7);
    assert.throws(()=>assertStoredKeyCoverage(database,source()),(error:unknown)=>{
      assert.equal(refusal(error),'Refusing to start: enabled provider credentials name encryption key versions 4, 7, which this process does not hold. Add versions 4, 7 to PROVIDER_CREDENTIAL_PREVIOUS_KEYS (JSON object of version to root key), or set PROVIDER_CREDENTIAL_KEY_VERSION to the current version if it is one of 4, 7.');
      return true;
    });
  });
});
