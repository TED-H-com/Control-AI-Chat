// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {buildLedger,entryNumber,stampFor} from './ledger.js';

const message=(id,role,createdAt,parentMessageId=null)=>({id,conversationId:'c',parentMessageId,role,content:id,modelId:null,provider:null,createdAt,inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1});

test('ledger groups exchanges, orphan responses, unanswered prompts, regenerations, and approval releases',()=>{
  const messages=[
    message('u1','user','2026-01-01T12:00:00Z'),message('a1','assistant','2026-01-01T12:00:01Z','u1'),
    message('orphan','assistant','2026-01-01T12:00:02Z','missing'),message('blocked','user','2026-01-01T12:00:03Z'),
    message('regen-u','user','2026-01-01T12:00:04Z'),message('regen-a','assistant','2026-01-01T12:00:05Z','regen-u'),
    message('release-u','user','2026-01-01T12:00:06Z'),message('release-a','assistant','2026-01-01T12:00:07Z','release-u'),
  ];
  const entries=buildLedger(messages,{timeZone:'UTC'});
  assert.deepEqual(entries.map(entry=>[entry.prompt?.id??null,entry.responses.map(response=>response.id)]),[
    ['u1',['a1']],[null,['orphan']],['blocked',[]],['regen-u',['regen-a']],['release-u',['release-a']],
  ]);
  assert.deepEqual(entries.map(entry=>entry.number),[1,2,3,4,5]);
});

test('entry numbers have at least two digits and are never truncated',()=>{
  assert.equal(entryNumber(1),'01');assert.equal(entryNumber(99),'99');assert.equal(entryNumber(100),'100');assert.equal(entryNumber(101),'101');
});

test('date rules use the requested calendar time zone',()=>{
  const instants=[message('u1','user','2026-01-01T15:30:00Z'),message('u2','user','2026-01-01T16:30:00Z')];
  assert.deepEqual(buildLedger(instants,{timeZone:'Asia/Taipei'}).map(entry=>entry.dateRule),[true,true]);
  assert.deepEqual(buildLedger(instants,{timeZone:'America/New_York'}).map(entry=>entry.dateRule),[true,false]);
  const boundary=[message('u1','user','2026-01-02T04:30:00Z'),message('u2','user','2026-01-02T05:30:00Z')];
  assert.deepEqual(buildLedger(boundary,{timeZone:'America/New_York'}).map(entry=>entry.dateRule),[true,true]);
  assert.deepEqual(buildLedger(boundary,{timeZone:'Asia/Taipei'}).map(entry=>entry.dateRule),[true,false]);
});

test('stamp mapping covers every gate outcome for prompts and responses',()=>{
  const gate=(action,protectedItemCount=3)=>({action,protectedItemCount});
  assert.equal(stampFor({gate:null,row:'prompt'}),null);assert.equal(stampFor({gate:null,row:'response'}),null);
  assert.deepEqual(stampFor({gate:null,row:'prompt',liveStatus:'gating'}),{kind:'checking',count:null,ink:'muted',toggles:false,receiptOpen:false});
  assert.deepEqual(stampFor({gate:null,row:'prompt',liveStatus:'streaming'}),{kind:'cleared',count:null,ink:'text-2',toggles:false,receiptOpen:false});
  for(const action of ['allow','flag']){
    assert.deepEqual(stampFor({gate:gate(action),row:'prompt'}),{kind:'cleared',count:null,ink:'text-2',toggles:false,receiptOpen:false});
    assert.equal(stampFor({gate:gate(action),row:'response'}),null);
  }
  for(const action of ['redact','mask'])for(const row of ['prompt','response'])
    assert.deepEqual(stampFor({gate:gate(action),row}),{kind:action,count:3,ink:'primary',toggles:true,receiptOpen:false});
  assert.deepEqual(stampFor({gate:gate('redact',null),row:'prompt'}),{kind:'redact',count:null,ink:'primary',toggles:true,receiptOpen:false});
  assert.deepEqual(stampFor({gate:gate('warn'),row:'prompt'}),{kind:'warn',count:null,ink:'amber',toggles:true,receiptOpen:false});
  assert.deepEqual(stampFor({gate:gate('require_approval'),row:'prompt'}),{kind:'require_approval',count:null,ink:'amber',toggles:false,receiptOpen:true});
  assert.deepEqual(stampFor({gate:gate('block'),row:'prompt'}),{kind:'block',count:null,ink:'crimson',toggles:false,receiptOpen:true});
  for(const action of ['warn','require_approval','block'])assert.deepEqual(stampFor({gate:gate(action),row:'response'}),{kind:'withheld',count:null,ink:'crimson',toggles:false,receiptOpen:true});
});
