export interface LockoutState {failedLoginCount:number;firstFailedLoginAt:number|null;lockedUntil:number|null}
export interface LockoutDecision extends LockoutState {becameLocked:boolean}
export function registerLoginFailure(state:LockoutState,now=Date.now()):LockoutDecision{const within=state.firstFailedLoginAt!==null&&now-state.firstFailedLoginAt<=3_600_000;const count=within?state.failedLoginCount+1:1;const first=within?state.firstFailedLoginAt:now;const delays=[0,0,0,60_000,300_000,900_000,3_600_000,21_600_000];const delay=delays[Math.min(count-1,delays.length-1)]!;return{failedLoginCount:count,firstFailedLoginAt:first,lockedUntil:delay?now+delay:null,becameLocked:delay>0};}
export function resetLoginFailures():LockoutState{return{failedLoginCount:0,firstFailedLoginAt:null,lockedUntil:null};}
export function lockoutRemaining(state:LockoutState,now=Date.now()):number{return state.lockedUntil===null?0:Math.max(0,state.lockedUntil-now);}
