import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PINNABLE_PROVIDERS, type PinnableProvider, type Provider } from '../../shared/api.js';
import { estimateModelCostMicrousd,type CredentialBillingSource } from './billing.js';
import { GovernanceError } from './errors.js';

export const DIRECT_US_VENDOR_PROVIDERS=PINNABLE_PROVIDERS;
export type DirectUsVendorProvider=PinnableProvider;
export type RoutingEffort='fast'|'standard'|'deep';
export type ReasoningEffort='none'|'low'|'medium'|'high';
export type VendorJurisdictionConstraint='us'|'any';
export type ProcessingRegionConstraint='us'|'any';
export type RoutingTaskProfile='code'|'writing'|'document'|'current'|'general';

const providerRank=new Map<Provider,number>(DIRECT_US_VENDOR_PROVIDERS.map((provider,index)=>[provider,index]));
const qualityForEffort:Readonly<Record<RoutingEffort,1|2|3>>={fast:1,standard:2,deep:3};
const reasoningForEffort:Readonly<Record<RoutingEffort,Exclude<ReasoningEffort,'none'>>>={fast:'low',standard:'medium',deep:'high'};

export interface RoutingCandidate {
  readonly tenantModelId:string;
  readonly platformModelVersionId:string|null;
  readonly provider:Provider;
  readonly providerModel:string;
  readonly displayName:string;
  readonly capabilities:readonly string[];
  readonly speedClass:'unknown'|'fast'|'balanced'|'slow';
  readonly qualityTier:number;
  readonly multiModelEligible:boolean;
  readonly vendorJurisdiction:'us'|'non_us'|'unknown';
  readonly processingRegion:'us'|'global'|'unknown';
  readonly preferenceWeight:number;
  readonly enabled:boolean;
  readonly providerConfigured:boolean;
  readonly credentialSource:CredentialBillingSource;
  readonly estimatedProviderCostMicrousd:number;
  readonly transport:'api';
}

export interface RoutingIntent {
  readonly mode:'auto'|'single';
  readonly effort:RoutingEffort;
  readonly preferredProvider?:DirectUsVendorProvider;
  readonly preferredTenantModelId?:string;
  readonly requiredCapabilities?:readonly string[];
  readonly vendorJurisdiction?:VendorJurisdictionConstraint;
  readonly processingRegion?:ProcessingRegionConstraint;
  /** Used only in memory to choose among already-eligible providers. It is never persisted. */
  readonly taskText?:string;
  /** A non-secret stable key, normally tenant/user/conversation ids, for fair general-task routing. */
  readonly stableRoutingKey?:string;
}

export interface SingleRouteSelection {
  readonly baseline:RoutingCandidate;
  readonly selected:RoutingCandidate;
  readonly baselineCostMicrousd:number;
  readonly selectedProviderCostMicrousd:number;
  readonly reasoningEffort:ReasoningEffort;
  readonly reasons:readonly string[];
}

function direct(provider:Provider):provider is DirectUsVendorProvider {return providerRank.has(provider);}
function stable(a:RoutingCandidate,b:RoutingCandidate):number {
  return (providerRank.get(a.provider)??99)-(providerRank.get(b.provider)??99)||a.providerModel.localeCompare(b.providerModel)||a.tenantModelId.localeCompare(b.tenantModelId);
}

