import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APP_VERSION } from './version.js';

test('application version matches VERSION and both package manifests',()=>{
  const read=(url:URL):{version:string}=>JSON.parse(readFileSync(url,'utf8')) as {version:string};
  for(const directory of ['../','../../web/']){
    assert.equal(read(new URL(`${directory}package.json`,import.meta.url)).version,APP_VERSION);
    const lock=JSON.parse(readFileSync(new URL(`${directory}package-lock.json`,import.meta.url),'utf8')) as {version:string;packages:Record<string,{version?:string}>};
    assert.equal(lock.version,APP_VERSION);
    assert.equal(lock.packages['']?.version,APP_VERSION);
  }
  assert.equal(readFileSync(new URL('../../VERSION',import.meta.url),'utf8').trim(),APP_VERSION);
  const escaped=APP_VERSION.replaceAll('.',String.raw`\.`);
  const dockerfile=readFileSync(new URL('../../Dockerfile',import.meta.url),'utf8');
  const compose=readFileSync(new URL('../../docker-compose.yml',import.meta.url),'utf8');
  assert.match(dockerfile,new RegExp(`ARG APP_VERSION=${escaped}`));
  assert.match(dockerfile,new RegExp(`ARG VCS_REF=v${escaped}`));
  assert.ok(compose.includes(`APP_VERSION: \${APP_VERSION:-${APP_VERSION}}`));
  assert.ok(compose.includes(`VCS_REF: \${VCS_REF:-v${APP_VERSION}}`));
});
