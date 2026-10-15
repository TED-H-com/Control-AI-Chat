// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { routeDefinitions } from '@routes/catalog.js';
import { adminMutate } from './api.js';

const directory=fileURLToPath(new URL('.',import.meta.url));
const productionFiles=readdirSync(directory)
  .filter(name=>/\.tsx?$/u.test(name)&&!name.includes('.test.'))
  .sort();
const productionNames=new Set(productionFiles);

function sourceFile(name:string){
  const text=readFileSync(new URL(name,import.meta.url),'utf8');
  return {text,tree:ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)};
}

// Follow the real static import graph from the console root. This keeps an abandoned component or
// test fixture from silently inflating the production write inventory.
function reachableProductionFiles(){
  const reached=new Set<string>(),pending=['AdminConsole.tsx'];
  while(pending.length){
    const name=pending.pop()!;
    if(reached.has(name))continue;
    reached.add(name);
    const {tree}=sourceFile(name);
    for(const statement of tree.statements){
      if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier))continue;
      const specifier=statement.moduleSpecifier.text;
      if(!specifier.startsWith('./'))continue;
      const stem=specifier.slice(2).replace(/\.js$/u,'');
      const target=[`${stem}.ts`,`${stem}.tsx`].find(candidate=>productionNames.has(candidate));
      if(target&&!reached.has(target))pending.push(target);
    }
  }
  return [...reached].sort();
}

type WriteKind='managed'|'persistent-legacy'|'ephemeral-explicit'|'default-key';
type WriteCall={file:string;kind:WriteKind};

function enclosingFunction(node:ts.Node):ts.Node|undefined {
  let current=node.parent;
  while(current&&!ts.isFunctionLike(current))current=current.parent;
  return current;
}

function hasManagedAncestor(node:ts.Node,managedScopes:ReadonlySet<ts.Node>):boolean {
  let current=node.parent;
  while(current){if(ts.isFunctionLike(current)&&managedScopes.has(current))return true;current=current.parent}
  return false;
}

