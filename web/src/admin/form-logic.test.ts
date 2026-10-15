// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { advertisedUserActions, budgetLimitForApi, budgetLimitForForm, createUserPayload, groupActionGuard, groupMemberPath, memberDiff, microUsdToUsd, modelUpdatePayload, mutationErrorKey, mutationErrorText, mutationVersion, primaryActionForScreen, recordRole, settingsPayload, updateUserPayload, usdToMicroUsd, validBudgetScope } from './form-logic.js';
import {ApiClientError} from '../api.js';
import {createTranslator} from '../i18n/runtime.js';

test('user controls consume only the actions advertised on the server record',()=>{
 const actions={changeStatus:true,changeRole:false,deprovision:true,signOut:false,credentialLink:'reset' as const};
 assert.deepEqual(advertisedUserActions({id:'target',actions}),actions);
 assert.deepEqual(advertisedUserActions({id:'legacy'}),{changeStatus:false,changeRole:false,deprovision:false,signOut:false,credentialLink:null});
});

test('workspace owners retain their displayed role and cannot be assigned another role',()=>{
 assert.equal(recordRole({id:'owner',roles:['member','owner']}),'owner');
 assert.equal(recordRole({id:'owner',role:'owner'}),'owner');
});

test('only a group-name conflict receives the duplicate-name message',()=>{
 assert.equal(mutationErrorKey(409,'CONFLICT','group-name'),'admin.people.common.groupNameConflict');
 assert.equal(mutationErrorKey(409,'IDEMPOTENCY_CONFLICT','group-name'),'admin.people.common.failed');
 assert.equal(mutationErrorKey(409,'CONFLICT','default'),'admin.people.common.failed');
 assert.equal(mutationErrorKey(412,'PRECONDITION_FAILED','default'),'admin.people.common.changed');
});

test('group access errors prefer a structured reason after the screen-specific cases',()=>{
 const error=new ApiClientError(422,{error:{code:'VALIDATION_FAILED',message:'SERVER-TEXT-SENTINEL',requestId:'request',retryable:false,details:{reason:'group_model_state_unchanged'}}});
 for(const locale of ['en','zh-TW','ja']){const text=mutationErrorText(error,createTranslator(locale));assert.equal(text,createTranslator(locale)('errors.reason.group_model_state_unchanged'));assert.doesNotMatch(text,/SERVER-TEXT-SENTINEL/u)}
});

test('system groups cannot be renamed or deleted but retain a membership view',()=>{
 assert.deepEqual(groupActionGuard({id:'all',system:true}),{canEdit:false,canDelete:false,canManageMembers:true});
 assert.deepEqual(groupActionGuard({id:'team',system:false}),{canEdit:true,canDelete:true,canManageMembers:true});
});

test('user create and update payloads contain only the server contract fields',()=>{
 assert.deepEqual(createUserPayload({email:' person@example.test ',displayName:' Person ',role:'member'}),{email:'person@example.test',displayName:'Person',role:'member'});
 assert.deepEqual(updateUserPayload({displayName:' Person ',status:'suspended',locale:' ja ',role:'compliance'}),{displayName:'Person',status:'suspended',locale:'ja',role:'compliance'});
 assert.deepEqual(updateUserPayload({displayName:'Renamed',status:'active',locale:'en',role:'member'},{displayName:'Before',status:'active',locale:'en',role:'member'}),{displayName:'Renamed'});
});

test('group member paths encode both ids and member diffs separate adds from removals',()=>{
 assert.equal(groupMemberPath('group/a','user b'),'/admin/groups/group%2Fa/members/user%20b');
 assert.deepEqual(memberDiff([{id:'one'},{id:'two'}],[{id:'two'},{id:'three'}]),{add:['three'],remove:['one']});
});

test('legacy records keep a present fallback while version-bearing records preserve their fence',()=>{
 assert.equal(mutationVersion({id:'unversioned'}),0);
 assert.equal(mutationVersion({id:'versioned',version:7}),7);
});

test('primary actions exist only for screens with implemented drawers',()=>{
 assert.equal(primaryActionForScreen('users'),'invite-user');
 assert.equal(primaryActionForScreen('groups'),'create-group');
 assert.equal(primaryActionForScreen('providers'),'provider-credential');
 assert.equal(primaryActionForScreen('roles'),null);
 assert.equal(primaryActionForScreen('models'),'add-model');
 assert.equal(primaryActionForScreen('budgets'),'create-budget');
});

test('USD and micro-USD round-trip exactly for model prices and USD budgets',()=>{
 for(const [usd,micros] of [['0.00',0],['3.00',3_000_000],['3.000001',3_000_001]] as const){assert.equal(usdToMicroUsd(usd),micros);assert.equal(usdToMicroUsd(microUsdToUsd(micros)),micros);assert.equal(budgetLimitForApi('usd',budgetLimitForForm('usd',micros)),micros)}
 assert.equal(budgetLimitForApi('tokens','5000'),5000);assert.equal(budgetLimitForForm('tokens',5000),'5000');
});

test('budget scope requires null only for tenant and an id otherwise',()=>{assert.equal(validBudgetScope('tenant',null),true);assert.equal(validBudgetScope('tenant','group'),false);assert.equal(validBudgetScope('group','group'),true);assert.equal(validBudgetScope('user',null),false)});

test('model PATCH includes only changed fields, keeping unchanged prices out',()=>{const before={displayName:'Model',enabled:true,contextWindowTokens:10,maxOutputTokens:2,inputPriceUsd:'3.00',outputPriceUsd:'4.00',capabilities:'text'};assert.deepEqual(modelUpdatePayload({...before,enabled:false},before),{enabled:false});assert.deepEqual(modelUpdatePayload({...before,inputPriceUsd:'3.000001'},before),{inputPriceMicroUsdPerMillion:3000001})});

test('settings payload includes only changed fields and preserves explicit empty support values',()=>{const before={defaultLocale:'en',timezone:'UTC',retentionDays:30,transcriptCapture:false,requestsPerMinute:60,concurrentStreams:4,brandName:'Acme',supportVendorName:'IT',supportContactEmail:'help@example.test',supportContactPhone:'123',supportContactUrl:'https://example.test',supportNotes:'Call us'};assert.deepEqual(settingsPayload({...before,requestsPerMinute:90},before),{requestsPerMinute:90});assert.deepEqual(settingsPayload({...before,timezone:'Asia/Taipei'},before),{timezone:'Asia/Taipei'});assert.deepEqual(settingsPayload({...before,supportNotes:''},before),{supportNotes:''})});
