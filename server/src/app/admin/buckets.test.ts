import assert from 'node:assert/strict';
import test from 'node:test';
import {timeBuckets,zonedMonthStart} from './buckets.js';

test('zoned day buckets honor Taipei and fractional-hour offsets',()=>{
  const taipei=timeBuckets(Date.parse('2026-09-27T17:00Z'),Date.parse('2026-09-29T01:00Z'),'day','Asia/Taipei');
  assert.deepEqual(taipei.map(bucket=>[bucket.key,new Date(bucket.startMs).toISOString()]),[['2026-09-28','2026-09-27T16:00:00.000Z'],['2026-09-29','2026-09-28T16:00:00.000Z']]);
  const kolkata=timeBuckets(Date.parse('2026-09-27T19:00Z'),Date.parse('2026-09-29T01:00Z'),'day','Asia/Kolkata');
  assert.equal(new Date(kolkata[0]!.startMs).toISOString(),'2026-09-27T18:30:00.000Z');
  const kathmandu=timeBuckets(Date.parse('2026-09-27T19:00Z'),Date.parse('2026-09-28T19:00Z'),'day','Asia/Kathmandu');
  assert.equal(new Date(kathmandu[0]!.startMs).toISOString(),'2026-09-27T18:15:00.000Z');
});

test('zoned hour buckets align to fractional-hour offsets',()=>{
  const kolkata=timeBuckets(Date.parse('2026-09-27T18:30Z'),Date.parse('2026-09-27T21:30Z'),'hour','Asia/Kolkata');
  assert.deepEqual(kolkata.map(bucket=>[bucket.key,new Date(bucket.startMs).toISOString()]),[
    ['2026-09-28T00:00+05:30','2026-09-27T18:30:00.000Z'],
    ['2026-09-28T01:00+05:30','2026-09-27T19:30:00.000Z'],
    ['2026-09-28T02:00+05:30','2026-09-27T20:30:00.000Z'],
  ]);
  const kathmandu=timeBuckets(Date.parse('2026-09-27T18:15Z'),Date.parse('2026-09-27T21:15Z'),'hour','Asia/Kathmandu');
  assert.deepEqual(kathmandu.map(bucket=>[bucket.key,new Date(bucket.startMs).toISOString()]),[
    ['2026-09-28T00:00+05:45','2026-09-27T18:15:00.000Z'],
    ['2026-09-28T01:00+05:45','2026-09-27T19:15:00.000Z'],
    ['2026-09-28T02:00+05:45','2026-09-27T20:15:00.000Z'],
  ]);
});

test('New York day and hour buckets preserve both sides of DST',()=>{
  const spring=timeBuckets(Date.parse('2026-03-08T05:00Z'),Date.parse('2026-03-09T04:00Z'),'hour','America/New_York');
  assert.equal(spring.length,23);assert.ok(!spring.some(bucket=>bucket.key.startsWith('2026-03-08T02:')));
  const fall=timeBuckets(Date.parse('2026-11-01T04:00Z'),Date.parse('2026-11-02T05:00Z'),'hour','America/New_York');
  assert.equal(fall.length,25);
  assert.deepEqual(fall.filter(bucket=>bucket.key.startsWith('2026-11-01T01:')).map(bucket=>bucket.key),['2026-11-01T01:00-04:00','2026-11-01T01:00-05:00']);
  const days=timeBuckets(Date.parse('2026-03-08T05:00Z'),Date.parse('2026-03-10T04:00Z'),'day','America/New_York');
  assert.equal(days[0]!.endMs-days[0]!.startMs,23*60*60_000);
  const fallDays=timeBuckets(Date.parse('2026-11-01T04:00Z'),Date.parse('2026-11-03T05:00Z'),'day','America/New_York');
  assert.equal(fallDays[0]!.endMs-fallDays[0]!.startMs,25*60*60_000);
});

test('weeks start Monday and month starts locally',()=>{
  assert.equal(timeBuckets(Date.parse('2026-09-30T12:00Z'),Date.parse('2026-10-02T12:00Z'),'week','Asia/Taipei')[0]!.key,'2026-09-28');
  assert.equal(new Date(zonedMonthStart(Date.parse('2026-09-15T12:00Z'),'Asia/Taipei')).toISOString(),'2026-08-31T16:00:00.000Z');
});

test('hour and calendar bucket caps accept 5000 and reject 5001',()=>{
  const DAY=24*60*60_000;
  assert.equal(timeBuckets(0,5_000*DAY,'day','UTC').length,5_000);
  assert.throws(()=>timeBuckets(0,5_001*DAY,'day','UTC'),/granularity/u);
  assert.equal(timeBuckets(0,5_000*60*60_000,'hour','UTC').length,5_000);
  assert.throws(()=>timeBuckets(0,5_001*60*60_000,'hour','UTC'),/granularity/u);
});
