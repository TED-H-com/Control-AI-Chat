import type { DetectorMatch,GateAction } from './types.js';
export const GATE_ACTION_RANK:Readonly<Record<GateAction,number>>={allow:0,flag:10,redact:20,mask:25,warn:30,block:40,require_approval:50};
export function strongestAction(matches:readonly DetectorMatch[]):GateAction { let result:GateAction='allow'; for(const match of matches) if(GATE_ACTION_RANK[match.action]>GATE_ACTION_RANK[result]) result=match.action; return result }
export function deduplicateMatches(matches:readonly DetectorMatch[]):DetectorMatch[]{ const seen=new Set<string>(); return matches.filter(match=>{const span=match.span?`${match.span.start}:${match.span.end}`:'none';const key=`${match.ruleId}\0${match.partId}\0${span}\0${match.category}`;if(seen.has(key))return false;seen.add(key);return true}) }
