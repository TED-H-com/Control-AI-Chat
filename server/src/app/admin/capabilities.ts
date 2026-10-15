import type Database from 'better-sqlite3';
import type { TenantDb } from '../../lib/db.js';
import type { BudgetWindow } from '../../lib/governance/types.js';
import { budgetWindowBounds, type WindowBounds } from '../../lib/governance/windows.js';
import { timeBuckets, type BucketGranularity } from './buckets.js';
import { TENANT_PERMISSIONS, fromStorageKey } from '../../shared/permissions.js';
import type { Permission, TenantId } from '../../shared/types.js';
import { assignableRoles, tenantRoles, type AssignableRole } from './user-account-policy.js';

type Statement<Row> = Database.Statement<[TenantId, ...unknown[]], Row>;
interface KeyRow { key:string }
interface PermissionRow { permission_key:string }
interface UsageRow { requests:number; active_users:number; input_tokens:number; output_tokens:number; spend_microusd:number; failed:number; latest:number|null }
interface GateRow { blocked:number; latest:number|null }
interface CountRow { count:number }
interface BucketRow { bucket:string; bucket_start_ms:number; requests:number; tokens:number; spend_microusd:number }
interface BudgetRow { id:string; period:BudgetWindow; timezone:string; hard_limit:number }
interface AmountRow { amount:number }
interface TenantRow { id:string;name:string;slug:string;status:string;timezone:string }

const HOUR=3_600_000, DAY=24*HOUR, MAX_SPAN_MS=3660*DAY;
const granularity=(span:number):BucketGranularity => span<=2*DAY?'hour':span<=120*DAY?'day':'month';

export interface ConsoleStatements {
  readonly roleKeys:Statement<KeyRow>; readonly grantedPermissions:Statement<PermissionRow>;
  readonly usage:Statement<UsageRow>; readonly usageBuckets:Statement<BucketRow>; readonly gate:Statement<GateRow>;
  readonly openApprovals:Statement<CountRow>; readonly tenantSpendBudget:Statement<BudgetRow>; readonly budgetSettled:Statement<AmountRow>;
  readonly tenant:Statement<TenantRow>;
}

/** Preparation is deliberately separate from request execution; execution always uses TenantDb. */
export function prepareConsoleStatements(database:Database.Database):ConsoleStatements {
  const p=<Row>(sql:string):Statement<Row> => database.prepare<[TenantId,...unknown[]],Row>(sql);
  return {
    roleKeys:p<KeyRow>(`SELECT DISTINCT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY r.key`),
    grantedPermissions:p<PermissionRow>(`SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=?`),
    usage:p<UsageRow>(`SELECT COUNT(*) requests,COUNT(DISTINCT user_id) active_users,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(cost_microusd),0) spend_microusd,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed,MAX(started_at) latest FROM usage_records WHERE tenant_id=? AND started_at BETWEEN ? AND ?`),
    usageBuckets:p<BucketRow>(`WITH tenant_scope(tenant_id) AS (VALUES (?)),buckets AS (
      SELECT json_extract(value,'$.key') bucket,json_extract(value,'$.startMs') start_ms,json_extract(value,'$.endMs') end_ms FROM json_each(:buckets)
    ) SELECT b.bucket,b.start_ms bucket_start_ms,COUNT(u.started_at) requests,COALESCE(SUM(u.input_tokens+u.output_tokens),0) tokens,COALESCE(SUM(u.cost_microusd),0) spend_microusd
      FROM buckets b CROSS JOIN tenant_scope LEFT JOIN usage_records u ON u.tenant_id=tenant_scope.tenant_id AND u.started_at>=MAX(b.start_ms,:from) AND u.started_at<MIN(b.end_ms,:to)
      GROUP BY b.bucket,b.start_ms ORDER BY b.start_ms`),
    gate:p<GateRow>(`SELECT COALESCE(SUM(CASE WHEN final_action='block' THEN 1 ELSE 0 END),0) blocked,MAX(decided_at) latest FROM gate_decisions WHERE tenant_id=? AND decided_at BETWEEN ? AND ?`),
    // Pending reviews and retryable release failures both remain operational queue work.
    openApprovals:p<CountRow>(`SELECT COUNT(*) count FROM policy_approval_requests WHERE tenant_id=? AND status IN ('pending','claimed','release_failed') AND expires_at_ms>?`),
    tenantSpendBudget:p<BudgetRow>(`SELECT id,period,timezone,hard_limit FROM budgets WHERE tenant_id=? AND enabled=1 AND scope_type='tenant' AND metric='usd' ORDER BY CASE period WHEN 'monthly' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END LIMIT 1`),
    // Same ledger equation the enforcer sums, so the console KPI cannot disagree with the block.
    budgetSettled:p<AmountRow>(`SELECT COALESCE(SUM(CASE WHEN kind IN ('settle','adjustment') THEN amount ELSE 0 END),0) amount FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND period_start=? AND period_end=?`),
    tenant:p<TenantRow>(`SELECT t.id,t.name,t.slug,t.status,ts.timezone FROM tenant_settings ts JOIN tenants t ON t.id=ts.tenant_id WHERE ts.tenant_id=?`),
  };
}

export interface AdminCapabilities {
  readonly tenantId:string; readonly userId:string; readonly roleIds:readonly string[]; readonly permissions:readonly Permission[];
  readonly assignableRoles:readonly AssignableRole[];
  readonly tenantTimezone:string; readonly tenantCurrency:'USD'; readonly contentAccessReasonRequired:boolean;
  readonly tenant:{readonly id:string;readonly name:string;readonly slug:string;readonly status:string};
}

