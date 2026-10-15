import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import {runMigrations} from '../lib/migrations/index.js';

const script=fileURLToPath(new URL('../../dist/scripts/check-key-coverage.js',import.meta.url));
const missingProviderMessage='Refusing to start: enabled provider credentials name encryption key version 4, which this process does not hold. Add version 4 to PROVIDER_CREDENTIAL_PREVIOUS_KEYS (JSON object of version to root key), or set PROVIDER_CREDENTIAL_KEY_VERSION=4 if version 4 is the current key.\n';

function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'key-coverage-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'test.db');
  const database=new Database(path);
  database.exec('CREATE TABLE provider_config(enabled INTEGER,credential_source TEXT,credential_ciphertext TEXT,key_version INTEGER)');
  t.after(()=>database.close());
  const run=(args:string[]=[path],env:NodeJS.ProcessEnv={})=>{
    const result=spawnSync(process.execPath,[script,...args],{cwd:directory,encoding:'utf8',env:{
      PATH:process.env.PATH,NODE_ENV:'test',JWT_SECRET:'coverage-test-secret',
      DOTENV_CONFIG_PATH:join(directory,'no-dotenv'),...env,
    }});
    assert.ifError(result.error);assert.equal(result.signal,null);
    return result;
  };
  return {directory,path,database,run};
}

test('CLI lists provider versions in numeric order without changing the database',t=>{
  const f=fixture(t);
  f.database.exec("INSERT INTO provider_config VALUES(1,'encrypted','sealed',4),(1,'encrypted','sealed',1),(1,'encrypted','sealed',4)");
  const before=readFileSync(f.path);
  const result=f.run([],{DB_PATH:f.path,PROVIDER_CREDENTIAL_KEY_VERSION:'4',PROVIDER_CREDENTIAL_PREVIOUS_KEYS:'{"1":"old-provider"}'});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.equal(result.stdout,'enabled provider credentials: 1, 4\n');
  assert.deepEqual(readFileSync(f.path),before);
});

test('CLI prints an empty provider domain for a fresh database and prefers argv over DB_PATH',t=>{
  const f=fixture(t),result=f.run([f.path],{DB_PATH:join(f.directory,'missing.db')});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.equal(result.stdout,'enabled provider credentials:\n');
});

test('CLI reports a missing provider version unchanged on stderr with exit 1',t=>{
  const f=fixture(t);
  f.database.exec("INSERT INTO provider_config VALUES(1,'encrypted','sealed',4)");
  const result=f.run();
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr,missingProviderMessage);
});

test('CLI reports a missing path on stderr with exit 2',t=>{
  const result=fixture(t).run([]);
  assert.equal(result.status,2);assert.equal(result.stdout,'');
  assert.match(result.stderr,/no database path was provided/u);
});

for(const kind of ['nonexistent','directory','unreadable'] as const)test(`CLI rejects a ${kind} path with exit 2 and names it`,t=>{
  const f=fixture(t),path=kind==='directory'?f.directory:kind==='nonexistent'?join(f.directory,'missing.db'):f.path;
  if(kind==='unreadable'){
    if(process.getuid?.()===0){t.skip('root bypasses filesystem read permissions');return;}
    chmodSync(path,0);
  }
  const result=f.run([path]);
  assert.equal(result.status,2);assert.equal(result.stdout,'');assert.ok(result.stderr.includes(path));
});

