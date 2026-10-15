// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {nextIsoDate,zonedDate,zonedDateTime,zonedDateTimeInstant,zonedDayStart} from './zoned-dates.js';

const zones=['UTC','Asia/Taipei','Asia/Tokyo','Asia/Kolkata','Asia/Kathmandu','America/New_York','Europe/London','Australia/Lord_Howe','America/Santiago','Asia/Beirut'];
const dates=['2026-01-15','2026-03-08','2026-03-29','2026-09-06','2026-10-04','2026-11-01'];

test('zoned day starts and ends stay on the requested calendar date',()=>{
  for(const timeZone of zones)for(const date of dates){
    const start=zonedDayStart(date,timeZone),next=zonedDayStart(nextIsoDate(date),timeZone);
    assert.equal(zonedDate(start,timeZone),date,`${timeZone} ${date} start`);
    assert.equal(zonedDate(start-1,timeZone),new Date(Date.parse(`${date}T00:00:00Z`)-1).toISOString().slice(0,10),`${timeZone} ${date} previous millisecond`);
    assert.equal(zonedDate(next-1,timeZone),date,`${timeZone} ${date} final millisecond`);
  }
});

test('zoned day starts have fixed anchors only in zones without DST',()=>{
  assert.equal(zonedDayStart('2026-02-01','UTC'),Date.UTC(2026,1,1));
  assert.equal(zonedDayStart('2026-02-01','Asia/Taipei'),Date.UTC(2026,0,31,16));
  assert.equal(zonedDayStart('2026-02-01','Asia/Kolkata'),Date.UTC(2026,0,31,18,30));
});

test('datetime-local conversion round-trips in the workspace zone',()=>{
  for(const zone of zones)for(const date of dates){const value=`${date}T09:45`,instant=zonedDateTimeInstant(value,zone);assert.equal(zonedDateTime(instant,zone),value,`${zone} ${value}`)}
});

test('datetime-local gaps move forward and repeated hours choose the earlier instant',()=>{
  assert.equal(new Date(zonedDateTimeInstant('2026-03-08T02:30','America/New_York')).toISOString(),'2026-03-08T07:00:00.000Z');
  assert.equal(new Date(zonedDateTimeInstant('2026-11-01T01:30','America/New_York')).toISOString(),'2026-11-01T05:30:00.000Z');
});

test('datetime-local conversion is bounded across DST days and fractional-hour transitions',()=>{
  const Original=Intl.DateTimeFormat;let constructions=0;
  Intl.DateTimeFormat=class extends Original {constructor(...args){super(...args);constructions++}};
  try {for(let call=0;call<10;call++)zonedDateTimeInstant('2026-09-29T23:59','Asia/Taipei')}
  finally {Intl.DateTimeFormat=Original}
  assert.ok(constructions<=3,`constructed ${constructions} formatters`);

  for(const date of ['2026-03-08','2026-11-01'])for(let minute=0;minute<24*60;minute++){
    const hour=String(Math.floor(minute/60)).padStart(2,'0'),minuteText=String(minute%60).padStart(2,'0'),value=`${date}T${hour}:${minuteText}`;
    const instant=zonedDateTimeInstant(value,'America/New_York');
    if(date==='2026-03-08'&&hour==='02')assert.equal(new Date(instant).toISOString(),'2026-03-08T07:00:00.000Z',value);
    else assert.equal(zonedDateTime(instant,'America/New_York'),value,value);
  }
  assert.equal(new Date(zonedDateTimeInstant('2026-01-15T00:00','Asia/Kathmandu')).toISOString(),'2026-01-14T18:15:00.000Z');
  assert.equal(new Date(zonedDateTimeInstant('2026-10-04T02:15','Australia/Lord_Howe')).toISOString(),'2026-10-03T15:30:00.000Z');
  assert.equal(new Date(zonedDateTimeInstant('2026-04-05T01:45','Australia/Lord_Howe')).toISOString(),'2026-04-04T14:45:00.000Z');
  for(const invalid of ['2026-02-30T12:00','2026-01-01 12:00','2026-01-01T24:00'])assert.throws(()=>zonedDateTimeInstant(invalid,'UTC'),RangeError);
});
