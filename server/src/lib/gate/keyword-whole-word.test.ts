import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AhoCorasick} from './aho-corasick.js';
import {KeywordDetector} from './detectors/keyword.js';
import {resolvePolicy} from './index.js';
import type {GateContext,ResolvedRule} from './types.js';

const tenant='tenant',user='user',now=Date.UTC(2026,0,1);

function rule(kind:'keyword',config:Record<string,unknown>):ResolvedRule{
  return {
    id:randomUUID(),
    revision:1,
    name:kind,
    detectorKind:kind,
    action:'block',
    passMask:'both',
    priority:100,
    scopeType:'org',
    scopeId:tenant,
    config,
    failureMode:'closed',
    sourceOrder:0
  };
}

function context(r:ResolvedRule,text:string):GateContext{
  const subject={tenantId:tenant,userId:user,groupIds:[],roles:['member'] as const};
  return {
    evaluationId:randomUUID(),
    requestId:randomUUID(),
    pass:'preflight',
    subject,
    conversationId:null,
    messageId:null,
    projectId:null,
    providerId:'test',
    modelId:'test',
    locale:'en',
    nowMs:now,
    parts:[{id:'part',source:'user_prompt',text,mimeType:'text/plain',fileId:null,provenance:{}}],
    policySnapshot:resolvePolicy({tenantId:tenant,modelId:'test',subject,pass:'preflight',policyVersion:1,rules:[r],nowMs:now}),
    abortSignal:new AbortController().signal,
    confirmedWarningToken:null,
    metadata:{}
  };
}

async function detectKeyword(config:Record<string,unknown>,text:string){
  return (await new KeywordDetector().detect(context(rule('keyword',config),text))).matches;
}

const largeTerms=['secret',...Array.from({length:39},(_,i)=>`filler${i}x`)];

test('small whole-word rule ignores in-word occurrences before match',async()=>{
  for(const n of [0,99,100,150]){
    const text='secretary '.repeat(n)+'the secret plan';
    const matches=await detectKeyword({terms:['secret'],wholeWord:true},text);
    assert.equal(matches.length,1,`n=${n}`);
    assert.deepEqual(matches[0]?.span,{start:10*n+4,end:10*n+10},`n=${n}`);
  }
});

test('small whole-word rule with maxMatches 5 ignores in-word occurrences',async()=>{
  for(const n of [5,50]){
    const text='secretary '.repeat(n)+'the secret plan';
    const matches=await detectKeyword({terms:['secret'],wholeWord:true,maxMatches:5},text);
    assert.equal(matches.length,1,`n=${n}`);
    assert.deepEqual(matches[0]?.span,{start:10*n+4,end:10*n+10},`n=${n}`);
  }
});

test('large whole-word rule (40 terms, Aho-Corasick) ignores in-word occurrences',async()=>{
  for(const n of [100,150]){
    const text='secretary '.repeat(n)+'the secret plan';
    const matches=await detectKeyword({terms:largeTerms,wholeWord:true},text);
    assert.equal(matches.length,1,`n=${n}`);
    assert.deepEqual(matches[0]?.span,{start:10*n+4,end:10*n+10},`n=${n}`);
  }
});

test('separator path whole-word rule ignores in-word occurrences on small and large rules',async()=>{
  const text='secretary '.repeat(100)+'the s.e.c.r.e.t plan';
  for(const config of [
    {terms:['secret'],wholeWord:true,allowSeparators:true},
    {terms:['secret'],wholeWord:true,allowSeparators:true,maxMatches:5},
    {terms:largeTerms,wholeWord:true,allowSeparators:true}
  ]){
    const matches=await detectKeyword(config,text);
    assert.equal(matches.length,1);
    assert.deepEqual(matches[0]?.span,{start:10*100+4,end:10*100+15});
  }
});

test('whole-word match cap still applies',async()=>{
  const text='secret '.repeat(150);
  for(const terms of [['secret'],largeTerms]){
    const defaultCap=await detectKeyword({terms,wholeWord:true},text);
    assert.equal(defaultCap.length,100);
    const smallCap=await detectKeyword({terms,wholeWord:true,maxMatches:5},text);
    assert.equal(smallCap.length,5);
  }
});

test('AhoCorasick.search returns only accepted matches and counts only accepted toward max',()=>{
  const aho=new AhoCorasick(['ab']);
  const hits=aho.search('ab ab ab ab',1,match=>match.start>=6);
  assert.deepEqual(hits,[{termId:0,start:6,end:8}]);
  const two=aho.search('ab ab ab ab',2,match=>match.start===3||match.start===9);
  assert.deepEqual(two,[{termId:0,start:3,end:5},{termId:0,start:9,end:11}]);
});

test('AhoCorasick.search without accept is unchanged',()=>{
  const aho=new AhoCorasick(['ab']);
  assert.deepEqual(aho.search('ab ab ab ab'),[
    {termId:0,start:0,end:2},
    {termId:0,start:3,end:5},
    {termId:0,start:6,end:8},
    {termId:0,start:9,end:11}
  ]);
  assert.deepEqual(aho.search('ab ab ab ab',2),[
    {termId:0,start:0,end:2},
    {termId:0,start:3,end:5}
  ]);
});
