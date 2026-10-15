// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {formatBytes} from './formatters.js';

test('byte sizes use locale-aware compact binary units',()=>{
  assert.equal(formatBytes(0,'en'),'0 byte');
  assert.equal(formatBytes(1536,'en'),'1.5 kB');
  assert.equal(formatBytes(2*1024*1024,'zh-TW'),'2 MB');
  assert.equal(formatBytes(3*1024*1024*1024,'ja'),'3 GB');
});