// Content access is not configurable yet; the workspace time zone is persisted in tenant_settings.
const CONTENT_ACCESS_REASON_REQUIRED=false;

export function adminCapabilities(tenant:TenantDb,userId:string,statements:ConsoleStatements,_nowMs=Date.now()):AdminCapabilities {
  const granted=new Set(tenant.all(statements.grantedPermissions,userId).map(row=>fromStorageKey(row.permission_key)));
  const descriptor=tenant.get(statements.tenant);
  if(!descriptor)throw new Error('Tenant descriptor is missing');
  const roleIds=tenant.all(statements.roleKeys,userId).map(row=>row.key);
  return {
    tenantId:tenant.tenantId,userId,
    roleIds,assignableRoles:assignableRoles(tenantRoles(roleIds)),
    // What the console may show has to be exactly what the request path enforces: the tenant
    // vocabulary intersected with role_permissions, never the role claim on the token. A key
    // outside that vocabulary is dropped rather than advertised.
    permissions:TENANT_PERMISSIONS.filter(permission=>granted.has(permission)),
    tenantTimezone:descriptor.timezone, tenantCurrency:'USD', contentAccessReasonRequired:CONTENT_ACCESS_REASON_REQUIRED,
    tenant:{id:descriptor.id,name:descriptor.name,slug:descriptor.slug,status:descriptor.status},
  };
}

export interface DashboardRange { readonly fromMs:number; readonly toMs:number; readonly nowMs?:number }
export interface UsagePoint { readonly bucket:string; readonly label:string; readonly bucketStartMs:number; readonly value:number; readonly requests:number; readonly totalTokens:number; readonly spendMicroUsd:number }
export interface DashboardSummary {
  readonly requests:number; readonly activeUsers:number; readonly tokens:{readonly total:number;readonly input:number;readonly output:number};
  readonly spendMicroUsd:number; readonly blockedRequests:number; readonly pendingApprovals:number;
  readonly budgetUsedMicroUsd:number|null; readonly budgetLimitMicroUsd:number|null;
  readonly providerErrorRate:number|null; readonly dataFreshThrough:string|null; readonly usage:readonly UsagePoint[];
}

export function adminDashboardSummary(tenant:TenantDb,range:DashboardRange,statements:ConsoleStatements):DashboardSummary {
  const {fromMs,toMs}=range, nowMs=range.nowMs??toMs;
  if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||toMs<fromMs) throw new RangeError('fromMs must be a finite timestamp at or before toMs');
  if(toMs-fromMs>MAX_SPAN_MS) throw new RangeError('range must not exceed ten years');
  // Bare aggregates without GROUP BY always return exactly one row.
  const usage=tenant.get(statements.usage,fromMs,toMs)!, gate=tenant.get(statements.gate,fromMs,toMs)!;
  const budget=budgetUtilization(tenant,statements,nowMs), latest=Math.max(usage.latest??-1,gate.latest??-1);
  return {
    requests:usage.requests, activeUsers:usage.active_users,
    tokens:{total:usage.input_tokens+usage.output_tokens,input:usage.input_tokens,output:usage.output_tokens},
    spendMicroUsd:usage.spend_microusd, blockedRequests:gate.blocked,
    // Queue depth is a right-now number: an approval decided last week is not pending in any
    // window, so this one metric ignores from/to and reads as of nowMs.
    pendingApprovals:tenant.get(statements.openApprovals,nowMs)!.count,
    budgetUsedMicroUsd:budget.used, budgetLimitMicroUsd:budget.limit,
    providerErrorRate:usage.requests===0?null:usage.failed/usage.requests,
    dataFreshThrough:latest<0?null:new Date(latest).toISOString(),
    usage:timeseries(tenant,statements,fromMs,toMs,workspaceTimeZone(tenant,statements)),
  };
}

function budgetUtilization(tenant:TenantDb,statements:ConsoleStatements,nowMs:number):{used:number|null;limit:number|null} {
  const budget=tenant.get(statements.tenantSpendBudget);
  if(!budget) return {used:null,limit:null};
  const bounds=windowOrNull(nowMs,budget.period,budget.timezone);
  if(!bounds) return {used:null,limit:null};
  return {used:tenant.get(statements.budgetSettled,budget.id,bounds.start,bounds.end)!.amount,limit:budget.hard_limit};
}
// Old imported databases can still contain a bad budget zone; keep the Overview available.
function windowOrNull(nowMs:number,period:BudgetWindow,timezone:string):WindowBounds|null { try { return budgetWindowBounds(nowMs,period,timezone); } catch { return null; } }

// Empty buckets are emitted too: a line chart joins whatever rows it is handed, so omitting the
// quiet days draws a straight line across them and reports activity that never happened.
function timeseries(tenant:TenantDb,statements:ConsoleStatements,fromMs:number,toMs:number,timeZone:string):UsagePoint[] {
  const buckets=timeBuckets(fromMs,toMs,granularity(toMs-fromMs),timeZone);
  return tenant.all(statements.usageBuckets,{buckets:JSON.stringify(buckets),from:fromMs,to:toMs}).map(row=>({bucket:row.bucket,label:row.bucket,bucketStartMs:row.bucket_start_ms,value:row.requests,requests:row.requests,totalTokens:row.tokens,spendMicroUsd:row.spend_microusd}));
}

export function workspaceTimeZone(tenant:TenantDb,statements:ConsoleStatements):string {
  const descriptor=tenant.get(statements.tenant);
  if(!descriptor)throw new Error('Tenant descriptor is missing');
  return descriptor.timezone;
}
