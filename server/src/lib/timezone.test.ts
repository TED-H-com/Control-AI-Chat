import assert from 'node:assert/strict';
import test from 'node:test';
import {TimeZoneValidationError,canonicalTimeZone} from './timezone.js';

test('workspace time zones accept canonical names, aliases, and case variants',()=>{
  for(const value of ['UTC','Asia/Taipei','America/New_York'])assert.equal(canonicalTimeZone(value),value);
  for(const value of ['utc','US/Eastern','Asia/Kolkata']){
    const expected=new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;
    assert.equal(canonicalTimeZone(value),expected);
  }
});

test('workspace time zones reject non-IANA names, offsets, blanks, and non-strings',()=>{
  for(const value of ['Taipei','GMT+8','+08:00','',8])assert.throws(()=>canonicalTimeZone(value),/^RangeError: timezone must be a valid IANA time zone$/u);
});

interface IntlCounts { formatters:number; zones:number; reset():void }

function withIntlCounts(run:(count:IntlCounts)=>void):void {
  const originalDateTimeFormat=Intl.DateTimeFormat;
  const originalSupportedValuesOf=Intl.supportedValuesOf;
  const count:IntlCounts={formatters:0,zones:0,reset(){count.formatters=0;count.zones=0;}};
  function CountingDateTimeFormat(locales?:Intl.LocalesArgument,options?:Intl.DateTimeFormatOptions):Intl.DateTimeFormat {
    count.formatters+=1;
    return Reflect.construct(originalDateTimeFormat,[locales,options],originalDateTimeFormat) as Intl.DateTimeFormat;
  }
  Intl.DateTimeFormat=CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat;
  Intl.supportedValuesOf=((key:Parameters<typeof Intl.supportedValuesOf>[0])=>{
    count.zones+=1;
    return originalSupportedValuesOf(key);
  }) as typeof Intl.supportedValuesOf;
  try { run(count); }
  finally {
    Intl.DateTimeFormat=originalDateTimeFormat;
    Intl.supportedValuesOf=originalSupportedValuesOf;
  }
}

test('a canonical zone is remembered after one resolution',()=>{
  withIntlCounts(count=>{
    canonicalTimeZone('Asia/Taipei');
    count.reset();
    for(let i=0;i<50;i++)assert.equal(canonicalTimeZone('Asia/Taipei'),'Asia/Taipei');
    assert.equal(count.formatters,0);
    assert.equal(count.zones,0);
  });
});

test('a case variant is resolved on every call and is not remembered',()=>{
  withIntlCounts(count=>{
    canonicalTimeZone('asia/taipei');
    count.reset();
    for(let i=0;i<50;i++)assert.equal(canonicalTimeZone('asia/taipei'),'Asia/Taipei');
    assert.equal(count.formatters,50);
    assert.equal(count.zones,0);
  });
});

test('an offset is rejected on every call and is not remembered',()=>{
  withIntlCounts(count=>{
    let rejected=0;
    for(let i=0;i<50;i++){
      try { canonicalTimeZone('+08:00'); }
      catch(error){ assert.ok(error instanceof TimeZoneValidationError); rejected+=1; }
    }
    assert.equal(rejected,50);
    assert.equal(count.formatters,50);
  });
});

test('every supported time zone name canonicalizes to itself',()=>{
  for(const name of Intl.supportedValuesOf('timeZone'))assert.equal(canonicalTimeZone(name),name);
});