const DOCUMENT_CUE=/(?:\b(?:attachment|contract|csv|document|long[- ]?form|pdf|report|spreadsheet|transcript)\b|\u6587\u4ef6|\u6587\u6a94|\u5831\u544a|\u5408\u7d04|\u9644\u4ef6|\u9010\u5b57\u7a3f)/iu;
const CURRENT_CUE=/(?:\b(?:breaking|latest|news|reddit|social media|today|trending|twitter|x post)\b|\u4eca\u5929|\u6700\u65b0|\u65b0\u805e|\u65b0\u95fb|\u793e\u7fa4|\u793e\u4ea4\u5a92\u9ad4|\u8da8\u52e2|\u8d8b\u52bf)/iu;
const CODE_CUE=/(?:```|\b(?:api|bug|class|code|compiler|debug|exception|function|javascript|python|regex|runtime|sql|stack trace|typescript|unit test)\b|\u4ee3\u78bc|\u4ee3\u7801|\u9664\u932f|\u8abf\u8a66|\u8c03\u8bd5|\u7a0b\u5f0f|\u7a0b\u5e8f)/iu;
const WRITING_CUE=/(?:\b(?:copywriting|draft|email|essay|memo|rewrite|story|style|tone|translate|writing)\b|\u6539\u5beb|\u6539\u5199|\u6587\u6848|\u6587\u7ae0|\u5beb\u4f5c|\u5199\u4f5c|\u6545\u4e8b|\u7ffb\u8b6f|\u7ffb\u8bd1|\u8a9e\u6c23|\u8bed\u6c14|\u90f5\u4ef6|\u96fb\u90f5)/iu;

/** Local, deterministic task classification. It performs no provider or network call. */
export function classifyRoutingTask(taskText=''):RoutingTaskProfile {
  const text=taskText.trim();
  if(text.length>=8_000||DOCUMENT_CUE.test(text))return'document';
  if(CURRENT_CUE.test(text))return'current';
  if(CODE_CUE.test(text))return'code';
  if(WRITING_CUE.test(text))return'writing';
  return'general';
}

const profileProvider:Readonly<Partial<Record<RoutingTaskProfile,DirectUsVendorProvider>>>=Object.freeze({
  code:'openai',writing:'anthropic',document:'google',current:'xai',
});

function providerForTask(intent:RoutingIntent,candidates:readonly RoutingCandidate[],profile:RoutingTaskProfile):DirectUsVendorProvider|undefined {
  const available=[...new Set(candidates.map(candidate=>candidate.provider).filter(direct))]
    .sort((a,b)=>(providerRank.get(a)??99)-(providerRank.get(b)??99));
  const profiled=profileProvider[profile];if(profiled&&available.includes(profiled))return profiled;
  if(available.length===0)return undefined;
  const key=intent.stableRoutingKey?.trim()||intent.taskText?.trim()||'general';
  const slot=createHash('sha256').update(key).digest().readUInt32BE(0)%available.length;
  return available[slot];
}

export function eligibleRoutingCandidates(intent:Pick<RoutingIntent,'requiredCapabilities'|'vendorJurisdiction'|'processingRegion'>,candidates:readonly RoutingCandidate[]):RoutingCandidate[] {
  const required=intent.requiredCapabilities??[];
  return candidates.filter(candidate=>candidate.enabled&&candidate.providerConfigured
    &&(!intent.vendorJurisdiction||intent.vendorJurisdiction==='any'||candidate.vendorJurisdiction==='us')
    &&(!intent.processingRegion||intent.processingRegion==='any'||candidate.processingRegion==='us')
    &&required.every(capability=>candidate.capabilities.includes(capability)));
}

function preferredBaseline(intent:RoutingIntent,candidates:readonly RoutingCandidate[]):RoutingCandidate {
  if(intent.preferredTenantModelId){
    const candidate=candidates.find(item=>item.tenantModelId===intent.preferredTenantModelId);
    if(!candidate)throw new GovernanceError('model_not_allowed','Requested model is unavailable under the active routing constraints');
    if(intent.preferredProvider&&candidate.provider!==intent.preferredProvider)throw new GovernanceError('model_not_allowed','Requested model does not belong to the requested provider');
    return candidate;
  }
  const providerCandidates=intent.preferredProvider?candidates.filter(item=>item.provider===intent.preferredProvider):candidates;
  if(providerCandidates.length===0){
    if(intent.preferredProvider)throw new GovernanceError('provider_not_allowed','Requested provider has no eligible model');
    throw new GovernanceError('no_models_available','No model satisfies the routing constraints');
  }
  const desired=qualityForEffort[intent.effort];
  const qualityDistance=Math.min(...providerCandidates.map(candidate=>Math.abs(candidate.qualityTier-desired)));
  const effortCandidates=providerCandidates.filter(candidate=>Math.abs(candidate.qualityTier-desired)===qualityDistance);
  const profile=classifyRoutingTask(intent.taskText),taskProvider=intent.mode==='auto'&&!intent.preferredProvider
    ?providerForTask(intent,effortCandidates,profile):undefined;
  return [...effortCandidates].sort((a,b)=>Number(b.provider===taskProvider)-Number(a.provider===taskProvider)
    ||b.qualityTier-a.qualityTier||b.preferenceWeight-a.preferenceWeight||a.estimatedProviderCostMicrousd-b.estimatedProviderCostMicrousd||stable(a,b))[0]!;
}

/** Selects the preferred eligible route deterministically. */
export function selectSingleRoute(intent:RoutingIntent,candidates:readonly RoutingCandidate[]):SingleRouteSelection {
  const eligible=eligibleRoutingCandidates(intent,candidates);
  if(eligible.length===0)throw new GovernanceError('no_models_available','No model satisfies the routing constraints');
  const taskProfile=intent.mode==='auto'&&!intent.preferredProvider&&!intent.preferredTenantModelId?classifyRoutingTask(intent.taskText):null;
  const baseline=preferredBaseline(intent,eligible),selected=baseline;
  const reasoning=selected.capabilities.includes('reasoning')?reasoningForEffort[intent.effort]:'none';
  return {
    baseline,selected,baselineCostMicrousd:baseline.estimatedProviderCostMicrousd,
    selectedProviderCostMicrousd:selected.estimatedProviderCostMicrousd,
    reasoningEffort:reasoning,
    reasons:[`mode:${intent.mode}`,`effort:${intent.effort}`,`vendor:${intent.vendorJurisdiction??'any'}`,`processing:${intent.processingRegion??'any'}`,
      taskProfile?`task:${taskProfile}`:'task:explicit'],
  };
}

export const MULTI_MODEL_EXECUTION_ROLES=['draft','critique','alternative','refine','consolidate'] as const;
export type MultiModelExecutionRole=(typeof MULTI_MODEL_EXECUTION_ROLES)[number];
export interface MultiModelExecutionPlan {readonly ordinal:1|2|3|4|5;readonly role:MultiModelExecutionRole;readonly candidate:RoutingCandidate}
export interface FastMultiModelPlan {
  readonly executions:readonly MultiModelExecutionPlan[];
  readonly providerFamilies:readonly Provider[];
  readonly estimatedProviderCostMicrousd:number;
}

/** Fast multi-model is exactly five executions and requires at least two provider families. */
export function selectFastMultiModelPlan(candidates:readonly RoutingCandidate[],constraints:Pick<RoutingIntent,'requiredCapabilities'|'vendorJurisdiction'|'processingRegion'>={}):FastMultiModelPlan {
  const eligible=eligibleRoutingCandidates(constraints,candidates).filter(candidate=>candidate.multiModelEligible&&candidate.speedClass==='fast'&&candidate.qualityTier===1);
  const byProvider=new Map<Provider,RoutingCandidate>();
  for(const candidate of [...eligible].sort((a,b)=>a.estimatedProviderCostMicrousd-b.estimatedProviderCostMicrousd||stable(a,b))){
    if(!byProvider.has(candidate.provider))byProvider.set(candidate.provider,candidate);
  }
  const families=[...byProvider.keys()].sort((a,b)=>(providerRank.get(a)??99)-(providerRank.get(b)??99)||a.localeCompare(b));
  if(families.length<2)throw new GovernanceError('no_models_available','Multi-model mode requires fast models from at least two eligible provider families');
  const choices=families.map(provider=>byProvider.get(provider)!);
  const executions=MULTI_MODEL_EXECUTION_ROLES.map((role,index)=>({ordinal:(index+1) as 1|2|3|4|5,role,candidate:choices[index%choices.length]!}));
  const estimated=executions.reduce((total,execution)=>total+execution.candidate.estimatedProviderCostMicrousd,0);
  if(!Number.isSafeInteger(estimated))throw new GovernanceError('pricing_overflow','Multi-model estimate exceeds the safe integer range');
  return {executions,providerFamilies:families,estimatedProviderCostMicrousd:estimated};
}

interface CandidateRow {
  tenant_model_id:string;platform_model_version_id:string|null;provider_key:Provider;model_key:string;display_name:string;capabilities_json:string;
  speed_class:RoutingCandidate['speedClass'];quality_tier:number;multi_model_eligible:0|1;
  vendor_jurisdiction:RoutingCandidate['vendorJurisdiction'];processing_region:RoutingCandidate['processingRegion'];preference_weight:number;
  enabled:0|1;credential_source:'environment'|'encrypted';credential_ciphertext:string|null;
  input_price:number;output_price:number;cached_input_price:number|null;max_output_tokens:number;
}
interface StatusRow {tenant_status:string;user_status:string}

export interface LoadRoutingCandidatesInput {
  readonly tenantId:string;readonly userId:string;readonly inputTokens:number;readonly outputTokens:number;readonly cachedInputTokens?:number;
  readonly now:number;
}

/** Expected response size used for allowance routing; actual usage is settled without this cap. */
export const ROUTING_OUTPUT_TOKEN_ESTIMATE=1_024;

/** Loads only models the user can access through both model and provider group grants. */
export function loadRoutingCandidates(database:Database.Database,input:LoadRoutingCandidatesInput):RoutingCandidate[] {
  const status=database.prepare<[string,string],StatusRow>(`SELECT t.status tenant_status,u.status user_status FROM tenants t JOIN users u ON u.tenant_id=t.id
    WHERE t.id=? AND u.id=? AND u.deleted_at IS NULL`).get(input.tenantId,input.userId);
  if(!status)throw new GovernanceError('resource_not_found','Tenant or user was not found');
  if(status.tenant_status!=='active')throw new GovernanceError('tenant_inactive','Tenant is not active');
  if(status.user_status!=='active')throw new GovernanceError('account_inactive','Account is not active');
  const rows=database.prepare<[string,string],CandidateRow>(`SELECT DISTINCT m.id tenant_model_id,m.platform_model_version_id,m.provider_key,m.model_key,m.display_name,
      m.capabilities_json,m.speed_class,m.quality_tier,m.multi_model_eligible,m.vendor_jurisdiction,
      m.processing_region,m.preference_weight,m.enabled,pc.credential_source,pc.credential_ciphertext,
      m.input_microusd_per_million input_price,m.output_microusd_per_million output_price,m.cached_input_microusd_per_million cached_input_price,m.max_output_tokens
    FROM group_members member
    JOIN groups g ON g.id=member.group_id AND g.tenant_id=member.tenant_id AND g.deleted_at IS NULL
    JOIN group_model_access gm ON gm.group_id=g.id AND gm.enabled=1
    JOIN model_catalog m ON m.id=gm.model_catalog_id AND m.tenant_id=member.tenant_id AND m.enabled=1
    JOIN provider_config pc ON pc.tenant_id=member.tenant_id AND pc.provider_key=m.provider_key AND pc.enabled=1
    JOIN group_provider_access gp ON gp.group_id=g.id AND gp.provider_config_id=pc.id AND gp.enabled=1
    WHERE member.tenant_id=? AND member.user_id=? ORDER BY m.id`).all(input.tenantId,input.userId);
  return rows.map(row=>{
    const capabilities=JSON.parse(row.capabilities_json) as unknown,caps=Array.isArray(capabilities)?capabilities.filter((value):value is string=>typeof value==='string'):[];
    const providerConfigured=row.credential_source==='encrypted'&&Boolean(row.credential_ciphertext);
    const estimate=estimateModelCostMicrousd({inputTokens:input.inputTokens,outputTokens:Math.min(input.outputTokens,row.max_output_tokens),cachedInputTokens:input.cachedInputTokens??0,
      inputMicrousdPerMillion:row.input_price,outputMicrousdPerMillion:row.output_price,cachedInputMicrousdPerMillion:row.cached_input_price});
    return {tenantModelId:row.tenant_model_id,platformModelVersionId:row.platform_model_version_id,provider:row.provider_key,providerModel:row.model_key,
      displayName:row.display_name,capabilities:caps,speedClass:row.speed_class,qualityTier:row.quality_tier,multiModelEligible:Boolean(row.multi_model_eligible),
      vendorJurisdiction:row.vendor_jurisdiction,processingRegion:row.processing_region,preferenceWeight:row.preference_weight,
      enabled:Boolean(row.enabled),providerConfigured,credentialSource:'byok',estimatedProviderCostMicrousd:estimate,transport:'api'};
  });
}
