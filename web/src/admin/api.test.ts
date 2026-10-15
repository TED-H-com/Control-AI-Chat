import assert from 'node:assert/strict';
import test from 'node:test';
import { adminMutate, createAdminWrite, createMutationKey } from './api.js';

function recorder({fail=0}={}){const keys:string[]=[];let remaining=fail,next=0;const send=async<T>(_path:string,_method:'POST'|'PATCH'|'PUT'|'DELETE',_body?:unknown,_version?:number,key?:string):Promise<T>=>{keys.push(key??'missing');if(remaining>0){remaining-=1;throw new Error('response lost')}return{ok:true} as T};return{keys,write:createAdminWrite(send,()=>`key-${++next}`)}}

test('a mutation key stays stable for retries and rotates only when requested',()=>{
  const values=['invite-key-1','invite-key-2'];
  const key=createMutationKey(()=>values.shift()??'unexpected-key');
  assert.equal(key.current(),'invite-key-1');
  assert.equal(key.current(),'invite-key-1');
  assert.equal(key.rotate(),'invite-key-2');
  assert.equal(key.current(),'invite-key-2');
});

test('admin mutations preserve a caller-owned invitation idempotency key',async()=>{
  const originalFetch=globalThis.fetch,calls:RequestInit[]=[];
  globalThis.fetch=async(_input,init={})=>{calls.push(init);return new Response(null,{status:204})};
  try{
    await adminMutate('/admin/users','POST',{email:'person@example.test'},undefined,'stable-invitation-key');
    await adminMutate('/admin/users','POST',{email:'person@example.test'},undefined,'stable-invitation-key');
  }finally{globalThis.fetch=originalFetch}
  assert.equal(calls.length,2);
  for(const call of calls)assert.equal(new Headers(call.headers).get('Idempotency-Key'),'stable-invitation-key');
});

test('a write retry keeps its key, while a landed write retires it',async()=>{
  const failed=recorder({fail:1});
  await assert.rejects(()=>failed.write('/admin/groups/g/providers/openai','PUT',{enabled:true},0));
  await failed.write('/admin/groups/g/providers/openai','PUT',{enabled:true},0);
  assert.deepEqual(failed.keys,['key-1','key-1']);

  const landed=recorder();
  await landed.write('/admin/groups/g/providers/openai','PUT',{enabled:true},0);
  await landed.write('/admin/groups/g/providers/openai','PUT',{enabled:true},0);
  assert.deepEqual(landed.keys,['key-1','key-2']);
});

test('path, method, body, and version each own a different pending write key',async()=>{
  const recorded=recorder({fail:5});
  for(const attempt of [
    ()=>recorded.write('/admin/groups/g/providers/openai','PUT',{enabled:true},0),
    ()=>recorded.write('/admin/groups/g/providers/openai','PUT',{enabled:true},1),
    ()=>recorded.write('/admin/groups/g/providers/openai','PUT',{enabled:false},0),
    ()=>recorded.write('/admin/groups/other/providers/openai','PUT',{enabled:true},0),
    ()=>recorded.write('/admin/groups/g/providers/openai','PATCH',{enabled:true},0),
  ])await assert.rejects(attempt);
  assert.equal(new Set(recorded.keys).size,recorded.keys.length);
});
