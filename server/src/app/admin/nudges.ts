import type Database from 'better-sqlite3';
import type { TenantDb } from '../../lib/db.js';
import {NUDGE_RULES,type NudgeCategory,type NudgePriority,type NudgeRule,type TenantId} from '../../shared/types.js';

export interface Nudge { key:string; ruleId:NudgeRule; category:NudgeCategory; priority:NudgePriority; count?:number; percent?:number }
export interface NudgeInputs { pendingApprovals:number; blockedRequests:number; budgetUsedMicroUsd:number|null; budgetLimitMicroUsd:number|null; warnProceeded:number }

const APPROVALS_MEDIUM=1, APPROVALS_HIGH=10;
const BLOCKED_MEDIUM=5, BLOCKED_HIGH=25;
const BUDGET_MEDIUM=0.75, BUDGET_HIGH=0.90;
const WARN_PROCEED_MEDIUM=5, WARN_PROCEED_HIGH=25;

export function generateNudges(inputs:NudgeInputs):Nudge[] {
  const items:Nudge[]=[];
  if(inputs.pendingApprovals>=APPROVALS_MEDIUM)items.push(countNudge('approvalsPending','governance',inputs.pendingApprovals,APPROVALS_HIGH));
  if(inputs.blockedRequests>=BLOCKED_MEDIUM)items.push(countNudge('blockedVolume','policy',inputs.blockedRequests,BLOCKED_HIGH));
  if(inputs.budgetLimitMicroUsd!==null&&inputs.budgetLimitMicroUsd>0&&inputs.budgetUsedMicroUsd!==null){
    const percent=inputs.budgetUsedMicroUsd/inputs.budgetLimitMicroUsd;
    if(percent>=BUDGET_MEDIUM)items.push(nudge('budgetUtilization','cost',percent>=BUDGET_HIGH?'high':'medium',{percent}));
  }
  if(inputs.warnProceeded>=WARN_PROCEED_MEDIUM)items.push(countNudge('warnProceed','policy',inputs.warnProceeded,WARN_PROCEED_HIGH));
  return items.sort((left,right)=>(left.priority==='high'?0:1)-(right.priority==='high'?0:1)||NUDGE_RULES.indexOf(left.ruleId)-NUDGE_RULES.indexOf(right.ruleId));
}

function countNudge(ruleId:NudgeRule,category:NudgeCategory,count:number,highAt:number):Nudge {
  return nudge(ruleId,category,count>=highAt?'high':'medium',{count});
}
function nudge(ruleId:NudgeRule,category:NudgeCategory,priority:NudgePriority,signal:{count?:number;percent?:number}):Nudge {
  return {key:`${ruleId}:${priority}`,ruleId,category,priority,...signal};
}

type WarnProceedRow={n:number};
type WarnProceedStatement=Database.Statement<[TenantId,...unknown[]],WarnProceedRow>;
export interface NudgeStatements { readonly warnProceeded:WarnProceedStatement }

export function prepareNudgeStatements(database:Database.Database):NudgeStatements {
  return {warnProceeded:database.prepare(`SELECT COUNT(*) AS n FROM gate_decisions WHERE tenant_id=? AND final_action='warn' AND status='approved' AND decided_at>=? AND decided_at<?`) as WarnProceedStatement};
}

export function warnProceededCount(tenant:TenantDb,fromMs:number,toMs:number,statements:NudgeStatements):number {
  return tenant.get(statements.warnProceeded,fromMs,toMs)!.n;
}
