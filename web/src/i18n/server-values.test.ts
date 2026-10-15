// @ts-nocheck -- production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVAL_RELEASE_ERROR_CODES,APPROVAL_RELEASE_STATUSES,APPROVAL_STATUSES,AUDIT_CATEGORIES,AUDIT_OUTCOMES,BUDGET_METRICS,BUDGET_PERIODS,BUDGET_SCOPES,DATA_CLASSES,DETECTORS,GATE_ACTIONS,GATE_DIRECTIONS,LEGAL_HOLD_SCOPES,LEGAL_HOLD_STATUSES,NUDGE_CATEGORIES,NUDGE_PRIORITIES,NUDGE_RULES,ROLES,USER_STATUSES,VIOLATION_TRIAGE_STATUSES} from '@shared/types';
import {catalogueKeys,createTranslator,runtimeTranslation} from './runtime.js';
import {AUDIT_ACTIONS} from '@shared/audit-actions';

const groups=[
 ['admin.invite.roles',ROLES],['admin.enums',GATE_ACTIONS],['admin.enums',GATE_DIRECTIONS],['admin.enums',DETECTORS],['admin.enums',DATA_CLASSES],
 ['admin.enums',BUDGET_PERIODS],['admin.enums',BUDGET_SCOPES],['admin.enums',BUDGET_METRICS],['admin.legalHolds.scopeOptions',LEGAL_HOLD_SCOPES],
 ['admin.legalHolds.status',LEGAL_HOLD_STATUSES],['admin.enums',USER_STATUSES],['admin.enums',APPROVAL_STATUSES],['admin.enums',VIOLATION_TRIAGE_STATUSES],
 ['admin.violations.release',APPROVAL_RELEASE_STATUSES],['admin.nudges.categories',NUDGE_CATEGORIES],['admin.nudges.priorities',NUDGE_PRIORITIES],['admin.nudges.body',NUDGE_RULES],
];

test('every runtime-translated server value comes from a server constant and has all three translations',()=>{
 const keys=new Set(catalogueKeys());
 for(const [prefix,values] of groups)for(const value of values){const key=`${prefix}.${value}`;assert.ok(keys.has(key),key);for(const locale of ['en','zh-TW','ja']){const translated=runtimeTranslation(createTranslator(locale),prefix,value);assert.notEqual(translated,value,`${locale}: raw ${key}`);assert.notEqual(translated,key,`${locale}: missing ${key}`)}}
 for(const outcome of AUDIT_OUTCOMES){const key=`admin.outcomes.${outcome}`;assert.ok(keys.has(key),key)}
});

test('audit actions and categories have exactly the shared labels in every locale',()=>{
 const keys=catalogueKeys(),assertExact=(prefix,values)=>assert.deepEqual(keys.filter(key=>key.startsWith(`${prefix}.`)).map(key=>key.slice(prefix.length+1)).sort(),[...values].sort(),prefix);
 assertExact('admin.audit.actions',AUDIT_ACTIONS);assertExact('admin.audit.categories',AUDIT_CATEGORIES);
 for(const locale of ['en','zh-TW','ja'])for(const [prefix,values] of [['admin.audit.actions',AUDIT_ACTIONS],['admin.audit.categories',AUDIT_CATEGORIES]])for(const value of values){const translated=runtimeTranslation(createTranslator(locale),prefix,value);assert.notEqual(translated,value,`${locale}: raw ${prefix}.${value}`);assert.notEqual(translated,`${prefix}.${value}`,`${locale}: missing ${prefix}.${value}`)}
});

test('every safe approval release error has one localized sentence and no dead label',()=>{
 const prefix='admin.violations.releaseErrors',keys=catalogueKeys().filter(key=>key.startsWith(`${prefix}.`)).map(key=>key.slice(prefix.length+1)).sort();
 assert.deepEqual(keys,[...APPROVAL_RELEASE_ERROR_CODES].sort());
 for(const locale of ['en','zh-TW','ja'])for(const code of APPROVAL_RELEASE_ERROR_CODES){const translated=runtimeTranslation(createTranslator(locale),prefix,code);assert.notEqual(translated,code,`${locale}: raw ${code}`);assert.match(translated,/[。.]$/u,`${locale}: ${code}`)}
});

test('audit export failure codes have exactly the two localized recovery messages',()=>{
 const prefix='admin.export.errors',codes=['EXPORT_FAILED','EXPORT_TOO_LARGE'],keys=catalogueKeys().filter(key=>key.startsWith(`${prefix}.`)).map(key=>key.slice(prefix.length+1)).sort();assert.deepEqual(keys,codes);
 for(const locale of ['en','zh-TW','ja'])for(const code of codes)assert.notEqual(runtimeTranslation(createTranslator(locale),prefix,code),code);
});

test('gate action terminology is consistent in Traditional Chinese and Japanese',()=>{
 const gateActionKeys=['admin.fields.action','admin.screen.compliance.0','admin.screen.customTerms.0','admin.customTerms.action','admin.customTerms.preview','admin.customTerms.changeAction','admin.compliance.caveat','admin.compliance.effectiveAction','admin.policy.rulesHelp','admin.policy.takeAction','errors.reason.custom_terms_action_invalid'];
 for(const key of gateActionKeys){assert.doesNotMatch(createTranslator('zh-TW')(key),/動作/u,key);assert.doesNotMatch(createTranslator('ja')(key),/処置|アクション/u,key)}
 for(const key of catalogueKeys())assert.doesNotMatch(createTranslator('ja')(key),/放行/u,key);
});
