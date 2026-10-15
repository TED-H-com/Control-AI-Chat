import assert from 'node:assert/strict';
import test from 'node:test';
import {ROLE_PERMISSIONS,TENANT_PERMISSIONS} from './permissions.js';

test('role permissions pin separation of duties',()=>{
  for(const permission of ['approval:decide','audit:export','legal_hold:manage'] as const){
    assert.equal(ROLE_PERMISSIONS.admin.includes(permission),false,`admin must lack ${permission}`);
    assert.equal(ROLE_PERMISSIONS.compliance.includes(permission),true,`compliance must hold ${permission}`);
  }
  assert.deepEqual(new Set(ROLE_PERMISSIONS.owner),new Set(TENANT_PERMISSIONS));
});
