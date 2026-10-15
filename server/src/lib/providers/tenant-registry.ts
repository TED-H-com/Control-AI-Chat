import { createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ProviderRegistry, PROVIDERS } from './registry.js';
import type { ChatProvider,ProviderId } from './types.js';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';

const NONCE_BYTES=12,TAG_BYTES=16;
type CredentialRow={credential_source:'environment'|'encrypted';credential_ciphertext:string|null;key_version:number|null;enabled:number;base_url:string|null;workspace_name:string};
type CacheEntry={credentialCiphertext:string;keyVersion:number;baseUrl:string|null;provider:ChatProvider};
type CacheInvalidator=(tenantId:string,provider:ProviderId)=>void;
export type ProviderCredentialKeyring={readonly currentVersion:number;readonly keys:ReadonlyMap<number,Uint8Array>};
export const deriveProviderCredentialKey=(root:string,version:number):Buffer=>createHash('sha256').update(`provider-credential:v${version}:${root}`).digest();

const invalidators=new WeakMap<Database.Database,Set<CacheInvalidator>>();
function invalidate(database:Database.Database,tenantId:string,provider:ProviderId):void {for(const callback of invalidators.get(database)??[])callback(tenantId,provider);}
function cacheKey(tenantId:string,provider:ProviderId):string{return `${tenantId}\0${provider}`;}
function key32(key:Uint8Array):Buffer{if(key.byteLength!==32)throw new TypeError('Provider credential key must be 32 bytes');return Buffer.from(key);}
function versionByte(version:number):number{if(!Number.isSafeInteger(version)||version<1||version>255)throw new TypeError('Provider credential key version must be between 1 and 255');return version;}
function aad(tenantId:string,provider:ProviderId,version:number):Buffer{return Buffer.from(`${CRYPTO_NAMESPACE}:provider-credential:v${version}:${tenantId}:${provider}`,'utf8');}

export function sealProviderCredential(input:{tenantId:string;provider:ProviderId;secret:string;key:Uint8Array;keyVersion?:number}):string{
  const secret=input.secret.trim(),version=versionByte(input.keyVersion??1);if(secret.length<8||secret.length>10_000)throw new TypeError('Provider credential must be between 8 and 10000 characters');
  const nonce=randomBytes(NONCE_BYTES),cipher=createCipheriv('aes-256-gcm',key32(input.key),nonce);cipher.setAAD(aad(input.tenantId,input.provider,version));
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]),tag=cipher.getAuthTag();
  return Buffer.concat([Buffer.from([version]),nonce,tag,ciphertext]).toString('base64url');
}

export function openProviderCredential(input:{tenantId:string;provider:ProviderId;ciphertext:string;key:Uint8Array;keyVersion?:number}):string{
  const packed=Buffer.from(input.ciphertext,'base64url'),version=packed[0],expected=input.keyVersion??version;
  if(packed.length<=1+NONCE_BYTES+TAG_BYTES||version===undefined||version!==expected)throw new Error('Unsupported provider credential envelope');
  const nonce=packed.subarray(1,1+NONCE_BYTES),tag=packed.subarray(1+NONCE_BYTES,1+NONCE_BYTES+TAG_BYTES),body=packed.subarray(1+NONCE_BYTES+TAG_BYTES);
  const decipher=createDecipheriv('aes-256-gcm',key32(input.key),nonce);decipher.setAAD(aad(input.tenantId,input.provider,version));decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8');
}

