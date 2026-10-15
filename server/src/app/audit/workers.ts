import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TenantId } from '../../shared/types.js';
import { purgeExpiredApprovalPayloads, purgeExpiredConversations, purgeExpiredIdempotencyRecords, purgeExpiredProjectFiles, purgeExpiredTranscripts, retentionCutoff, verifyAuditChain, type AuditService, type AuditTransaction, type TenantRetentionPolicy } from '../../lib/audit/index.js';
import type { FileBlobStore } from '../files/storage.js';
import { GovernanceLedger } from '../../lib/governance/ledger.js';
import { recoverInterruptedMultiModelWorkflows, type MultiModelRecoveryResult } from '../chat/multi-model-recovery.js';
import { recoverInterruptedSingleModelRuns, type SingleModelRecoveryResult } from '../chat/single-model-recovery.js';

export interface WorkerLogger { error(message:string,error?:unknown):void; info?(message:string):void }
export interface AuditWorkerDependencies {
  database:Database.Database;
  audit:Pick<AuditService,'append'|'transact'>;
  logger?:WorkerLogger;
  now?:()=>number;
  retentionPolicy:(tenantId:TenantId)=>TenantRetentionPolicy;
  blobStore:FileBlobStore;
  /** Explicitly false on an upgraded deployment until its operator reviews retention and backups. */
  retentionEnforcementEnabled?:boolean;
}
export interface AuditWorkers { readonly running:boolean; stop():Promise<void> }

interface TimerSpec { name:string; initialMs:number; intervalMs:number; run:()=>Promise<void>|void }
const AUDIT_VERIFICATION_WINDOW=5_000;

export async function forEachMaintenanceTenant(
  database:Database.Database,
  batchSize:number,
  work:(tenantId:TenantId)=>Promise<unknown>|unknown,
  stopped:()=>boolean=()=>false,
):Promise<void> {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>500)throw new TypeError('Invalid tenant batch size');
  const page=database.prepare<[string,number],{id:TenantId}>("SELECT id FROM tenants WHERE status IN ('active','suspended') AND id>? ORDER BY id LIMIT ?");
  let after='';
  for(;;){
    if(stopped())return;
    const rows=page.all(after,batchSize);
    if(rows.length===0)return;
    for(const {id} of rows){if(stopped())return;await work(id);await yieldEventLoop();}
    after=rows.at(-1)!.id;
  }
}

export async function runRetentionMaintenance(
  deps:Pick<AuditWorkerDependencies,'database'|'retentionPolicy'|'audit'|'blobStore'|'logger'> & {now?:()=>number;enforcementEnabled?:boolean},
  stopped:()=>boolean=()=>false,
):Promise<void> {
  const now=deps.now??Date.now,logger=deps.logger??console;
  const head=deps.database.prepare<[TenantId],{status:string}>('SELECT status FROM audit_chain_heads WHERE tenant_id=?');
  const chainHealthy=(tenantId:TenantId):boolean=>(head.get(tenantId)?.status??'healthy')==='healthy';
  await forEachMaintenanceTenant(deps.database,25,async tenantId=>{
    const at=now();
    const record=(sink:Pick<AuditTransaction,'append'>,dataClass:'conversations'|'files',purged:number,metadata:Record<string,unknown>)=>{if(purged>0)sink.append({tenantId,action:'system.retention_purged',actor:{type:'service',id:'retention-worker',sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'tenant',id:tenantId},outcome:'success',context:{requestId:`retention:${tenantId}:${dataClass}:${String(metadata.fileId??'batch')}:${at}`,traceId:null,source:'worker',occurredAtMs:at},metadata:{dataClass,purgedCount:purged,...metadata}})};
    // Recovery is not a new purge. A surviving blob releases the durable marker; a blob already
    // unlinked before a crash is finalized honestly. A broken chain blocks the event append but
    // must not make missing bytes appear available again.
    const recoveryAuditable=chainHealthy(tenantId);
    const recovered=await purgeExpiredProjectFiles(deps.database,tenantId,at,null,deps.blobStore,100,{
      ...(recoveryAuditable?{afterPurge:(id:string)=>record(deps.audit,'files',1,{fileId:id,preparedRecovery:true})}:{}),
      onBlobError:(id,error)=>logger.error(`Retention could not complete interrupted file purge ${id} of tenant ${tenantId}; the durable marker will be retried`,error),
    });
    if(!chainHealthy(tenantId)){
      logger.error(`Retention paused for tenant ${tenantId} because its audit chain is unavailable${recovered.purged>0?`; ${recovered.purged} already-missing file blob(s) were finalized without a new deletion`:''}`);
      return;
    }
    if(deps.enforcementEnabled===false)return;
    const policy=deps.retentionPolicy(tenantId);
    if(policy.tenantId!==tenantId)throw new Error('Retention policy tenant mismatch');
    const cutoff=retentionCutoff(at,policy.chatTranscriptDays);
    deps.audit.transact(tx=>{const conversations=purgeExpiredConversations(deps.database,tenantId,at,policy.chatTranscriptDays,100);record(tx,'conversations',conversations.purged,{cutoffAtMs:cutoff});});
    // A file whose bytes cannot be removed is left unpurged and retried every hour. Without this
    // line that retry is silent, and a permanently unreadable storage key becomes content the
    // policy says is gone, that no one is told is still there.
    await purgeExpiredProjectFiles(deps.database,tenantId,at,policy.chatTranscriptDays,deps.blobStore,100,{
      afterPurge:(id,preparedRecovery)=>record(deps.audit,'files',1,{fileId:id,cutoffAtMs:cutoff,...(preparedRecovery?{preparedRecovery:true}:{})}),
      onBlobError:(id,error)=>logger.error(`Retention could not complete the audited deletion for file ${id} of tenant ${tenantId}; it will be retried`,error),
    });
    // The file loop is the only asynchronous boundary in this tenant pass. Verification may have
    // marked the chain broken while it yielded, so re-check before every remaining destructive job.
    if(!chainHealthy(tenantId)){logger.error(`Retention paused for tenant ${tenantId} because its audit chain became unavailable`);return}
    purgeExpiredTranscripts(deps.database,tenantId,at,100);
    purgeExpiredApprovalPayloads(deps.database,tenantId,at,policy.approvalPayloadDays,100);
    purgeExpiredIdempotencyRecords(deps.database,tenantId,at,500);
  },stopped);
}

