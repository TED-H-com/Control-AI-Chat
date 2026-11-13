import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {runMigrations} from '../../lib/migrations/index.js';
import {startAuditWorkers} from './workers.js';

test('after many ticks shutdown clears only pending timers and never schedules another tick',async t=>{
 const db=new Database(':memory:');runMigrations(db);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=new Set<ReturnType<typeof setTimeout>>(),cleared:ReturnType<typeof setTimeout>[]=[],errors:unknown[]=[];
 const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
 let fired=0,unrefs=0;
 t.mock.method(globalThis,'setTimeout',(callback:()=>void,delay:number)=>{
  const timer=originalSetTimeout(()=>{pending.delete(timer);fired++;callback();},delay);
  const originalUnref=timer.unref.bind(timer);
  t.mock.method(timer,'unref',()=>{unrefs++;return originalUnref();});
  pending.add(timer);return timer;
 });
 t.mock.method(globalThis,'clearTimeout',(timer:ReturnType<typeof setTimeout>)=>{cleared.push(timer);pending.delete(timer);originalClearTimeout(timer);});
 const workers=startAuditWorkers({database:db,
  audit:{append(){throw new Error('empty database must not append');},transact(){throw new Error('empty database must not transact');}},
  blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{}},
  retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:0}),
  now:()=>0,logger:{error(message,error){errors.push([message,error]);}},
 });
 const SPECS=6;
 try{
  assert.equal(pending.size,SPECS);
  for(let i=0;i<120;i++){
   t.mock.timers.tick(5*60_000);
   // Drain the workers' promises without waiting on a wall-clock timer.
   await new Promise<void>(resolve=>setImmediate(resolve));
   assert.equal(pending.size,SPECS,'each completed loop has exactly one pending timer');
  }
  assert.ok(fired>500);assert.equal(unrefs,fired+pending.size);assert.deepEqual(errors,[]);
  const remaining=new Set(pending),ticks=fired;
  await workers.stop();
  assert.equal(cleared.length,remaining.size,'expired timer handles must not be retained');
  assert.deepEqual(new Set(cleared),remaining);assert.equal(pending.size,0);assert.equal(workers.running,false);
  await workers.stop();assert.equal(cleared.length,remaining.size);
  t.mock.timers.tick(60*60_000);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(fired,ticks);assert.equal(pending.size,0);
 }finally{await workers.stop();t.mock.restoreAll();t.mock.timers.reset();db.close();}
});