export function setTenantProviderCredential(database:Database.Database,input:{tenantId:string;provider:ProviderId;secret:string;key:Uint8Array;keyVersion?:number;baseUrl?:string|null;now?:number}):{source:'byok';maskedSuffix:string}{
  const at=input.now??Date.now(),keyVersion=input.keyVersion??1,ciphertext=sealProviderCredential({...input,keyVersion}),suffix=input.secret.trim().slice(-4),metadata=JSON.stringify({maskedSuffix:suffix});
  database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,base_url,config_json,created_at,updated_at)
    VALUES(?,?,?,1,'encrypted',?,?,?,?,?,?)
    ON CONFLICT(tenant_id,provider_key) DO UPDATE SET enabled=1,credential_source='encrypted',credential_ciphertext=excluded.credential_ciphertext,key_version=excluded.key_version,
      base_url=excluded.base_url,config_json=json_set(COALESCE(provider_config.config_json,'{}'),'$.maskedSuffix',?),updated_at=excluded.updated_at`)
    .run(randomUUID(),input.tenantId,input.provider,ciphertext,keyVersion,input.baseUrl??null,metadata,at,at,suffix);
  invalidate(database,input.tenantId,input.provider);return{source:'byok',maskedSuffix:suffix};
}

export function clearTenantProviderCredential(database:Database.Database,input:{tenantId:string;provider:ProviderId;now?:number}):boolean{
  const at=input.now??Date.now(),result=database.prepare(`UPDATE provider_config SET enabled=0,credential_source='encrypted',credential_ciphertext=NULL,key_version=NULL,
    config_json=json_remove(COALESCE(config_json,'{}'),'$.maskedSuffix'),updated_at=? WHERE tenant_id=? AND provider_key=?`).run(at,input.tenantId,input.provider);
  if(result.changes===1)invalidate(database,input.tenantId,input.provider);return result.changes===1;
}

export function rewrapTenantProviderCredentials(database:Database.Database,input:{tenantId:string;keyring:ProviderCredentialKeyring;now?:number}):number{
  const targetKey=input.keyring.keys.get(input.keyring.currentVersion);if(!targetKey)throw new Error(`Provider credential key version ${input.keyring.currentVersion} is unavailable`);
  const rotate=database.transaction(()=>{
    const rows=database.prepare<[string],{provider_key:ProviderId;credential_ciphertext:string;key_version:number}>(`SELECT provider_key,credential_ciphertext,key_version FROM provider_config WHERE tenant_id=? AND credential_source='encrypted' AND credential_ciphertext IS NOT NULL`).all(input.tenantId);
    const updates=rows.filter(row=>row.key_version!==input.keyring.currentVersion).map(row=>{
      const oldKey=input.keyring.keys.get(row.key_version);if(!oldKey)throw new Error(`Provider credential key version ${row.key_version} is unavailable`);
      const secret=openProviderCredential({tenantId:input.tenantId,provider:row.provider_key,ciphertext:row.credential_ciphertext,key:oldKey,keyVersion:row.key_version});
      return{...row,ciphertext:sealProviderCredential({tenantId:input.tenantId,provider:row.provider_key,secret,key:targetKey,keyVersion:input.keyring.currentVersion})};
    });
    const statement=database.prepare('UPDATE provider_config SET credential_ciphertext=?,key_version=?,updated_at=? WHERE tenant_id=? AND provider_key=? AND credential_ciphertext=? AND key_version=?');
    for(const row of updates){const result=statement.run(row.ciphertext,input.keyring.currentVersion,input.now??Date.now(),input.tenantId,row.provider_key,row.credential_ciphertext,row.key_version);if(result.changes!==1)throw new Error(`Provider credential changed during rotation: ${row.provider_key}`);}
    return updates.length;
  });
  const count=rotate.immediate();for(const provider of PROVIDERS)invalidate(database,input.tenantId,provider);return count;
}

export class TenantProviderRegistry {
  readonly #database:Database.Database;readonly #keyring:ProviderCredentialKeyring;readonly #byok=new Map<string,CacheEntry>();
  constructor(input:{database:Database.Database;credentialKey?:Uint8Array;credentialKeys?:ProviderCredentialKeyring;appOrigin?:string}){
    this.#database=input.database;this.#keyring=input.credentialKeys??{currentVersion:1,keys:new Map([[1,key32(input.credentialKey!)]])};
    const callbacks=invalidators.get(input.database)??new Set<CacheInvalidator>();callbacks.add((tenantId,provider)=>this.#byok.delete(cacheKey(tenantId,provider)));invalidators.set(input.database,callbacks);
  }
  resolve(tenantId:string,provider:ProviderId):{provider:ChatProvider;credentialSource:'platform'|'byok'}{
    const key=cacheKey(tenantId,provider),row=this.#database.prepare<[string,ProviderId],CredentialRow>('SELECT pc.credential_source,pc.credential_ciphertext,pc.key_version,pc.enabled,pc.base_url,t.name workspace_name FROM provider_config pc JOIN tenants t ON t.id=pc.tenant_id WHERE pc.tenant_id=? AND pc.provider_key=?').get(tenantId,provider);
    if(!row||row.enabled!==1||row.credential_source!=='encrypted'||!row.credential_ciphertext||!row.key_version){this.#byok.delete(key);throw new Error('Provider is not configured for this tenant');}
    const credentialKey=this.#keyring.keys.get(row.key_version);if(!credentialKey){this.#byok.delete(key);throw new Error(`Tenant provider credential key version ${row.key_version} is unavailable`);}
    const cached=this.#byok.get(key);if(cached?.keyVersion===row.key_version&&cached.credentialCiphertext===row.credential_ciphertext&&cached.baseUrl===row.base_url)return{provider:cached.provider,credentialSource:'byok'};
    const secret=openProviderCredential({tenantId,provider,ciphertext:row.credential_ciphertext,key:credentialKey,keyVersion:row.key_version});
    const appOrigin=process.env.APP_ORIGIN?.trim();const resolved=new ProviderRegistry({[provider]:secret},{[provider]:row.base_url??undefined},{...(appOrigin?{appOrigin}:{}),workspaceName:row.workspace_name}).get(provider);
    this.#byok.set(key,{credentialCiphertext:row.credential_ciphertext,keyVersion:row.key_version,baseUrl:row.base_url,provider:resolved});return{provider:resolved,credentialSource:'byok'};
  }
  get(tenantId:string,provider:ProviderId):ChatProvider{return this.resolve(tenantId,provider).provider;}
}