interface VerificationHead { chain_epoch:number; last_sequence:number; genesis_hash:string; status:string; last_verified_sequence:number; last_verified_hash:string|null }

/** Verifies one bounded suffix per tenant and persists either its trusted cursor or the incident. */
export async function runAuditChainVerificationMaintenance(
  deps:Pick<AuditWorkerDependencies,'database'|'logger'|'now'>,
  stopped:()=>boolean=()=>false,
):Promise<void> {
  const now=deps.now??Date.now,logger=deps.logger??console;
  const head=deps.database.prepare<[TenantId],VerificationHead>('SELECT chain_epoch,last_sequence,genesis_hash,status,last_verified_sequence,last_verified_hash FROM audit_chain_heads WHERE tenant_id=?');
  const advance=deps.database.prepare<[number,string|null,number|null,number,TenantId,number]>("UPDATE audit_chain_heads SET last_verified_sequence=?,last_verified_hash=?,last_verified_at_ms=?,updated_at_ms=? WHERE tenant_id=? AND chain_epoch=? AND status='healthy'");
  const mark=deps.database.prepare<[number,number,number,TenantId]>("UPDATE audit_chain_heads SET status='broken',break_sequence=?,break_detected_at_ms=?,updated_at_ms=? WHERE tenant_id=? AND status='healthy'");
  const alert=deps.database.prepare(`INSERT OR IGNORE INTO alerts(id,tenant_id,type,severity,status,dedupe_key,subject_type,subject_id,payload_json,opened_at) VALUES(?,?,'audit_chain_break','critical','open',?,'tenant',?,?,?)`);
  const detect=deps.database.transaction((tenantId:TenantId,epoch:number,sequence:number,reason:string,at:number):boolean=>{
    if(mark.run(sequence,at,at,tenantId).changes===0)return false;
    alert.run(randomUUID(),tenantId,`audit-chain-break:${epoch}:${sequence}`,tenantId,JSON.stringify({chainEpoch:epoch,breakSequence:sequence,reason}),at);
    return true;
  });
  await forEachMaintenanceTenant(deps.database,25,tenantId=>{
    const current=head.get(tenantId);
    if(!current||current.status!=='healthy')return;
    // A missing/stale maintenance cursor is not evidence of audit corruption. Restart at genesis;
    // only verified event bytes are allowed to trigger fail-closed marking.
    const cursor=current.last_verified_sequence<=current.last_sequence&&
      (current.last_verified_sequence===0||current.last_verified_hash!==null)
      ?current.last_verified_sequence:0;
    const expectedPrev=cursor===0?current.genesis_hash:current.last_verified_hash!;
    const verification=verifyAuditChain(deps.database,tenantId,current.chain_epoch,{startSequence:cursor+1,expectedPrevHash:expectedPrev,maxRows:AUDIT_VERIFICATION_WINDOW});
    const at=now();
    if(!verification.valid){
      if(detect.immediate(tenantId,current.chain_epoch,verification.breakAtSequence??cursor+1,verification.reason,at))
        logger.error(`Audit chain break detected for tenant ${tenantId} at sequence ${verification.breakAtSequence??cursor+1}: ${verification.reason}`);
      return;
    }
    const complete=verification.throughSequence>=current.last_sequence;
    advance.run(complete?0:verification.throughSequence,complete?null:verification.throughHash,complete?at:null,at,tenantId,current.chain_epoch);
  },stopped);
}

