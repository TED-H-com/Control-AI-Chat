import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ClassificationTagDetector } from './detectors/classification-tags.js';
import { KeywordDetector } from './detectors/keyword.js';
import { PiiDetector } from './detectors/pii.js';
import { SecretDetector } from './detectors/secrets.js';
import { DefaultGateEngine } from './engine.js';
import { resolvePolicy } from './resolve-policy.js';
import { StatelessGateVault } from './vault.js';
import type { DetectorKind,GateContext,ResolvedRule } from './types.js';

const tenant=randomUUID(),user=randomUUID(),now=Date.UTC(2026,8,28),size=205000;
const piiCategories=['email','phone','ssn_us','national_id','tw_national_id','tw_resident_id','tw_business_id','jp_my_number','jp_corporate_number','jp_residence_card','jp_drivers_license','credit_card','iban','passport','date_of_birth','postal_address','person_name','vin','ip_address','drivers_license_us'];
const samples:readonly [string,string][]=[
  ['long digit run','1'.repeat(size)],
  ['1- repeated','1-'.repeat(Math.ceil(size/2)).slice(0,size)],
  ['1 space repeated','1 '.repeat(Math.ceil(size/2)).slice(0,size)],
  ['(1 repeated','(1'.repeat(Math.ceil(size/2)).slice(0,size)],
  ['1ー repeated','1ー'.repeat(Math.ceil(size/2)).slice(0,size)],
  ['passport repeated','passport '.repeat(Math.ceil(size/9)).slice(0,size)],
  ['市 repeated','市'.repeat(size)],
  ['台北市信義區 repeated','台北市信義區'.repeat(Math.ceil(size/6)).slice(0,size)],
  ['東京都港区 repeated','東京都港区'.repeat(Math.ceil(size/5)).slice(0,size)],
  ['email repeated','a@b.co '.repeat(Math.ceil(size/7)).slice(0,size)],
  ['Taiwan ID repeated','A123456789 '.repeat(Math.ceil(size/11)).slice(0,size)],
];
function runtimeRule(detectorKind:DetectorKind,action:ResolvedRule['action'],config:Readonly<Record<string,unknown>>,sourceOrder:number):ResolvedRule{return {id:randomUUID(),revision:1,name:`linear-${detectorKind}`,detectorKind,action,passMask:'both',priority:100,scopeType:'org',scopeId:tenant,config,failureMode:detectorKind==='pii'?'escalate':'closed',sourceOrder}}
function fixture(text:string):{engine:DefaultGateEngine;context:GateContext}{const rules=[runtimeRule('classification_tag','block',{blockedLevels:['confidential','restricted'],documentHeaderLines:10},0),runtimeRule('keyword','warn',{terms:['company confidential','do not distribute'],regexes:[],wholeWord:false,maxMatches:20},1),runtimeRule('secret','block',{categories:['aws_access_key','aws_secret_key','gcp_credential','azure_credential','private_key','connection_string','jwt','api_token','high_entropy'],minimumTokenLength:20,entropyThresholdBitsPerChar:3.5},2),runtimeRule('pii','redact',{categories:piiCategories,minimumConfidence:'medium'},3)],subject={tenantId:tenant,userId:user,groupIds:[],roles:['member'] as const},context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs:now,parts:[{id:'part',source:'user_prompt',text,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:resolvePolicy({tenantId:tenant,modelId:'test',subject,pass:'preflight',policyVersion:1,rules,nowMs:now}),abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}},vault=new StatelessGateVault();return {engine:new DefaultGateEngine({detectors:[new ClassificationTagDetector(),new KeywordDetector(),new SecretDetector(),new PiiDetector()],vault}),context}}

// The 6 s bound is about five times the slowest sample on a fast workstation, leaving room for slower CI runners; the quadratic code this guards against took 17–43 s on these inputs.
test('send-time gate stays linear on 205 KB adversarial and match-heavy inputs',async t=>{for(const [name,text] of samples)await t.test(name,async t=>{const {engine,context}=fixture(text),began=performance.now(),verdict=await engine.evaluate(context),elapsed=performance.now()-began;t.diagnostic(`${name}: ${elapsed.toFixed(2)} ms`);assert.equal(verdict.evaluationId,context.evaluationId);assert.ok(elapsed<6000,`${name} took ${elapsed.toFixed(2)} ms`)})});
