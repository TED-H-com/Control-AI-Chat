import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_EXPORT_FIELDS, streamAuditExport, validateAuditExportFields } from './audit-export.js';
import type { AuditSearchRow } from './audit-search.js';
const row:AuditSearchRow={id:'=formula',tenant_id:'t',chain_epoch:1,sequence:1,occurred_at_ms:1,recorded_at_ms:1,action:'x',category:'system',outcome:'success',severity:'info',actor_id:null,target_type:'none',target_id:null,metadata_json:'{}',transcript_id:null,prev_hash:'0'.repeat(64),event_hash:'1'.repeat(64)};
async function collect(format:'csv'|'json'|'ndjson'):Promise<string>{const chunks:Uint8Array[]=[];for await(const chunk of streamAuditExport([row],format))chunks.push(chunk);return Buffer.concat(chunks).toString();}
test('streaming CSV neutralizes spreadsheet formulas',async()=>assert.match(await collect('csv'),/"'=formula"/));
test('streaming JSON emits valid envelope without buffering rows',async()=>assert.equal(JSON.parse(await collect('json')).summary.rowCount,1));
test('selected fields use canonical order and apply to every format',async()=>{
  const selected=['action','id'];
  const output=async(format:'csv'|'json'|'ndjson')=>{const chunks:Uint8Array[]=[];for await(const chunk of streamAuditExport([row],format,selected))chunks.push(chunk);return Buffer.concat(chunks).toString();};
  assert.equal((await output('csv')).split('\r\n')[0],'id,action');
  assert.deepEqual(Object.keys(JSON.parse(await output('ndjson'))),['id','action']);
  assert.deepEqual(Object.keys(JSON.parse(await output('json')).events[0]),['id','action']);
});
test('field validation rejects forbidden columns and empty means all',()=>{
  assert.deepEqual(validateAuditExportFields([]),AUDIT_EXPORT_FIELDS);
  assert.throws(()=>validateAuditExportFields(['storage_path']),/allowed audit export columns/);
});