export async function runReservationMaintenance(
  database:Database.Database,
  now:()=>number=Date.now,
  stopped:()=>boolean=()=>false,
):Promise<{budget:number}> {
  let budget=0;
  for(;;){if(stopped())return{budget};const batch=new GovernanceLedger(database).expireStale(now(),100);budget+=batch;if(batch<100)break;await yieldEventLoop();}
  return{budget};
}

export function runMultiModelRecoveryMaintenance(
  database:Database.Database,
  now:number,
  workerId:string,
  recoverAll=false,
):MultiModelRecoveryResult {
  let recovered=0,completed=0,indeterminate=0,knownProviderCostMicrousd=0;
  for(;;){
    const batch=recoverInterruptedMultiModelWorkflows(database,{now,workerId,recoverAll,limit:100});
    recovered+=batch.recovered;completed+=batch.completed;indeterminate+=batch.indeterminate;knownProviderCostMicrousd+=batch.knownProviderCostMicrousd;
    if(batch.recovered<100)break;
  }
  return{recovered,completed,indeterminate,knownProviderCostMicrousd};
}

export function runSingleModelRecoveryMaintenance(
  database:Database.Database,
  now:number,
  workerId:string,
  recoverAll=false,
):SingleModelRecoveryResult {
  let recovered=0,completed=0,cancelled=0,indeterminate=0,observedProviderCostMicrousd=0;
  for(;;){
    const batch=recoverInterruptedSingleModelRuns(database,{now,workerId,recoverAll,limit:100});
    recovered+=batch.recovered;completed+=batch.completed;cancelled+=batch.cancelled;indeterminate+=batch.indeterminate;
    observedProviderCostMicrousd+=batch.observedProviderCostMicrousd;
    if(batch.recovered<100)break;
  }
  return{recovered,completed,cancelled,indeterminate,observedProviderCostMicrousd};
}

