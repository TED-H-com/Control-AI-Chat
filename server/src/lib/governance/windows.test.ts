import assert from 'node:assert/strict';
import test from 'node:test';
import {budgetWindowBounds,zonedParts} from './windows.js';

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

const now=Date.UTC(2026,0,15,12,0,0);

test('a canonical monthly window reuses one formatter',()=>{
  const expected=budgetWindowBounds(now,'monthly','Asia/Taipei');
  withIntlCounts(count=>{
    budgetWindowBounds(now,'monthly','Asia/Taipei');
    count.reset();
    for(let i=0;i<200;i++)assert.deepEqual(budgetWindowBounds(now,'monthly','Asia/Taipei'),expected);
    assert.equal(count.formatters,0);
    assert.equal(count.zones,0);
  });
});

test('a non-canonical zone builds a formatter on every call',()=>{
  const expected=zonedParts(now,'Asia/Taipei');
  withIntlCounts(count=>{
    zonedParts(now,'asia/taipei');
    count.reset();
    for(let i=0;i<50;i++)assert.deepEqual(zonedParts(now,'asia/taipei'),expected);
    assert.equal(count.formatters,50);
  });
});
