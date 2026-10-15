import type Database from 'better-sqlite3';
import { applicableBudgets } from '../../lib/governance/budgets.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { TenantId } from '../../shared/types.js';

/**
 * One budget as it applies to the caller, with the reservation outstanding folded in.
 *
 * `remaining` is `hardLimit - used - reserved`, not `hardLimit - used`: an in-flight run has already
 * reserved its worst case, and a user told they have headroom that a reservation has quietly taken
 * gets a hard-cap refusal on the next message instead of a number they can act on. It floors at zero
 * because an over-reserved window is a real state and negative headroom reads as a bug.
 */
export interface MyBudget {
  id:string; scope:'tenant'|'group'|'user'; scopeId:string; window:'daily'|'weekly'|'monthly'; metric:string;
  softLimit:number|null; hardLimit:number; used:number; reserved:number; remaining:number;
  utilizationBasisPoints:number; windowStart:string; windowEnd:string; state:'ok'|'warning'|'exhausted';
}

const GROUPS='SELECT group_id FROM group_members WHERE tenant_id=? AND user_id=?';
const iso=(ms:number):string=>new Date(ms).toISOString();

export interface MyBudgetDependencies { readonly database:Database.Database; readonly now?:()=>number }

export function createMyBudgetReader(deps:MyBudgetDependencies):{supports(operation:string):boolean;execute(operation:string,request:RouteRequest):RouteResult} {
  const groups=deps.database.prepare(GROUPS) as unknown as Database.Statement<[TenantId,string],{group_id:string}>;
  const now=deps.now??Date.now;
  return {
    supports:operation=>operation==='budgets.me',
    execute(_operation,request){
      const tenant=request.tenant;
      if(!tenant)return {status:401,body:{error:{code:'UNAUTHENTICATED',message:'Authentication required',requestId:request.requestId,retryable:false}}};
      const {tenantId,userId}=tenant.principal,at=now();
      const groupIds=tenant.db.all(groups,userId).map(row=>row.group_id);
      // Tenant-wide caps included on purpose. They are what actually stops the user, and a quota screen
      // that shows only their personal limit explains nothing on the day the organisation runs out.
      const items:MyBudget[]=applicableBudgets(deps.database,tenantId,userId,groupIds,at).map(budget=>{
        const committed=budget.used+budget.reserved;
        return {id:budget.id,scope:budget.scopeType,scopeId:budget.scopeId,window:budget.window,metric:budget.metric,
          softLimit:budget.softLimit,hardLimit:budget.hardLimit,used:budget.used,reserved:budget.reserved,
          remaining:Math.max(0,budget.hardLimit-committed),
          utilizationBasisPoints:budget.hardLimit===0?10_000:Math.min(10_000,Math.floor(committed*10_000/budget.hardLimit)),
          windowStart:iso(budget.windowStart),windowEnd:iso(budget.windowEnd),
          state:committed>=budget.hardLimit?'exhausted':budget.softLimit!==null&&committed>=budget.softLimit?'warning':'ok'};
      });
      // Sorted by how close each is to stopping the user, so the one that will bite is first whether it
      // is theirs, their group's or the tenant's.
      items.sort((a,b)=>b.utilizationBasisPoints-a.utilizationBasisPoints||a.id.localeCompare(b.id));
      return {body:{items,asOf:iso(at)}};
    },
  };
}
