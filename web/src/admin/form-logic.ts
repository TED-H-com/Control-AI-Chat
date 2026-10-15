import type { ScreenKey } from './catalog.js';
import type { AdminRecord } from './types.js';
import { ApiClientError } from '../api.js';
import type {AdminUserActions} from '@shared/api';
import type {Translate} from '../i18n/index.js';
import {errorText as localizedErrorText} from '../error-message.js';

export type UserRole='member'|'compliance'|'admin'|'owner';
export type AssignableUserRole=Exclude<UserRole,'owner'>;
export type UserStatus='active'|'invited'|'suspended';
export type PrimaryScreenAction='invite-user'|'create-group'|'provider-credential'|'add-model'|'add-assistant'|'create-budget';

const PRIMARY_ACTIONS:Partial<Record<ScreenKey,PrimaryScreenAction>>={users:'invite-user',groups:'create-group',providers:'provider-credential',models:'add-model',assistants:'add-assistant',budgets:'create-budget'};
export const primaryActionForScreen=(screenKey:ScreenKey):PrimaryScreenAction|null=>PRIMARY_ACTIONS[screenKey]??null;

export interface UserDraft {email:string;displayName:string;role:AssignableUserRole}
export interface UserEditDraft {displayName:string;status:UserStatus;locale:string;role:UserRole}
export const createUserPayload=(draft:UserDraft)=>({email:draft.email.trim(),displayName:draft.displayName.trim(),role:draft.role});
export function updateUserPayload(draft:UserEditDraft,original?:UserEditDraft):Partial<UserEditDraft> {
 const next:UserEditDraft={displayName:draft.displayName.trim(),status:draft.status,locale:draft.locale.trim(),role:draft.role};
 if(!original)return next;
 const before:UserEditDraft={...original,displayName:original.displayName.trim(),locale:original.locale.trim()};
 return Object.fromEntries((Object.keys(next) as Array<keyof UserEditDraft>).filter(key=>next[key]!==before[key]).map(key=>[key,next[key]]));
}

export function recordRole(record:AdminRecord):UserRole {
 const roles=record.roles;
 if(Array.isArray(roles))for(const role of ['owner','admin','compliance','member'] as const)if(roles.includes(role))return role;
 return record.role==='owner'||record.role==='admin'||record.role==='compliance'?record.role:'member';
}

const NO_USER_ACTIONS:AdminUserActions={changeStatus:false,changeRole:false,deprovision:false,signOut:false,credentialLink:null};
export function advertisedUserActions(record:AdminRecord):AdminUserActions {
 const actions=record.actions;
 if(!actions||typeof actions!=='object'||Array.isArray(actions))return NO_USER_ACTIONS;
 const value=actions as Record<string,unknown>,credentialLink=value.credentialLink;
 return {changeStatus:value.changeStatus===true,changeRole:value.changeRole===true,deprovision:value.deprovision===true,signOut:value.signOut===true,credentialLink:credentialLink==='setup'||credentialLink==='reset'?credentialLink:null};
}

export type MutationErrorKind='default'|'membership'|'group-name';
export function mutationErrorKey(status:number|undefined,code:string|undefined,kind:MutationErrorKind):'admin.people.common.failed'|'admin.people.common.groupNameConflict'|'admin.people.common.changed'|'admin.people.members.externallyManaged' {
 if(status===404&&kind==='membership')return 'admin.people.members.externallyManaged';
 if(status===409&&code==='CONFLICT'&&kind==='group-name')return 'admin.people.common.groupNameConflict';
 if(status===412||status===428||code==='PRECONDITION_FAILED'||code==='PRECONDITION_REQUIRED')return 'admin.people.common.changed';
 return 'admin.people.common.failed';
}

export function mutationErrorText(error:unknown,t:Translate,kind:MutationErrorKind='default'):string{
 const api=error instanceof ApiClientError?error:undefined,special=mutationErrorKey(api?.status,api?.body.error.code,kind);
 return special==='admin.people.members.externallyManaged'||special==='admin.people.common.groupNameConflict'||special==='admin.people.common.changed'?t(special):localizedErrorText(error,t);
}

