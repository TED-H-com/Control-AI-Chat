import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import {DefaultGateEngine,StatelessGateVault,deterministicDetectors,resolvePolicy} from './index.js';
import type {GateContext,ResolvedRule} from './types.js';

v8.setFlagsFromString('--expose-gc');
const gc=vm.runInNewContext('gc') as ()=>void;

test('redacted originals are absent from the heap after evaluation',async()=>{
  const tenantId=randomUUID(),userId=randomUUID(),nonce=randomBytes(16).toString('hex'),nowMs=Date.now();
  const subject={tenantId,userId,groupIds:[],roles:['member'] as const};
  const rule:ResolvedRule={id:randomUUID(),revision:1,name:'email redaction',detectorKind:'pii',action:'redact',passMask:'preflight',priority:100,scopeType:'org',scopeId:tenantId,config:{categories:['email'],minimumConfidence:'medium'},failureMode:'closed',sourceOrder:0};
  const policySnapshot=resolvePolicy({tenantId,modelId:'test',subject,pass:'preflight',policyVersion:1,rules:[rule],nowMs});
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:new StatelessGateVault()});
  async function evaluateOriginals():Promise<void>{
    for(let i=0;i<1000;i++){
      const original=`mail ${nonce}x${i}@corp.invalid now`;
      const context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs,parts:[{id:'prompt',source:'user_prompt',text:original,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot,abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};
      const verdict=await engine.evaluate(context);
      assert.equal(verdict.action,'redact');
      assert.doesNotMatch(verdict.providerParts?.[0]?.text??'',new RegExp(nonce,'u'));
    }
  }
  await evaluateOriginals();
  /./.exec('reset');
  gc();gc();
  let snapshot='';for await(const chunk of v8.getHeapSnapshot())snapshot+=chunk.toString();
  const needle=`${nonce}x`;let count=0,offset=0;
  while((offset=snapshot.indexOf(needle,offset))!==-1){count++;offset+=needle.length}
  assert.equal(count,0,`${count} redacted originals remain in the heap`);
});
