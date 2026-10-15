// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLatestRequestRunner} from './latest-request.js';

const deferred=<T>()=>{
  let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};

test('a slower stale response cannot overwrite a newer result or its settled state',async()=>{
  const runner=createLatestRequestRunner(),slow=deferred<string>(),fast=deferred<string>(),state:string[]=[];
  const slowRun=runner.run(()=>slow.promise,{success:value=>state.push(`success:${value}`),error:()=>state.push('error:slow'),settled:()=>state.push('settled:slow')});
  const fastRun=runner.run(()=>fast.promise,{success:value=>state.push(`success:${value}`),error:()=>state.push('error:fast'),settled:()=>state.push('settled:fast')});
  fast.resolve('new');await fastRun;
  assert.deepEqual(state,['success:new','settled:fast']);
  slow.resolve('old');await slowRun;
  assert.deepEqual(state,['success:new','settled:fast']);
});

test('stale failures are ignored and both admin loaders use the shared latest-request runner',async()=>{
  const runner=createLatestRequestRunner(),stale=deferred<string>(),current=deferred<string>(),state:string[]=[];
  const staleRun=runner.run(()=>stale.promise,{success:()=>state.push('success:stale'),error:()=>state.push('error:stale'),settled:()=>state.push('settled:stale')});
  const currentRun=runner.run(()=>current.promise,{success:value=>state.push(`success:${value}`),error:()=>state.push('error:current'),settled:()=>state.push('settled:current')});
  stale.reject(new Error('old failure'));await staleRun;
  assert.deepEqual(state,[]);
  current.resolve('current');await currentRun;
  assert.deepEqual(state,['success:current','settled:current']);
  for(const file of ['GenericScreen.tsx','Overview.tsx']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(source,/createLatestRequestRunner/u);
    assert.match(source,/requests\.current\.run/u);
    assert.match(source,/requests\.current\.invalidate/u);
  }
});
