import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTenant } from './tenant-resolution.js';

test('single-workspace resolution ignores an arbitrary Host header',async()=>{
  const tenant={id:'tenant-id',slug:'acme'};
  const result=await resolveTenant({host:'anything.invalid:9443'},{onlyTenant:async()=>[tenant],bySlug:async()=>[],byVerifiedDomain:async()=>[]});
  assert.deepEqual(result,{kind:'resolved',tenant:{tenantId:'tenant-id',slug:'acme',source:'installation'}});
});