function writeInventory(){
  const writes:WriteCall[]=[],rawWrites:{file:string;method:string}[]=[];
  for(const name of reachableProductionFiles()){
    if(name==='api.ts')continue;
    const {tree}=sourceFile(name),aliases=new Set(['adminMutate','adminWrite']);
    const managedScopes=new Set<ts.Node>();
    const collectAliases=(node:ts.Node)=>{
      if((ts.isParameter(node)||ts.isBindingElement(node))&&ts.isIdentifier(node.name)&&
          node.initializer&&ts.isIdentifier(node.initializer)&&node.initializer.text==='adminMutate')
        aliases.add(node.name.text);
      if(ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)&&
          node.name.elements.some(element=>ts.isBindingElement(element)&&ts.isIdentifier(element.name)&&element.name.text==='adminWrite')&&
          node.initializer&&ts.isCallExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&
          node.initializer.expression.text==='useState'&&node.initializer.arguments[0]&&ts.isIdentifier(node.initializer.arguments[0])&&
          node.initializer.arguments[0].text==='createAdminWrite'){
        const owner=enclosingFunction(node);
        assert.ok(owner,`${name} creates adminWrite outside a component`);
        managedScopes.add(owner);
      }
      ts.forEachChild(node,collectAliases);
    };
    collectAliases(tree);
    const visit=(node:ts.Node)=>{
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
        const callee=node.expression.text;
        if(aliases.has(callee)){
          if(callee==='adminWrite')assert.ok(hasManagedAncestor(node,managedScopes),
            `${name} calls adminWrite outside its component-owned createAdminWrite instance`);
          const key=node.arguments[4]?.getText(tree)??'';
          const kind:WriteKind=callee==='adminWrite'?'managed':
            node.arguments.length<5?'default-key':
            key.includes('.current()')?'persistent-legacy':'ephemeral-explicit';
          writes.push({file:name,kind});
        }
        if(callee==='fetch'&&node.arguments[1]&&ts.isObjectLiteralExpression(node.arguments[1])){
          const method=node.arguments[1].properties.find(property=>
            ts.isPropertyAssignment(property)&&property.name.getText(tree)==='method');
          if(method&&ts.isPropertyAssignment(method)&&ts.isStringLiteral(method.initializer)&&method.initializer.text!=='GET')
            rawWrites.push({file:name,method:method.initializer.text});
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(tree);
  }
  return {writes,rawWrites};
}

test('the admin-write retry backlog is derived from every reachable production caller',()=>{
  const {writes,rawWrites}=writeInventory(),byFile:Record<string,Record<WriteKind|'total',number>>={};
  for(const call of writes){
    byFile[call.file]??={'managed':0,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:0};
    byFile[call.file][call.kind]+=1;
    byFile[call.file].total+=1;
  }
  assert.deepEqual(byFile,{
    'AuditExport.tsx':{'managed':0,'persistent-legacy':1,'ephemeral-explicit':0,'default-key':0,total:1},
    'CustomTerms.tsx':{'managed':1,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:1},
    'GroupAccessControls.tsx':{'managed':5,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:5},
    'PolicyEditor.tsx':{'managed':3,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:3},
    'SettingsForm.tsx':{'managed':1,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:1},
    'Violations.tsx':{'managed':4,'persistent-legacy':0,'ephemeral-explicit':0,'default-key':0,total:4},
    'forms.tsx':{'managed':16,'persistent-legacy':1,'ephemeral-explicit':0,'default-key':0,total:17},
  });
  assert.deepEqual(rawWrites,[{file:'SettingsForm.tsx',method:'POST'}],
    'a raw write appeared or disappeared outside the JSON mutation inventory');

  const count=(kind:WriteKind)=>writes.filter(call=>call.kind===kind).length;
  assert.deepEqual({total:writes.length,stable:count('managed')+count('persistent-legacy'),
    unstable:count('default-key')+count('ephemeral-explicit'),managed:count('managed'),
    persistentLegacy:count('persistent-legacy'),defaultKey:count('default-key'),
    ephemeralExplicit:count('ephemeral-explicit')},
  {total:32,stable:32,unstable:0,managed:30,persistentLegacy:2,defaultKey:0,ephemeralExplicit:0});
});

test('a lost-response retry through the default adminMutate path carries a new key',async()=>{
  const originalFetch=globalThis.fetch,keys:string[]=[];
  globalThis.fetch=async(_input,init={})=>{
    keys.push(new Headers(init.headers).get('Idempotency-Key')??'missing');
    throw new Error('the response never arrived');
  };
  try{
    await assert.rejects(()=>adminMutate('/admin/groups','POST',{name:'measured'}));
    await assert.rejects(()=>adminMutate('/admin/groups','POST',{name:'measured'}));
  }finally{globalThis.fetch=originalFetch}
  assert.equal(keys.length,2);
  assert.notEqual(keys[0],keys[1],'the retry unexpectedly reused the first attempt key');
});

test('the raw multipart icon write is outside the route idempotency contract',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  const definition=catalog.split('\n').find(line=>line.includes("path:'/admin/settings/icon'"));
  assert.ok(definition,'settings icon route disappeared from the catalogue');
  assert.doesNotMatch(definition,/idempotency\s*:\s*true/u);
});