export const groupActionGuard=(record:AdminRecord)=>{const mutable=record.system!==true;return{canEdit:mutable,canDelete:mutable,canManageMembers:true}};

export function mutationVersion(record:AdminRecord):number {
 const value=record.version;
 // Legacy records without a read-side version still send a present precondition until their
 // read/write pair is migrated; version-bearing records must never be downgraded to that fallback.
 return typeof value==='number'&&Number.isFinite(value)?value:0;
}

const segment=(value:string)=>encodeURIComponent(value);
export const groupMemberPath=(groupId:string,userId:string)=>`/admin/groups/${segment(groupId)}/members/${segment(userId)}`;

export function memberDiff(current:readonly AdminRecord[],next:readonly AdminRecord[]):{add:string[];remove:string[]} {
 const ids=(rows:readonly AdminRecord[])=>new Set(rows.flatMap(row=>typeof row.id==='string'?[row.id]:[]));
 const before=ids(current),after=ids(next);
 return {add:[...after].filter(id=>!before.has(id)),remove:[...before].filter(id=>!after.has(id))};
}

export type ModelDraft={displayName:string;enabled:boolean;contextWindowTokens:number;maxOutputTokens:number;inputPriceUsd:string;outputPriceUsd:string;capabilities:string};
export const usdToMicroUsd=(value:string):number=>{const match=value.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);if(!match)throw new RangeError('USD must have at most six decimal places');const micros=BigInt(match[1])*1_000_000n+BigInt((match[2]??'').padEnd(6,'0'));if(micros>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('USD amount is too large');return Number(micros)};
export const microUsdToUsd=(value:number):string=>{if(!Number.isSafeInteger(value)||value<0)throw new RangeError('micro-USD must be a non-negative safe integer');const whole=Math.floor(value/1_000_000),fraction=String(value%1_000_000).padStart(6,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}.00`};
export const modelUpdatePayload=(draft:ModelDraft,original:ModelDraft)=>{const next={displayName:draft.displayName.trim(),enabled:draft.enabled,contextWindowTokens:draft.contextWindowTokens,maxOutputTokens:draft.maxOutputTokens,inputPriceMicroUsdPerMillion:usdToMicroUsd(draft.inputPriceUsd),outputPriceMicroUsdPerMillion:usdToMicroUsd(draft.outputPriceUsd),capabilities:draft.capabilities.split(',').map(x=>x.trim()).filter(Boolean)};const before={displayName:original.displayName.trim(),enabled:original.enabled,contextWindowTokens:original.contextWindowTokens,maxOutputTokens:original.maxOutputTokens,inputPriceMicroUsdPerMillion:usdToMicroUsd(original.inputPriceUsd),outputPriceMicroUsdPerMillion:usdToMicroUsd(original.outputPriceUsd),capabilities:original.capabilities.split(',').map(x=>x.trim()).filter(Boolean)};return Object.fromEntries(Object.entries(next).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(before[key as keyof typeof before])))};

export type BudgetScope='tenant'|'group'|'user';export type BudgetMetric='tokens'|'usd';
export const validBudgetScope=(scope:BudgetScope,scopeId:string|null):boolean=>scope==='tenant'?scopeId===null:Boolean(scopeId);
export const budgetLimitForApi=(metric:BudgetMetric,value:string):number=>metric==='usd'?usdToMicroUsd(value):Number(value);
export const budgetLimitForForm=(metric:BudgetMetric,value:number):string=>metric==='usd'?microUsdToUsd(value):String(value);

export interface SettingsDraft {defaultLocale:string;timezone:string;retentionDays:number;transcriptCapture:boolean;requestsPerMinute:number;concurrentStreams:number;brandName:string;supportVendorName:string;supportContactEmail:string;supportContactPhone:string;supportContactUrl:string;supportNotes:string}
export const settingsPayload=(draft:SettingsDraft,original:SettingsDraft):Partial<SettingsDraft>=>Object.fromEntries((Object.keys(draft) as Array<keyof SettingsDraft>).filter(key=>draft[key]!==original[key]).map(key=>[key,draft[key]]));
