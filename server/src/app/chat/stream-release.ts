import { POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS } from '../../lib/gate/engine.js';
import { GATE_ACTION_RANK } from '../../lib/gate/action.js';
import type { GateAction } from '../../shared/api.js';

export const POSTFLIGHT_STREAM_MAX_RETAINED_CODE_POINTS=16_384;

export interface StreamReplacement {
  readonly originalSpan:{readonly start:number;readonly end:number};
  readonly replacement:string;
}

export interface StreamGateResult {
  readonly decisionId:string;
  readonly action:GateAction;
  readonly protectedItemCount:number|null;
  readonly effectiveText:string;
  readonly replacements?:readonly StreamReplacement[];
}

export interface StreamReleasePlan {
  readonly displayText:string;
  readonly rawTail:string;
  readonly protectedItemCount:number;
}

/** Accumulates the strongest inbound action and counts only replacements that have been released. */
export class StreamProtectionAccumulator<T extends StreamGateResult> {
  protectedItemCount=0;
  #strongest:T|null=null;
  #lastNoticeAction:GateAction='allow';
  #lastNoticeCount=0;

  observe(result:T,releasedCount:number):T|null {
    this.protectedItemCount+=releasedCount;
    if(!this.#strongest||GATE_ACTION_RANK[result.action]>=GATE_ACTION_RANK[this.#strongest.action])this.#strongest=result;
    const effective=this.#strongest;
    if((effective.action==='allow'||effective.action==='flag')||(effective.action===this.#lastNoticeAction&&this.protectedItemCount===this.#lastNoticeCount))return null;
    this.#lastNoticeAction=effective.action;this.#lastNoticeCount=this.protectedItemCount;
    return{...effective,protectedItemCount:this.protectedItemCount};
  }
}

/** Plans one release from a verdict whose spans are expressed in raw-input code points. */
export function planStreamRelease(rawText:string,verdict:StreamGateResult,drain=false):StreamReleasePlan {
  const raw=Array.from(rawText),replacements=[...(verdict.replacements??[])].sort((left,right)=>left.originalSpan.start-right.originalSpan.start||left.originalSpan.end-right.originalSpan.end);
  const wholeDisplay:string[]=[];let previousEnd=0;
  for(const item of replacements){
    const {start,end}=item.originalSpan;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<previousEnd||start<0||end<=start||end>raw.length)throw new Error('Inbound gate returned invalid replacement spans');
    wholeDisplay.push(raw.slice(previousEnd,start).join(''),item.replacement);
    previousEnd=end;
  }
  wholeDisplay.push(raw.slice(previousEnd).join(''));
  if(wholeDisplay.join('')!==verdict.effectiveText)throw new Error('Inbound gate display does not match replacement spans');
  let cut=drain?raw.length:Math.max(0,raw.length-POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS);
  for(const item of replacements){const {start,end}=item.originalSpan;if(start<cut&&cut<end){cut=start;break;}if(start>=cut)break;}
  if(!drain&&raw.length-cut>POSTFLIGHT_STREAM_MAX_RETAINED_CODE_POINTS)throw new Error('Inbound gate retained tail exceeds safe limit');
  const display:string[]=[];let cursor=0,protectedItemCount=0;
  for(const item of replacements){const {start,end}=item.originalSpan;if(end>cut)break;display.push(raw.slice(cursor,start).join(''),item.replacement);cursor=end;protectedItemCount++;}
  display.push(raw.slice(cursor,cut).join(''));
  const displayText=display.join('');
  return{displayText,rawTail:raw.slice(cut).join(''),protectedItemCount};
}