test('the migrated violation writes are backed by durable replay bound to their request',()=>{
  const triage=readFileSync(new URL('../../../server/src/app/audit/violation-triage.ts',import.meta.url),'utf8');
  assert.match(triage,/namespace:'violation-triage'/u);
  assert.match(triage,/if\(operation==='admin\.violationsBulk'\)return idempotency\.execute\(/u);
  const approvals=readFileSync(new URL('../../../server/src/app/audit/adapters.ts',import.meta.url),'utf8');
  assert.match(approvals,/namespace:'approval-decision'/u);
  assert.match(approvals,/decisionIdempotency\.execute\(/u);
  const replay=readFileSync(new URL('../../../server/src/app/idempotency/mutation.ts',import.meta.url),'utf8');
  assert.match(replay,/ifMatch:request\.headers\.get\('If-Match'\),body:request\.body/u);
});

test('the migrated user edit and delete are versioned and backed by durable replay',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PATCH'.*operation:`\$\{op\}\.update`.*ifMatch:true,idempotency:true/u);
  assert.match(catalog,/method:'DELETE'.*operation:`\$\{op\}\.delete`.*ifMatch:true,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-user-mutation'/u);
  assert.match(admin,/if\(\(operation==='admin\.users\.update'\|\|operation==='admin\.users\.delete'\)&&request\.headers\.get\('Idempotency-Key'\)!==null\)\s*return \(operation==='admin\.users\.update'\?userUpdateIdempotency:userDeleteIdempotency\)\.execute\(operation,request/u);
  assert.match(admin,/if\(operation==='admin\.users\.delete'\)\{[\s\S]*?expectedVersion\(request\)[\s\S]*?deleteUser,[\s\S]*?target,expected\)/u,
    'user DELETE must compare the wire version instead of merely binding it into replay');
  assert.match(admin,/locale:String\(row\.locale\),version:Number\(row\.updated_at\)/u,
    'the user read contract must expose the concurrency version the caller sends');
  const replay=readFileSync(new URL('../../../server/src/app/idempotency/mutation.ts',import.meta.url),'utf8');
  assert.match(replay,/ifMatch:request\.headers\.get\('If-Match'\),body:request\.body/u);
});

test('the migrated force logout has a durable transactional server owner',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/path:'\/admin\/users\/:id\/force-logout'.*operation:'admin\.users\.forceLogout'.*idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-user-force-logout'/u);
  assert.match(admin,/forceLogoutIdempotency\.execute\(operation,request,\s*\(tx,at\)=>forceLogoutUser\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/forceLogoutUserSessions,at,'admin_forced_logout',target/u);
  assert.match(admin,/action:'identity\.sessions_revoked_all'/u);
});

test('the migrated group DELETE carries one read version through CAS and durable replay',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'DELETE'.*operation:`\$\{op\}\.delete`.*ifMatch:true,idempotency:true/u);
  const wire=readFileSync(new URL('../../../server/src/app/admin/wire.ts',import.meta.url),'utf8');
  assert.match(wire,/function groupWire[\s\S]*?version:number\(row\.updated_at\)/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-group-delete',method:'DELETE'/u);
  assert.match(admin,/groupDeleteIdempotency\.execute\(operation,request,\s*\(tx,at\)=>deleteGroup\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function deleteGroup[\s\S]*?expectedVersion\(request\)[\s\S]*?deleteGroup,updatedAt,updatedAt,id,expected/u);
  assert.match(admin,/action:'admin\.group_deleted'/u);
});

test('the migrated group PATCH carries one read version through CAS, durable replay, and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PATCH'.*operation:`\$\{op\}\.update`.*ifMatch:true,idempotency:true/u);
  const wire=readFileSync(new URL('../../../server/src/app/admin/wire.ts',import.meta.url),'utf8');
  assert.match(wire,/function groupWire[\s\S]*?version:number\(row\.updated_at\)/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-group-update',method:'PATCH'/u);
  assert.match(admin,/groupUpdateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>updateGroup\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function updateGroup[\s\S]*?expectedVersion\(request\)[\s\S]*?updateGroup,[\s\S]*?id,expected/u);
  assert.match(admin,/action:'admin\.group_updated'/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function EditGroup[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(`\/admin\/groups\//u);
});

test('the migrated group POST has tenant-scoped durable replay and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'POST'.*operation:`\$\{op\}\.create`.*success:201,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-group-create'/u);
  assert.match(admin,/groupCreateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>createGroup\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function createGroup[\s\S]*?tenant\.get\(deps\.statements\.insertGroup[\s\S]*?action:'admin\.group_created'/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function CreateGroup[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\('\/admin\/groups','POST'/u);
});

test('the migrated group membership pair has CAS, durable replay, and one stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PUT'.*operation:'admin\.groups\.addMember'.*ifMatch:true,idempotency:true/u);
  assert.match(catalog,/method:'DELETE'.*operation:'admin\.groups\.removeMember'.*ifMatch:true,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-group-membership',method:'PUT'/u);
  assert.match(admin,/namespace:'admin-group-membership',method:'DELETE'/u);
  assert.match(admin,/groupMemberAddIdempotency\.execute\(operation,request,[\s\S]*?groupMemberRemoveIdempotency\.execute\(operation,request,/u);
  assert.match(admin,/function changeGroupMembership[\s\S]*?updateGroupVersion[\s\S]*?statements\.addMember[\s\S]*?statements\.removeMember[\s\S]*?action:'admin\.group_membership_changed'/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function GroupMembers[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(groupMemberPath[\s\S]*?mutationVersion\(record\)/u);
});

test('the migrated group-model access pair has group CAS, durable replay, and one stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PUT'.*operation:'admin\.models\.enableForGroup'.*ifMatch:true,idempotency:true/u);
  assert.match(catalog,/method:'DELETE'.*operation:'admin\.models\.disableForGroup'.*ifMatch:true,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-group-model-access',method:'PUT'/u);
  assert.match(admin,/namespace:'admin-group-model-access',method:'DELETE'/u);
  assert.match(admin,/groupModelEnableIdempotency\.execute\(operation,request,[\s\S]*?groupModelDisableIdempotency\.execute\(operation,request,/u);
  assert.match(admin,/function changeGroupModelAccess[\s\S]*?updateGroupVersion[\s\S]*?statements\.enableGroupModel[\s\S]*?statements\.disableGroupModel[\s\S]*?action:'admin\.model_access_changed'/u);
  const controls=readFileSync(new URL('./GroupAccessControls.tsx',import.meta.url),'utf8');
  assert.match(controls,/function ModelControls[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(`\/admin\/groups\/[\s\S]*?mutationVersion\(group\)\)[\s\S]*?setGroups\(\(await getRecords\('\/admin\/groups'/u);
});

test('the migrated model PATCH carries one read version through CAS, durable replay, and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PATCH'.*operation:'admin\.models\.update'.*ifMatch:true,idempotency:true/u);
  const wire=readFileSync(new URL('../../../server/src/app/admin/wire.ts',import.meta.url),'utf8');
  assert.match(wire,/function modelWire[\s\S]*?version:number\(row\.updated_at\)/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/updateModel:p\(`[^`]*WHERE tenant_id=\? AND id=\? AND updated_at=\? RETURNING \*`\)/u);
  assert.match(admin,/namespace:'admin-model-update',method:'PATCH'/u);
  assert.match(admin,/modelUpdateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>updateModel\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function updateModel[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.updateModel[\s\S]*?action:'admin\.model_access_changed'/u);
  const controls=readFileSync(new URL('./GroupAccessControls.tsx',import.meta.url),'utf8');
  assert.match(controls,/function ModelControls[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(`\/admin\/models\/[\s\S]*?'PATCH'[\s\S]*?mutationVersion\(record\)/u);
});

test('the migrated model POST has tenant-scoped durable replay and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'POST'.*path:'\/admin\/models'.*operation:'admin\.models\.create'.*idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-model-create'/u);
  assert.match(admin,/modelCreateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>createModel\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function createModel[\s\S]*?statements\.insertModel[\s\S]*?action:'admin\.model_access_changed'[\s\S]*?status:201/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function CreateModel[^\n]*useState\(createAdminWrite\)[^\n]*await adminWrite\('\/admin\/models','POST'/u);
});

test('the migrated budget POST has tenant-scoped durable replay and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'POST'.*operation:`\$\{op\}\.create`.*success:201,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-budget-create'/u);
  assert.match(admin,/budgetCreateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>createBudget\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function createBudget[\s\S]*?statements\.insertBudget[\s\S]*?action:'admin\.tenant_setting_changed'[\s\S]*?kind:'budget_created'[\s\S]*?status:201/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function CreateBudget[^\n]*useState\(createAdminWrite\)[^\n]*await adminWrite\('\/budgets','POST'/u);
});

test('the migrated budget PATCH carries one read version through CAS, durable replay, and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PATCH'.*operation:`\$\{op\}\.update`.*ifMatch:true,idempotency:true/u);
  const wire=readFileSync(new URL('../../../server/src/app/admin/wire.ts',import.meta.url),'utf8');
  assert.match(wire,/function budgetWire[\s\S]*?version:number\(row\.updated_at\)/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/updateBudget:p\(`[^`]*WHERE tenant_id=\? AND id=\? AND updated_at=\? RETURNING \*`\)/u);
  assert.match(admin,/namespace:'admin-budget-update',method:'PATCH'/u);
  assert.match(admin,/budgetUpdateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>updateBudget\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function updateBudget[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.updateBudget[\s\S]*?action:'admin\.tenant_setting_changed'[\s\S]*?kind:'budget_updated'/u);
  const controls=readFileSync(new URL('./GroupAccessControls.tsx',import.meta.url),'utf8');
  assert.match(controls,/function BudgetControls[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(`\/budgets\/[\s\S]*?'PATCH'[\s\S]*?mutationVersion\(record\)/u);
});

