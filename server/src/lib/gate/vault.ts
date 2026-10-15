import { randomBytes } from 'node:crypto';
import type { AppliedMask,AppliedRedaction,DetectorMatch,GateContentPart,GateContext,GateVault,TextSpan } from './types.js';
import { sliceCodePoints } from './normalize.js';
import { GATE_ACTION_RANK } from './action.js';

const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32(bytes:Uint8Array,length:number):string{let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5&&out.length<length){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5}}return out.padEnd(length,'0')}
type TransformMatch=DetectorMatch&{span:NonNullable<DetectorMatch['span']>};
function plans(matches:readonly DetectorMatch[]):TransformMatch[]{const candidates=matches.filter((match):match is TransformMatch=>(match.action==='redact'||match.action==='mask')&&match.span!==null).sort((a,b)=>a.partId.localeCompare(b.partId)||(a.span.start-b.span.start)||(b.span.end-a.span.end)||GATE_ACTION_RANK[b.action]-GATE_ACTION_RANK[a.action]),merged:TransformMatch[]=[];for(const item of candidates){const last=merged.at(-1);if(last&&last.partId===item.partId&&item.span.start<=last.span.end){const winner=GATE_ACTION_RANK[item.action]>GATE_ACTION_RANK[last.action]?item:last;merged[merged.length-1]={...winner,span:{start:last.span.start,end:Math.max(last.span.end,item.span.end)}}}else merged.push(item)}return merged}
export function sanitizeMaskReplacement(value:unknown):string{if(typeof value!=='string')return'[MASKED]';const sanitized=value.replace(/[⟦⟧]/g,'').replace(/REDACTED:/g,'').trim().slice(0,128);return sanitized||'[MASKED]'}
function maskReplacement(context:GateContext,item:TransformMatch):string{return sanitizeMaskReplacement(context.policySnapshot.rules.find(rule=>rule.id===item.ruleId)?.config.maskReplacement)}
function applyReplacements(text:string,replacements:readonly {span:TextSpan;value:string}[]):string{if(!replacements.length)return text;const output:string[]=[];let cursor=0;for(const replacement of replacements){output.push(sliceCodePoints(text,{start:cursor,end:replacement.span.start}),replacement.value);cursor=replacement.span.end}output.push(sliceCodePoints(text,{start:cursor,end:Number.MAX_SAFE_INTEGER}));return output.join('')}
export function maskWithoutVault(context:GateContext,matches:readonly DetectorMatch[]):{parts:readonly GateContentPart[];redactions:readonly AppliedRedaction[];masks:readonly AppliedMask[]}{const selected=plans(matches).filter(item=>item.action==='mask'),masks:AppliedMask[]=[];const parts=context.parts.map(part=>{const replacements:{span:TextSpan;value:string}[]=[];for(const item of selected.filter(match=>match.partId===part.id).reverse()){const replacement=maskReplacement(context,item);replacements.push({span:item.span,value:replacement});masks.push({label:item.replacementLabel??'MASKED',partId:part.id,originalSpan:item.span,replacement,ruleIds:[item.ruleId]})}return{...part,text:applyReplacements(part.text,replacements.reverse())}});return{parts,redactions:[],masks}}

/** Issues the established UI token and deliberately retains no original or per-token state. */
export class StatelessGateVault implements GateVault {
  async redact(context:GateContext,matches:readonly DetectorMatch[]){
    const selected=plans(matches),redactions:AppliedRedaction[]=[],masks:AppliedMask[]=[],parts:GateContentPart[]=[];
    for(const part of context.parts){
      const replacements:{span:TextSpan;value:string}[]=[];
      for(const item of selected.filter(match=>match.partId===part.id).reverse()){
        const span=item.span;
        if(item.action==='mask'){const replacement=maskReplacement(context,item);replacements.push({span,value:replacement});masks.push({label:item.replacementLabel??'MASKED',partId:part.id,originalSpan:span,replacement,ruleIds:[item.ruleId]});continue}
        if(!item.replacementLabel)continue;
        const label=item.replacementLabel.replace(/[^A-Z0-9_]/g,'_').slice(0,32),tokenId=base32(randomBytes(16),26),check=base32(randomBytes(5),8),token=`⟦REDACTED:${label}:${tokenId}:${check}⟧`;
        redactions.push({token,label,partId:part.id,originalSpan:span,ruleIds:[item.ruleId]});
        replacements.push({span,value:token});
      }
      parts.push({...part,text:applyReplacements(part.text,replacements.reverse())});
    }
    return {parts,redactions,masks};
  }
}
