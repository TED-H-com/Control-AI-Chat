// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readCredentialToken,recoveryFailure,stripCredentialToken} from './recovery-logic.js';
import {credentialDialogReducer,credentialLinkOutcome} from '../admin/credential-links.js';

test('credential recovery survives StrictMode double reads and strips the fragment exactly once',()=>{
  const current={hash:'#secret-token',pathname:'/setup',search:'?locale=ja'},calls:unknown[][]=[],history={state:{navigation:1},replaceState(...args:unknown[]){calls.push(args)}};
  assert.equal(readCredentialToken(current),'secret-token');
  assert.equal(readCredentialToken(current),'secret-token');
  stripCredentialToken(current,history);stripCredentialToken(current,history);
  assert.deepEqual(calls,[[history.state,'','/setup?locale=ja']]);
  assert.equal(readCredentialToken({hash:'',pathname:'/setup',search:'?locale=ja'}),'secret-token','a remount retains the captured token');
});

test('recovery errors use status, code, and structured policy rules rather than message text',()=>{
  assert.deepEqual(recoveryFailure({status:422,body:{error:{code:'CREDENTIAL_LINK_INVALID',message:'translated'}}}),{kind:'dead',rules:[]});
  assert.deepEqual(recoveryFailure({status:422,body:{error:{code:'PASSWORD_POLICY_FAILED',message:'do not parse',details:{rules:['common_password','minimum_length']}}}}),{kind:'policy',rules:['common_password','minimum_length']});
  assert.deepEqual(recoveryFailure({status:429,body:{error:{code:'RATE_LIMITED',message:'anything'}}}),{kind:'rate-limit',rules:[]});
  assert.deepEqual(recoveryFailure(new Error('This link is expired or has already been used')),{kind:'generic',rules:[]});
});

test('closing the credential dialog drops the plaintext link from component state',()=>{
  const link={purpose:'setup' as const,url:'https://app.example/setup#plaintext',expiresAt:'2026-10-06T00:00:00.000Z',emailSent:false,emailFailure:'smtp_unconfigured' as const};
  const opened=credentialDialogReducer(null,{type:'open',value:link});assert.equal(opened,link);
  const closed=credentialDialogReducer(opened,{type:'close'});assert.equal(closed,null);assert.doesNotMatch(JSON.stringify(closed),/plaintext/u);
});

test('credential-link replays tell the admin to issue from the user row',()=>{
  assert.equal(credentialLinkOutcome({purpose:'setup',reissueRequired:true}),'reissue');
  assert.equal(credentialLinkOutcome({purpose:'reset',url:'https://app.example/reset-password#secret'}),'link');
});
