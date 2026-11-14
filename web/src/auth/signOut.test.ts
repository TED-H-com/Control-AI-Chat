import test from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorCode } from '@shared/types';
import { ApiClientError } from '../api.js';
import { signOut } from './signOut.js';

const apiError = (status:number,code:ErrorCode,message:string) => new ApiClientError(status,{
  error:{code,message,requestId:'request-id',retryable:false},
});

test('signOut posts logout and navigates to /login on 204',async()=>{
  const calls:Array<{path:string;init:RequestInit}>=[];
  const assigned:string[]=[];
  const result=await signOut({
    request:async(path,init)=>{calls.push({path,init});return undefined;},
    location:{assign:url=>assigned.push(url)},
  });
  assert.equal(result,null);
  assert.deepEqual(calls,[{path:'/api/v1/auth/logout',init:{method:'POST',body:'{}'}}]);
  assert.deepEqual(assigned,['/login']);
});

test('signOut navigates to /login when the session is already gone (401)',async()=>{
  const assigned:string[]=[];
  const result=await signOut({
    request:async()=>{throw apiError(401,'SESSION_EXPIRED','Session expired');},
    location:{assign:url=>assigned.push(url)},
  });
  assert.equal(result,null);
  assert.deepEqual(assigned,['/login']);
});

test('signOut returns a 500 ApiClientError without navigating',async()=>{
  const assigned:string[]=[];
  const expected=apiError(500,'INTERNAL_ERROR','Server failure');
  const result=await signOut({
    request:async()=>{throw expected;},
    location:{assign:url=>assigned.push(url)},
  });
  assert.equal(result,expected);
  assert.deepEqual(assigned,[]);
});

test('signOut returns a network TypeError without navigating',async()=>{
  const assigned:string[]=[];
  const expected=new TypeError('Failed to fetch');
  const result=await signOut({
    request:async()=>{throw expected;},
    location:{assign:url=>assigned.push(url)},
  });
  assert.equal(result,expected);
  assert.deepEqual(assigned,[]);
});

test('signOut wraps a non-Error rejection without navigating',async()=>{
  const assigned:string[]=[];
  const result=await signOut({
    request:async()=>{throw 'unexpected rejection';},
    location:{assign:url=>assigned.push(url)},
  });
  assert.ok(result instanceof Error);
  assert.equal(result.message,'Sign out failed');
  assert.deepEqual(assigned,[]);
});
