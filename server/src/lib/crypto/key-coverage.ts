import type Database from 'better-sqlite3';

/**
 * Versions this process can open for provider credentials.
 *
 * Mirrors `server/src/integration-services.ts:51-52`: every previous-key entry, then the current
 * version. `Map.set` overwrites a same-numbered previous entry, so that version stays held and the
 * current root is the one that would decrypt it.
 */
export function heldProviderCredentialVersions(previousKeys:Readonly<Record<number,string>>,currentVersion:number):ReadonlySet<number> {
  const held=new Set<number>(Object.keys(previousKeys).map(version=>Number(version)));
  held.add(currentVersion);
  return held;
}

export interface StoredKeyCoverageSource {
  readonly providerCredentialKeyVersion:number;
  readonly providerCredentialPreviousKeys:Readonly<Record<number,string>>;
}

const PROVIDER_CREDENTIAL_VERSIONS_SQL=`SELECT DISTINCT key_version FROM provider_config
 WHERE enabled=1 AND credential_source='encrypted' AND credential_ciphertext IS NOT NULL
   AND key_version IS NOT NULL`;

/** The same stored-version queries used by the startup guard, for operator inspection. */
export function storedKeyCoverageDomains():readonly {readonly name:string;readonly sql:string}[] {
  return [{name:'enabled provider credentials',sql:PROVIDER_CREDENTIAL_VERSIONS_SQL}];
}

function storedVersions(database:Database.Database,sql:string):number[] {
  const versions:number[]=[];
  for(const row of database.prepare<unknown[],{key_version:unknown}>(sql).all()){
    const version=row.key_version;
    if(typeof version!=='number'||!Number.isSafeInteger(version))throw new Error(`Refusing to start: stored key coverage read a version this process cannot hold (${JSON.stringify(version)}).`);
    versions.push(version);
  }
  return versions;
}

function missingVersions(stored:readonly number[],held:ReadonlySet<number>):number[] {
  return [...new Set(stored.filter(version=>!held.has(version)))].sort((left,right)=>left-right);
}

function refusalLine(domain:string,versions:readonly number[],versionVariable:string,previousVariable:string):string {
  const listed=versions.join(', ');
  const singular=versions.length===1;
  const named=singular?`key version ${listed}`:`key versions ${listed}`;
  const add=singular?`version ${listed}`:`versions ${listed}`;
  const current=singular
    ?`set ${versionVariable}=${listed} if version ${listed} is the current key`
    :`set ${versionVariable} to the current version if it is one of ${listed}`;
  return `Refusing to start: ${domain} name encryption ${named}, which this process does not hold. Add ${add} to ${previousVariable} (JSON object of version to root key), or ${current}.`;
}

/** Refuses to start when a stored ciphertext row names a key version this process does not hold. */
export function assertStoredKeyCoverage(database:Database.Database,source:StoredKeyCoverageSource):void {
  const failures:string[]=[];
  const providerMissing=missingVersions(storedVersions(database,PROVIDER_CREDENTIAL_VERSIONS_SQL),heldProviderCredentialVersions(source.providerCredentialPreviousKeys,source.providerCredentialKeyVersion));
  if(providerMissing.length)failures.push(refusalLine('enabled provider credentials',providerMissing,'PROVIDER_CREDENTIAL_KEY_VERSION','PROVIDER_CREDENTIAL_PREVIOUS_KEYS'));
  if(failures.length)throw new Error(failures.join('\n'));
}
