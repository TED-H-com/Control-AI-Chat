import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { runMigrations } from '../migrations/index.js';
import { loadRoutingCandidates, eligibleRoutingCandidates, selectSingleRoute } from '../governance/router.js';
import { resolveEffectiveModels } from '../governance/modelAccess.js';
import { provisionTenant, TenantEmailConflictError } from './tenant-provision.js';
import {prepareConsoleStatements,adminCapabilities} from '../../app/admin/capabilities.js';
import {forTenant} from '../db.js';
import {TENANT_PERMISSIONS} from '../../shared/permissions.js';
import type {TenantId} from '../../shared/types.js';

const NOW=Date.UTC(2026,7,10,16);

function input(domain:string,name:string,local='owner'){
  const tenantId=randomUUID(),ownerUserId=randomUUID();
  return{tenantId,ownerUserId,slug:`${name.toLowerCase()}-${tenantId.slice(0,8)}`,tenantName:name,
    ownerEmail:`${local}@${domain}`,ownerDisplayName:`${name} Owner`,passwordHash:'not-a-real-password-hash',now:NOW} as const;
}

test('tenant provisioning creates isolated catalogue access',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const firstInput=input('northstar.example','Northstar'),first=provisionTenant(database,firstInput);
  const secondInput=input('southstar.example','Southstar'),second=provisionTenant(database,secondInput);

  assert.deepEqual(database.prepare(`SELECT g.name,g.is_system,gm.source FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE g.tenant_id=? AND gm.user_id=?`).get(first.tenantId,first.ownerUserId),{name:'All Employees',is_system:1,source:'system'});
  assert.equal(database.prepare(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id
    WHERE ur.tenant_id=? AND ur.user_id=? AND r.key='owner' AND rp.permission_key='chat.use'`).pluck().get(first.tenantId,first.ownerUserId),1);
  assert.equal(database.prepare("SELECT count(*) FROM roles WHERE tenant_id=? AND key='member'").pluck().get(first.tenantId),1);

  const effective=resolveEffectiveModels(database,{tenantId:first.tenantId,userId:first.ownerUserId});
  assert.equal(effective.models.length,0);assert.equal(effective.groupIds.length,0);
  const candidates=loadRoutingCandidates(database,{tenantId:first.tenantId,userId:first.ownerUserId,inputTokens:100,outputTokens:512,now:NOW});
  assert.equal(candidates.length,0);
  assert.deepEqual([...new Set(candidates.map(candidate=>candidate.provider))].sort(),[]);
  assert.ok(candidates.every(candidate=>!candidate.providerConfigured));
  database.prepare("UPDATE provider_config SET enabled=1,credential_source='encrypted',credential_ciphertext='sealed',key_version=1 WHERE tenant_id=? AND provider_key='anthropic'").run(first.tenantId);
  const configured=loadRoutingCandidates(database,{tenantId:first.tenantId,userId:first.ownerUserId,inputTokens:100,outputTokens:512,now:NOW});
  assert.deepEqual([...new Set(eligibleRoutingCandidates({},configured).map(candidate=>candidate.provider))],['anthropic']);

  assert.equal(database.prepare('SELECT count(*) FROM model_catalog WHERE tenant_id=?').pluck().get(second.tenantId),10);
  assert.equal(first.modelIds.some(modelId=>second.modelIds.includes(modelId)),false);
  assert.throws(()=>resolveEffectiveModels(database,{tenantId:first.tenantId,userId:second.ownerUserId}),/not found/u);

  database.close();
});

test('provisioned owner and administrator capabilities expose only their governance-assignable roles',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const provisioned=provisionTenant(database,input('roles.example','Roles')),adminUserId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Administrator','hash','active',?,?)").run(adminUserId,provisioned.tenantId,'admin@roles.example',NOW,NOW);
  const adminRoleId=database.prepare("SELECT id FROM roles WHERE tenant_id=? AND key='admin'").pluck().get(provisioned.tenantId) as string;
  database.prepare('INSERT INTO user_roles(tenant_id,user_id,role_id,created_at) VALUES(?,?,?,?)').run(provisioned.tenantId,adminUserId,adminRoleId,NOW);
  const tenant=forTenant({tenantId:provisioned.tenantId as TenantId}),statements=prepareConsoleStatements(database);
  assert.deepEqual(adminCapabilities(tenant,provisioned.ownerUserId,statements).assignableRoles,['admin','compliance','member']);
  assert.deepEqual(adminCapabilities(tenant,adminUserId,statements).assignableRoles,['admin','member']);
  assert.equal((TENANT_PERMISSIONS as readonly string[]).includes('member.assign_compliance_role'),false,'the coarse database vocabulary needs no role-assignment key');
  database.close();
});

test('email domains do not merge unrelated users',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  provisionTenant(database,input('gmail.com','Personal One','one'));provisionTenant(database,input('gmail.com','Personal Two','two'));
  assert.equal(database.prepare('SELECT count(*) FROM tenants').pluck().get(),2);
  assert.throws(()=>provisionTenant(database,input('gmail.com','Duplicate','one')),TenantEmailConflictError);
  assert.equal(database.prepare('SELECT count(*) FROM tenants').pluck().get(),2);
  database.close();
});

test('a tenant with only Anthropic licensed can route around its unconfigured OpenAI default',()=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantInput=input('anthropic-only.example','Anthropic Only');
  const provisioned=provisionTenant(database,tenantInput);

  const seededProviders=database.prepare('SELECT provider_key,enabled,credential_source FROM provider_config WHERE tenant_id=?').all(provisioned.tenantId) as Array<{provider_key:string;enabled:number;credential_source:string}>;
  assert.ok(seededProviders.some(provider=>provider.provider_key==='anthropic'));
  assert.ok(seededProviders.every(provider=>provider.enabled===0&&provider.credential_source==='encrypted'));
  assert.equal(database.prepare('SELECT provider_key FROM model_catalog WHERE tenant_id=? AND is_default=1').pluck().get(provisioned.tenantId),'openai');
  database.prepare("UPDATE provider_config SET enabled=1,credential_ciphertext='sealed',key_version=1 WHERE tenant_id=? AND provider_key='anthropic'").run(provisioned.tenantId);

  const candidates=loadRoutingCandidates(database,{tenantId:provisioned.tenantId,userId:provisioned.ownerUserId,inputTokens:100,outputTokens:512,now:NOW});
  const eligible=eligibleRoutingCandidates({},candidates);
  assert.ok(eligible.length>0);
  assert.ok(eligible.every(candidate=>candidate.provider==='anthropic'));
  const selection=selectSingleRoute({mode:'auto',effort:'standard'},candidates);
  assert.equal(selection.selected.provider,'anthropic');
  database.close();
});