const invalidConfigurations:readonly {
  readonly name:string;
  readonly env:NodeJS.ProcessEnv;
  readonly detail:RegExp;
}[]=[
  {name:'JWT_SECRET',env:{JWT_SECRET:''},detail:/JWT_SECRET/u},
  {name:'PROVIDER_CREDENTIAL_PREVIOUS_KEYS JSON',env:{PROVIDER_CREDENTIAL_PREVIOUS_KEYS:'invalid'},detail:/PROVIDER_CREDENTIAL_PREVIOUS_KEYS/u},
  {name:'PROVIDER_CREDENTIAL_PREVIOUS_KEYS entries',env:{PROVIDER_CREDENTIAL_PREVIOUS_KEYS:'{"0":"key"}'},detail:/PROVIDER_CREDENTIAL_PREVIOUS_KEYS/u},
  {name:'PROVIDER_CREDENTIAL_KEY_VERSION',env:{PROVIDER_CREDENTIAL_KEY_VERSION:'0'},detail:/PROVIDER_CREDENTIAL_KEY_VERSION/u},
  {name:'PORT range',env:{PORT:'65536'},detail:/PORT/u},
  {name:'PROXY_SHARED_SECRET length',env:{PROXY_SHARED_SECRET:'short'},detail:/PROXY_SHARED_SECRET/u},
  {name:'RETENTION_ENFORCEMENT_ENABLED boolean',env:{RETENTION_ENFORCEMENT_ENABLED:'sometimes'},detail:/RETENTION_ENFORCEMENT_ENABLED/u},
  {name:'SMTP host/from pair',env:{SMTP_HOST:'smtp.example.test'},detail:/SMTP_HOST and SMTP_FROM/u},
  {name:'SMTP auth pair',env:{SMTP_HOST:'smtp.example.test',SMTP_FROM:'noreply@example.test',SMTP_USER:'mailer'},detail:/SMTP_USER and SMTP_PASS/u},
  {name:'SMTP_PORT range',env:{SMTP_HOST:'smtp.example.test',SMTP_FROM:'noreply@example.test',SMTP_PORT:'65536'},detail:/SMTP_PORT/u},
  {name:'APP_ORIGIN format',env:{APP_ORIGIN:'https://app.example.test/path'},detail:/APP_ORIGIN/u},
  {name:'APP_ORIGIN absolute URL',env:{APP_ORIGIN:'app.example.test'},detail:/APP_ORIGIN/u},
  {name:'APP_ORIGIN scheme',env:{APP_ORIGIN:'ftp://app.example.test'},detail:/APP_ORIGIN/u},
  {name:'APP_ORIGIN query',env:{APP_ORIGIN:'https://app.example.test?tenant=acme'},detail:/APP_ORIGIN/u},
  {name:'APP_ORIGIN fragment',env:{APP_ORIGIN:'https://app.example.test#login'},detail:/APP_ORIGIN/u},
  {name:'production APP_ORIGIN',env:{NODE_ENV:'production'},detail:/APP_ORIGIN/u},
  {name:'production AUDIT_KEY',env:{NODE_ENV:'production',APP_ORIGIN:'https://app.example.test'},detail:/AUDIT_KEY/u},
  {name:'production PROVIDER_CREDENTIAL_KEY',env:{NODE_ENV:'production',APP_ORIGIN:'https://app.example.test',AUDIT_KEY:'audit-root'},detail:/PROVIDER_CREDENTIAL_KEY/u},
];

for(const {name,env,detail} of invalidConfigurations)test(`CLI distinguishes invalid ${name} configuration from missing coverage`,t=>{
  const f=fixture(t);
  f.database.exec("INSERT INTO provider_config VALUES(1,'encrypted','sealed',4)");
  const result=f.run([f.path],env);
  assert.equal(result.status,2);assert.equal(result.stdout,'');
  assert.match(result.stderr,/configuration could not be loaded/u);assert.match(result.stderr,detail);
  assert.doesNotMatch(result.stderr,/Refusing to start/u);
});

test('CLI reports an unusable provider schema as exit 2',t=>{
  const f=fixture(t);f.database.exec('DROP TABLE provider_config');
  const result=f.run();assert.equal(result.status,2);assert.equal(result.stdout,'');
  assert.match(result.stderr,/stored key coverage could not be evaluated.*provider_config/u);
});

test('CLI checks held and missing provider credential versions against the migrated schema',t=>{
  const directory=mkdtempSync(join(tmpdir(),'key-coverage-migrated-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'test.db');
  const database=new Database(path);
  t.after(()=>database.close());
  database.pragma('foreign_keys=ON');
  runMigrations(database);
  const tenantId=randomUUID(),providerId=randomUUID(),now=1_700_000_000_000;
  database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at)
    VALUES(?,?,'Coverage','active',?,?)`).run(tenantId,tenantId.replaceAll('-',''),now,now);
  database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at)
    VALUES(?,?,'openai',1,'encrypted','sealed',1,'{}',?,?)`).run(providerId,tenantId,now,now);
  const run=()=>{
    const result=spawnSync(process.execPath,[script,path],{cwd:directory,encoding:'utf8',env:{
      PATH:process.env.PATH,NODE_ENV:'test',JWT_SECRET:'coverage-test-secret',
      DOTENV_CONFIG_PATH:join(directory,'no-dotenv'),PROVIDER_CREDENTIAL_KEY_VERSION:'1',
    }});
    assert.ifError(result.error);assert.equal(result.signal,null);
    return result;
  };
  const covered=run();
  assert.equal(covered.status,0);assert.equal(covered.stdout,'enabled provider credentials: 1\n');assert.equal(covered.stderr,'');

  database.prepare('UPDATE provider_config SET key_version=4 WHERE id=?').run(providerId);
  const missing=run();
  assert.equal(missing.status,1);assert.equal(missing.stdout,'');assert.equal(missing.stderr,missingProviderMessage);
});
