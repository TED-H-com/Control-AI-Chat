import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { booleanEnvironment, config } from './config.js';

test('boolean environment values are explicit and absence uses the safe fallback',()=>{
  const key='GATEWAY_TEST_BOOLEAN';
  const before=process.env[key];
  try{
    delete process.env[key];
    assert.equal(booleanEnvironment(key,false),false);
    process.env[key]='true';assert.equal(booleanEnvironment(key,false),true);
    process.env[key]=' FALSE ';assert.equal(booleanEnvironment(key,true),false);
    process.env[key]='yes';assert.throws(()=>booleanEnvironment(key,false),/must be true or false/);
  }finally{if(before===undefined)delete process.env[key];else process.env[key]=before;}
});

test('the test preload keeps the default database outside server/data',()=>{
  const serverData=resolve(fileURLToPath(new URL('../data',import.meta.url)));
  assert.equal(config.dbPath===serverData||config.dbPath.startsWith(`${serverData}${sep}`),false,config.dbPath);
});
