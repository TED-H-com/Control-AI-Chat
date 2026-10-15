import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {createAuditService} from '../audit/index.js';
import {runMigrations} from '../migrations/index.js';
import type {TenantId} from '../../shared/types.js';
import {DefaultGateEngine} from './index.js';
import type {Detector,GateContext,ResolvedRule} from './types.js';

const at=Date.UTC(2026,7,9);
function fixture(){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,userId=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,tenantId,tenantId,at,at);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)").run(userId,tenantId,`${userId}@test.invalid`,userId,at,at);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:at}),now:()=>at});
  return {database,tenantId,userId,audit};
}
function context(tenantId:string,userId:string,rule:ResolvedRule):GateContext{return {evaluationId:randomUUID(),requestId:'gate-audit-request',pass:'preflight',subject:{tenantId,userId,groupIds:[],roles:['member']},conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs:at,parts:[{id:'part',source:'user_prompt',text:'secret@example.invalid',mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:{snapshotId:randomUUID(),tenantId,policyVersion:1,fingerprint:'fingerprint',rules:[rule],createdAtMs:at},abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{direction:'outbound'}}}

test('a failed detector is audited once and evaluation completes',async()=>{
  const f=fixture(),rule:ResolvedRule={id:randomUUID(),revision:1,name:'Throwing',detectorKind:'keyword',action:'flag',passMask:'both',priority:1,scopeType:'org',scopeId:f.tenantId,config:{},failureMode:'open',sourceOrder:0};
  const detector:Detector={id:'throwing-detector',kind:'keyword',stage:1,supportedPasses:new Set(['preflight']),failureMode:'open',timeoutMs:1000,async detect(){throw new Error('synthetic')}};
  const verdict=await new DefaultGateEngine({detectors:[detector],audit:f.audit}).evaluate(context(f.tenantId,f.userId,rule));
  assert.equal(verdict.degraded,true);
  const rows=f.database.prepare("SELECT action,outcome,detector,metadata_json FROM audit_events WHERE action='gate.detector_failed'").all() as Array<{action:string;outcome:string;detector:string;metadata_json:string}>;
  assert.equal(rows.length,1);
  assert.deepEqual({...rows[0],metadata_json:JSON.parse(rows[0]!.metadata_json)},{action:'gate.detector_failed',outcome:'failure',detector:'throwing-detector',metadata_json:{detector:'throwing-detector',reasonCode:'detector_failed',direction:'outbound'}});
  f.database.close();
});
