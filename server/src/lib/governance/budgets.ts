import type Database from 'better-sqlite3';
import type { BudgetMetric, BudgetScopeType, BudgetWarning, BudgetWindow } from './types.js';
import { budgetWindowBounds } from './windows.js';

// Ledger equation: used = settle + adjustment; outstanding = reserve - release; every terminal reservation releases its full reserve.

export interface EffectiveBudget { id:string; scopeType:BudgetScopeType; scopeId:string; window:BudgetWindow; metric:BudgetMetric; softLimit:number|null; hardLimit:number; windowStart:number; windowEnd:number; used:number; reserved:number }
interface Row { id:string;scope_type:BudgetScopeType;scope_id:string|null;period:BudgetWindow;metric:BudgetMetric;soft_limit:number|null;hard_limit:number;timezone:string }
interface SumRow { amount:number|null }
export function applicableBudgets(database:Database.Database,tenantId:string,userId:string,groupIds:readonly string[],now:number):EffectiveBudget[] {
  const rows=database.prepare<[string],Row>('SELECT id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone FROM budgets WHERE tenant_id=? AND enabled=1').all(tenantId);
  const groups=new Set(groupIds);
  return rows.filter(r=>r.scope_type==='tenant'||(r.scope_type==='user'&&r.scope_id===userId)||(r.scope_type==='group'&&r.scope_id!==null&&groups.has(r.scope_id))).map(r=>{
    const bounds=budgetWindowBounds(now,r.period,r.timezone);
    const sums=database.prepare<[string,string,number,number],SumRow>(`SELECT COALESCE(SUM(CASE WHEN kind IN ('settle','adjustment') THEN amount ELSE 0 END),0) amount FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND period_start=? AND period_end=?`).get(tenantId,r.id,bounds.start,bounds.end)?.amount??0;
    const reserved=database.prepare<[string,string,number,number],SumRow>(`SELECT COALESCE(SUM(CASE WHEN kind='reserve' THEN amount WHEN kind='release' THEN -amount ELSE 0 END),0) amount FROM budget_ledger WHERE tenant_id=? AND budget_id=? AND period_start=? AND period_end=?`).get(tenantId,r.id,bounds.start,bounds.end)?.amount??0;
    return {id:r.id,scopeType:r.scope_type,scopeId:r.scope_id??tenantId,window:r.period,metric:r.metric,softLimit:r.soft_limit,hardLimit:r.hard_limit,windowStart:bounds.start,windowEnd:bounds.end,used:sums,reserved};
  });
}
export function warningFor(budget:EffectiveBudget,projected:number):BudgetWarning|null { if(budget.softLimit===null||projected<budget.softLimit)return null; return {budgetLimitId:budget.id,scopeType:budget.scopeType,scopeId:budget.scopeId,window:budget.window,metric:budget.metric,projected,limit:budget.softLimit,utilizationBasisPoints:budget.softLimit===0?10000:Math.floor(projected*10000/budget.softLimit)}; }
