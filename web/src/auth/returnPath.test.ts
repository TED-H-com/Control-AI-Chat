// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loginRedirectPath, redirectToLogin, returnPathFromLoginSearch, safeReturnPath } from './returnPath.js';

const origin='https://chat.example.test';

test('return paths preserve an internal path and query but never an external destination',()=>{
  assert.equal(safeReturnPath('/admin/audit?outcome=failed',origin),'/admin/audit?outcome=failed');
  assert.equal(safeReturnPath('/chat/thread-1?panel=details#ignored',origin),'/chat/thread-1?panel=details');
  for(const unsafe of [null,'','chat','//evil.example','/\\evil.example','https://evil.example/path','javascript:alert(1)','/login?returnTo=/admin']){
    assert.equal(safeReturnPath(unsafe,origin),'/chat');
  }
});

test('login consumes the encoded return target through the same safety check',()=>{
  assert.equal(returnPathFromLoginSearch('?returnTo=%2Fprojects%2Fp-1%3Ftab%3Dfiles',origin),'/projects/p-1?tab=files');
  assert.equal(returnPathFromLoginSearch('?returnTo=%2F%2Fevil.example',origin),'/chat');
});

test('expired parallel requests issue one redirect with the current path and query',()=>{
  const assigned:string[]=[];
  const location={origin,pathname:'/admin/users',search:'?status=active&role=member',assign:(target:string)=>assigned.push(target)};
  const expected='/login?returnTo=%2Fadmin%2Fusers%3Fstatus%3Dactive%26role%3Dmember';
  assert.equal(loginRedirectPath(location),expected);
  assert.equal(redirectToLogin(location),expected);
  assert.equal(redirectToLogin(location),expected);
  assert.deepEqual(assigned,[expected]);
});