/** Starts staggered, non-overlapping maintenance loops. Each tick yields between tenants. */
export function startAuditWorkers(deps:AuditWorkerDependencies):AuditWorkers {
  const logger=deps.logger??console,now=deps.now??Date.now,workerId=`audit-${process.pid}-${randomUUID()}`;
  let stopped=false;const timers=new Set<NodeJS.Timeout>();const active=new Set<Promise<void>>();
  // Startup runs before `serve()`: no request can race this fail-closed reconciliation and an old
  // streaming execution can never be reissued by a fresh in-memory coordinator.
  const startupRecovery=runMultiModelRecoveryMaintenance(deps.database,now(),`${workerId}:startup`,true);
  if(startupRecovery.recovered>0)logger.info?.(`Recovered ${startupRecovery.recovered} interrupted multi-model workflow(s); ${startupRecovery.indeterminate} indeterminate`);
  const startupSingleRecovery=runSingleModelRecoveryMaintenance(deps.database,now(),`${workerId}:single-startup`,true);
  if(startupSingleRecovery.recovered>0)logger.info?.(`Recovered ${startupSingleRecovery.recovered} interrupted single-model run(s); ${startupSingleRecovery.indeterminate} indeterminate`);
  const retention=()=>runRetentionMaintenance({database:deps.database,retentionPolicy:deps.retentionPolicy,audit:deps.audit,blobStore:deps.blobStore,logger,now,enforcementEnabled:deps.retentionEnforcementEnabled!==false},()=>stopped);
  const alerts=()=>forEachMaintenanceTenant(deps.database,50,tenantId=>{evaluateAlerts(deps.database,tenantId,now());},()=>stopped);
  const verification=()=>runAuditChainVerificationMaintenance({database:deps.database,logger,now},()=>stopped);
  // A reservation is taken before the provider call and settled after it. Any crash, OOM kill or
  // deploy restart in between leaves it active, holding budget against the tenant's cap until the
  // window rolls -- up to a month. GovernanceLedger.expireStale reconciles exactly that and was
  // fully tested ('releases once after a restart') but had no production caller, so it never ran.
  // We deploy by restarting, so this leaked on every deploy that interrupted a stream.
  const reservations=async()=>{const released=await runReservationMaintenance(deps.database,now,()=>stopped);if(released.budget>0)logger.info?.(`Released ${released.budget} stale budget reservation(s)`);};
  const multiModelRecovery=()=>{const result=runMultiModelRecoveryMaintenance(deps.database,now(),`${workerId}:maintenance`);if(result.recovered>0)logger.info?.(`Recovered ${result.recovered} stale multi-model workflow(s); ${result.indeterminate} indeterminate`);};
  const singleModelRecovery=()=>{const result=runSingleModelRecoveryMaintenance(deps.database,now(),`${workerId}:single-maintenance`);if(result.recovered>0)logger.info?.(`Recovered ${result.recovered} stale single-model run(s); ${result.indeterminate} indeterminate`);};
  const specs:TimerSpec[]=[
    {name:'retention',initialMs:45_000,intervalMs:60*60_000,run:retention},
    {name:'alerts',initialMs:105_000,intervalMs:5*60_000,run:alerts},
    // 5,000 rows is about 40 ms of synchronous SQLite work. At one window every five minutes,
    // 200,000 events complete a sweep in 40 ticks (about 3h20m, plus roughly 1.6s total CPU).
    {name:'audit-chain-verification',initialMs:75_000,intervalMs:5*60_000,run:verification},
    {name:'reservations',initialMs:20_000,intervalMs:5*60_000,run:reservations},
    {name:'multi-model-recovery',initialMs:10_000,intervalMs:5*60_000,run:multiModelRecovery},
    {name:'single-model-recovery',initialMs:12_000,intervalMs:5*60_000,run:singleModelRecovery},
  ];
  if(deps.retentionEnforcementEnabled===false)logger.info?.('New conversation and file retention purges are disabled; the retention worker will only reconcile an interrupted prepared file deletion until RETENTION_ENFORCEMENT_ENABLED=true');
  for(const spec of specs)schedule(spec);
  function schedule(spec:TimerSpec):void {const first=setTimeout(()=>tick(spec),spec.initialMs);first.unref();timers.add(first);}
  function tick(spec:TimerSpec):void {if(stopped)return;const job=Promise.resolve().then(spec.run).catch(e=>logger.error(`Audit worker ${spec.name} failed`,e)).finally(()=>{active.delete(job);if(!stopped){const timer=setTimeout(()=>tick(spec),spec.intervalMs);timer.unref();timers.add(timer);}});active.add(job);}
  return {get running(){return !stopped;},async stop(){if(stopped)return;stopped=true;for(const timer of timers)clearTimeout(timer);timers.clear();await Promise.allSettled(active);}};
}

function yieldEventLoop():Promise<void>{return new Promise(resolve=>setImmediate(resolve));}

/** Opens deduplicated operational alerts from durable facts; notification delivery is handled separately. */
export function evaluateAlerts(database:Database.Database,tenantId:TenantId,nowMs:number):number {
  const since=nowMs-15*60_000;
  const violations=database.prepare<[TenantId,number],{count:number}>('SELECT count(*) count FROM policy_violations WHERE tenant_id=? AND created_at_ms>=?').get(tenantId,since)?.count??0;
  const insert=database.prepare(`INSERT OR IGNORE INTO alerts(id,tenant_id,type,severity,status,dedupe_key,subject_type,subject_id,payload_json,opened_at) VALUES(?,?,?,?,'open',?,NULL,NULL,?,?)`);
  let opened=0;
  if(violations>=10)opened+=insert.run(randomUUID(),tenantId,'violation_spike',violations>=50?'critical':'warning',`violation-spike:${Math.floor(nowMs/(15*60_000))}`,JSON.stringify({windowMinutes:15,count:violations}),nowMs).changes;
  return opened;
}