test('the migrated budget DELETE carries one read version through CAS, durable replay, and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'DELETE'.*operation:`\$\{op\}\.delete`.*success:204,ifMatch:true,idempotency:true/u);
  const wire=readFileSync(new URL('../../../server/src/app/admin/wire.ts',import.meta.url),'utf8');
  assert.match(wire,/function budgetWire[\s\S]*?version:number\(row\.updated_at\)/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/deleteBudget:p\(`[^`]*WHERE tenant_id=\? AND id=\? AND updated_at=\?`\)/u);
  assert.match(admin,/namespace:'admin-budget-delete',method:'DELETE'/u);
  assert.match(admin,/budgetDeleteIdempotency\.execute\(operation,request,\s*\(tx,at\)=>deleteBudget\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function deleteBudget[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.deleteBudget[\s\S]*?action:'admin\.tenant_setting_changed'[\s\S]*?kind:'budget_disabled'/u);
  const controls=readFileSync(new URL('./GroupAccessControls.tsx',import.meta.url),'utf8');
  assert.match(controls,/function BudgetControls[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite\(`\/budgets\/[\s\S]*?'DELETE'[\s\S]*?mutationVersion\(record\)/u);
});

test('the migrated settings PATCH carries one read version through CAS, durable replay, and a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/method:'PATCH',path:'\/admin\/settings'.*ifMatch:true,idempotency:true/u);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/updateSettings:p\(`[^`]*WHERE tenant_id=\? AND updated_at=\? RETURNING \*`\)/u);
  assert.match(admin,/namespace:'admin-settings-update',method:'PATCH'/u);
  assert.match(admin,/settingsUpdateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>updateSettings\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function updateSettings[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.updateSettings[\s\S]*?action:'admin\.tenant_setting_changed'/u);
  const settings=readFileSync(new URL('./SettingsForm.tsx',import.meta.url),'utf8');
  assert.match(settings,/function SettingsForm[\s\S]*?useState\(createAdminWrite\)[\s\S]*?adminWrite\('\/admin\/settings','PATCH',[\s\S]*?num\(record\.updated_at,0\)/u);
});

test('the migrated rule PATCH carries one read version through CAS, durable replay, and a stable caller',()=>{
  const route=routeDefinitions.find(definition=>definition.method==='PATCH'&&definition.path==='/gate/rules/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'gate.rules.update',permission:'policy:write',ifMatch:true,idempotency:true});
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/updateRule:p\(`[^`]*WHERE tenant_id=\? AND id=\? AND updated_at=\? RETURNING \*`\)/u);
  assert.match(admin,/namespace:'admin-rule-update',method:'PATCH'/u);
  assert.match(admin,/ruleUpdateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>updateRule\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function updateRule[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.updateRule[\s\S]*?action:'gate\.rule_updated'/u);
  const editor=readFileSync(new URL('./PolicyEditor.tsx',import.meta.url),'utf8');
  assert.match(editor,/function PolicyEditor[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite<[^>]+>\(`\/gate\/rules\/\$\{draft\.id\}`,'PATCH',body,draft\.version\?\?undefined\)/u);
});

test('the migrated rule DELETE carries one read version through tenant CAS and durable replay',()=>{
  const route=routeDefinitions.find(definition=>definition.method==='DELETE'&&definition.path==='/gate/rules/:id');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,ifMatch:route.ifMatch,idempotency:route.idempotency},
    {operation:'gate.rules.delete',permission:'policy:write',ifMatch:true,idempotency:true});
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/deleteRule:p\(`DELETE FROM policy_rules WHERE tenant_id=\? AND id=\? AND updated_at=\?`\)/u);
  assert.match(admin,/namespace:'admin-rule-delete',method:'DELETE'/u);
  assert.match(admin,/ruleDeleteIdempotency\.execute\(operation,request,\s*\(tx,at\)=>deleteRule\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function deleteRule[\s\S]*?expectedVersion\(request\)[\s\S]*?statements\.deleteRule[\s\S]*?action:'gate\.rule_deleted'/u);
});

test('the migrated rule POST has tenant-scoped durable replay and a stable caller',()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/gate/rules');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'gate.rules.create',permission:'policy:write',idempotency:true});
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-rule-create'/u);
  assert.match(admin,/ruleCreateIdempotency\.execute\(operation,request,\s*\(tx,at\)=>createRule\(request,deps,tx,at,permit\)\)/u);
  assert.match(admin,/function createRule[\s\S]*?statements\.insertRule[\s\S]*?action:'gate\.rule_created'[\s\S]*?status:201/u);
  const editor=readFileSync(new URL('./PolicyEditor.tsx',import.meta.url),'utf8');
  assert.match(editor,/function PolicyEditor[\s\S]*?useState\(createAdminWrite\)[\s\S]*?: await adminWrite<[^>]+>\('\/gate\/rules','POST',body\)/u);
});

test('the migrated rule tester POST has encrypted durable replay and a stable caller',()=>{
  const route=routeDefinitions.find(definition=>definition.method==='POST'&&definition.path==='/gate/rules/test');
  assert.deepEqual(route&&{operation:route.operation,permission:route.permission,idempotency:route.idempotency},
    {operation:'gate.test',permission:'policy:write',idempotency:true});
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/responseEncryptionKey:deps\.invitationResponseEncryptionKey,namespace:'admin-rule-test'/u);
  assert.match(admin,/ruleTestIdempotency\.executeSideEffectFree\(operation,request,\(\)=>testRule\(request,b\(request\),permit\)\)/u);
  const helper=readFileSync(new URL('../../../server/src/app/idempotency/mutation.ts',import.meta.url),'utf8');
  assert.match(helper,/executeSideEffectFree[\s\S]*?const result=await work\(\)[\s\S]*?const raced=[\s\S]*?if\(raced\)return replay[\s\S]*?state\.tenant\.db\.run\(insert/u);
  const editor=readFileSync(new URL('./PolicyEditor.tsx',import.meta.url),'utf8');
  assert.match(editor,/function PolicyEditor[\s\S]*?useState\(createAdminWrite\)[\s\S]*?await adminWrite<PolicyTestResult>\('\/gate\/rules\/test','POST'/u);
});


test('the migrated assistant admin writes have durable owners and stable callers',()=>{
  const routes=routeDefinitions.filter(definition=>(definition.path==='/admin/assistants'||definition.path==='/admin/assistants/:id')&&definition.method!=='GET');
  assert.deepEqual(routes.map(route=>({method:route.method,path:route.path,operation:route.operation,idempotency:route.idempotency})),[
    {method:'POST',path:'/admin/assistants',operation:'admin.assistants.create',idempotency:true},
    {method:'PATCH',path:'/admin/assistants/:id',operation:'admin.assistants.update',idempotency:true},
    {method:'DELETE',path:'/admin/assistants/:id',operation:'admin.assistants.delete',idempotency:true},
  ]);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/namespace:'admin-assistant-create'/u);
  assert.match(admin,/namespace:'admin-assistant-update',method:'PATCH'/u);
  assert.match(admin,/namespace:'admin-assistant-delete',method:'DELETE'/u);
  assert.match(admin,/assistantCreateIdempotency\.execute\(operation,request,[\s\S]*?createAssistant\(request,deps,tx,at,permit\)/u);
  assert.match(admin,/assistantUpdateIdempotency\.execute\(operation,request,[\s\S]*?updateAssistant\(request,deps,tx,at,permit\)/u);
  assert.match(admin,/assistantDeleteIdempotency\.execute\(operation,request,[\s\S]*?deleteAssistant\(request,deps,tx,at,permit\)/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function CreateAssistant[\s\S]*?useState\(createAdminWrite\)[\s\S]*?adminWrite\('\/admin\/assistants','POST'/u);
  assert.match(forms,/function AssistantControls[\s\S]*?useState\(createAdminWrite\)[\s\S]*?adminWrite\(`\/admin\/assistants\/\$\{encodeURIComponent\(recordId\(record\)\)\}`,'PATCH'[\s\S]*?mutationVersion\(record\)/u);
  assert.match(forms,/function AssistantControls[\s\S]*?adminWrite\(`\/admin\/assistants\/\$\{encodeURIComponent\(recordId\(record\)\)\}`,'DELETE'/u);
});

test('the assistant draft-from-url write claims before model dispatch and keeps a stable caller',()=>{
  const catalog=readFileSync(new URL('../../../server/src/routes/catalog.ts',import.meta.url),'utf8');
  assert.match(catalog,/path:'\/assistants\/draft-from-url'.*operation:'assistants\.draftFromUrl'.*idempotency:true/u);
  const route=readFileSync(new URL('../../../server/src/app/assistants/draft-from-url-route.ts',import.meta.url),'utf8');
  assert.match(route,/namespace:'assistant-draft-from-url',method:'POST'/u);
  assert.match(route,/idempotency\.executeDispatched\(operation,request/u);
  const services=readFileSync(new URL('../../../server/src/integration-services.ts',import.meta.url),'utf8');
  assert.match(services,/createAssistantDraftAdapter\([\s\S]*hmacKey:key\('assistant-draft-from-url-idempotency'\)/u);
  assert.match(services,/if\(operation==='assistants\.draftFromUrl'\)return assistantDraft\.execute\(operation,request\)/u);
  const helper=readFileSync(new URL('../../../server/src/app/idempotency/mutation.ts',import.meta.url),'utf8');
  assert.match(helper,/async executeDispatched\([\s\S]*insertClaim[\s\S]*await prepare\(\)/u);
  const forms=readFileSync(new URL('./forms.tsx',import.meta.url),'utf8');
  assert.match(forms,/function CreateAssistant[\s\S]*?useState\(createAdminWrite\)[\s\S]*?adminWrite<[^>]+>\('\/assistants\/draft-from-url','POST'/u);
  assert.match(forms,/function CreateAssistant[\s\S]*busy=\{drafting\|\|busy\}/u);
});

test('the migrated custom-term area has durable owners for both verbs and one stable caller',()=>{
  const routes=routeDefinitions.filter(definition=>definition.path==='/admin/custom-terms'&&definition.method!=='GET');
  assert.deepEqual(routes.map(route=>({method:route.method,operation:route.operation,idempotency:route.idempotency})),[
    {method:'POST',operation:'admin.customTerms.upsert',idempotency:true},
    {method:'DELETE',operation:'admin.customTerms.delete',idempotency:true},
  ]);
  const admin=readFileSync(new URL('../../../server/src/app/admin/index.ts',import.meta.url),'utf8');
  assert.match(admin,/customTermsUpsertIdempotency=createDurableMutationIdempotency\([^\n]*namespace:'admin-custom-terms'/u);
  assert.match(admin,/customTermsDeleteIdempotency=createDurableMutationIdempotency\([^\n]*namespace:'admin-custom-terms',method:'DELETE'/u);
  assert.match(admin,/customTermsUpsertIdempotency\.execute\(operation,request,[\s\S]*?mutateCustomTerms\(operation,request,deps,tx,at,permit\)/u);
  assert.match(admin,/customTermsDeleteIdempotency\.execute\(operation,request,[\s\S]*?mutateCustomTerms\(operation,request,deps,tx,at,permit\)/u);
  const source=readFileSync(new URL('./CustomTerms.tsx',import.meta.url),'utf8');
  assert.match(source,/function CustomTerms[\s\S]*?useState\(createAdminWrite\)[\s\S]*?adminWrite<State>\('\/admin\/custom-terms',method,body\)/u);
});
