import type { Provider } from '../../shared/api.js';

export const MULTI_MODEL_STEPS = ['draft','critique','alternative','refine','consolidate'] as const;
export type MultiModelStep = (typeof MULTI_MODEL_STEPS)[number];

export interface FastModelTarget {
  readonly catalogId:string;
  readonly provider:Provider;
  readonly modelKey:string;
  readonly displayName:string;
}

export interface MultiModelUsage {
  readonly inputTokens:number;
  readonly outputTokens:number;
  readonly providerCostMicrousd:number;
}

export interface MultiModelExecutionResult extends MultiModelUsage {
  readonly text:string;
  readonly providerRequestId:string|null;
}

export interface MultiModelExecution {
  readonly workflowId:string;
  readonly ordinal:number;
  readonly step:MultiModelStep;
  readonly idempotencyKey:string;
  readonly target:FastModelTarget;
  readonly prompt:string;
}

export interface MultiModelPort {
  /** Must replay a completed ordinal and must never dispatch it twice. */
  execute(input:MultiModelExecution,signal:AbortSignal):Promise<MultiModelExecutionResult>;
  /** Applies the normal inbound policy and returns only the releasable text. */
  authorizeOutput(input:{workflowId:string;ordinal:number;step:MultiModelStep;text:string},signal:AbortSignal):Promise<string>;
}

export interface MultiModelResult extends MultiModelUsage {
  readonly text:string;
  readonly executions:readonly (MultiModelExecutionResult&{ordinal:number;step:MultiModelStep;target:FastModelTarget})[];
}

const instruction:Readonly<Record<MultiModelStep,string>>={
  draft:'Produce a concise factual draft answer. Give conclusions and supporting facts, not hidden reasoning.',
  critique:'Review the draft for factual gaps, unsafe assumptions, and missing tradeoffs. Return concrete corrections only.',
  alternative:'Propose a materially different answer or approach that addresses the original request and the critique.',
  refine:'Build the strongest concise answer from the draft, critique, and alternative. Resolve conflicts explicitly.',
  consolidate:'Return the final answer only. Combine the strongest verified points, remove repetition, and do not mention this review process.',
};

function transcript(original:string,prior:readonly {step:MultiModelStep;text:string}[],step:MultiModelStep):string {
  const context=prior.map(item=>`[${item.step}]\n${item.text}`).join('\n\n');
  return `${instruction[step]}\n\n[original request]\n${original}${context?`\n\n[review material]\n${context}`:''}`;
}

function safeTargets(targets:readonly FastModelTarget[]):FastModelTarget[] {
  if(targets.length<2)throw new TypeError('Multi-model mode requires at least two fast model targets');
  if(new Set(targets.map(target=>target.provider)).size<2)throw new TypeError('Multi-model mode requires at least two provider families');
  const ids=new Set<string>();
  for(const target of targets){
    if(!target.catalogId||!target.modelKey||ids.has(target.catalogId))throw new TypeError('Multi-model targets must have unique catalog ids');
    ids.add(target.catalogId);
  }
  return [...targets];
}

/**
 * Runs exactly five bounded fast-model executions. The port owns durable claiming/fencing; this
 * coordinator supplies stable ordinal keys so a process restart can replay completed checkpoints.
 */
export async function runMultiModel(input:{
  workflowId:string;
  originalPrompt:string;
  targets:readonly FastModelTarget[];
  port:MultiModelPort;
  signal:AbortSignal;
}):Promise<MultiModelResult>{
  if(!input.workflowId.trim())throw new TypeError('workflowId is required');
  if(!input.originalPrompt.trim())throw new TypeError('originalPrompt is required');
  const targets=safeTargets(input.targets),prior:Array<{step:MultiModelStep;text:string}>=[],executions:Array<MultiModelExecutionResult&{ordinal:number;step:MultiModelStep;target:FastModelTarget}>=[];
  for(let index=0;index<MULTI_MODEL_STEPS.length;index++){
    if(input.signal.aborted)throw input.signal.reason;
    const ordinal=index+1,step=MULTI_MODEL_STEPS[index]!,target=targets[index%targets.length]!;
    const execution:MultiModelExecution={workflowId:input.workflowId,ordinal,step,idempotencyKey:`multi:${input.workflowId}:${ordinal}`,target,prompt:transcript(input.originalPrompt,prior,step)};
    const raw=await input.port.execute(execution,input.signal);
    const authorized=await input.port.authorizeOutput({workflowId:input.workflowId,ordinal,step,text:raw.text},input.signal);
    if(!authorized.trim())throw new Error(`Multi-model ${step} produced no policy-authorized text`);
    const result={...raw,text:authorized,ordinal,step,target};
    executions.push(result);prior.push({step,text:authorized});
  }
  const final=executions.at(-1)!;
  return {text:final.text,inputTokens:executions.reduce((sum,item)=>sum+item.inputTokens,0),outputTokens:executions.reduce((sum,item)=>sum+item.outputTokens,0),providerCostMicrousd:executions.reduce((sum,item)=>sum+item.providerCostMicrousd,0),executions};
}
