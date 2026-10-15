import assert from 'node:assert/strict';
import test from 'node:test';
import { SCREENS } from './catalog.js';

test('users screen exposes only fields and filters implemented by the user list API',()=>{
  const users=SCREENS.find(screen=>screen.key==='users');
  assert.ok(users);
  assert.deepEqual(users.columns.map(column=>column.key),[
    'displayName','status','roles','groups','mfaEnabled','lastActiveAt',
  ]);
  assert.deepEqual(users.filters.map(filter=>filter.key),[
    'search','status','role','group','mfa',
  ]);
  assert.deepEqual(users.filters.find(filter=>filter.key==='status')?.options,
    ['active','invited','suspended']);
  assert.ok(users.filters.filter(filter=>filter.options).every(filter=>filter.localizedOptions),
    'every visible user filter option must use the four-locale enum catalogue');
  for(const unsupported of ['monthSpendMicroUsd','monthTokens','overBudget']){
    assert.equal(users.columns.some(column=>column.key===unsupported),false);
    assert.equal(users.filters.some(filter=>filter.key===unsupported),false);
  }
});
