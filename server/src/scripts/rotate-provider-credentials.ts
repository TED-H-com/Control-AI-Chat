import { db } from '../lib/db.js';
import { config } from '../config.js';
import { deriveProviderCredentialKey,rewrapTenantProviderCredentials } from '../lib/providers/tenant-registry.js';

const requested=process.argv.slice(2),tenantFlag=requested.indexOf('--tenant');
if(tenantFlag!==-1&&(!requested[tenantFlag+1]||requested[tenantFlag+1]!.startsWith('--')))throw new Error('--tenant requires a workspace id');
const keys=new Map<number,Uint8Array>(Object.entries(config.providerCredentialPreviousKeys).map(([version,root])=>[Number(version),deriveProviderCredentialKey(root,Number(version))]));
keys.set(config.providerCredentialKeyVersion,deriveProviderCredentialKey(config.providerCredentialKey,config.providerCredentialKeyVersion));
const tenants=tenantFlag===-1
  ?db.prepare<[],{id:string}>("SELECT DISTINCT tenant_id id FROM provider_config WHERE credential_source='encrypted' AND credential_ciphertext IS NOT NULL ORDER BY tenant_id").all().map(row=>row.id)
  :[requested[tenantFlag+1]!];
let rotated=0;
try{
  for(const tenantId of tenants)rotated+=rewrapTenantProviderCredentials(db,{tenantId,keyring:{currentVersion:config.providerCredentialKeyVersion,keys}});
  console.log(JSON.stringify({status:'ok',workspaces:tenants.length,credentialsRotated:rotated,keyVersion:config.providerCredentialKeyVersion}));
}finally{db.close();}
