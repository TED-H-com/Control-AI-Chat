type Row=Readonly<Record<string,unknown>>;

const text=(value:unknown):string=>typeof value==='string'?value:'';
const number=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)?value:0;
const boolean=(value:unknown):boolean=>value===true||value===1;
export const adminInstantIso=(value:unknown):string|null=>{
  let milliseconds:unknown=value;
  if(typeof value==='string'&&/^\d+$/u.test(value.trim()))milliseconds=Number(value);
  if(typeof milliseconds==='number'){
    if(!Number.isFinite(milliseconds))return null;
    if(Math.abs(milliseconds)<100_000_000_000)milliseconds*=1_000;
  }else if(typeof value==='string'){
    const parsed=Date.parse(value);
    if(Number.isNaN(parsed))return null;
    milliseconds=parsed;
  }else return null;
  const date=new Date(milliseconds as number);
  return Number.isNaN(date.getTime())?null:date.toISOString();
};
const iso=adminInstantIso;
const jsonList=(value:unknown):string[]=>{
  if(typeof value!=='string')return[];
  try{const parsed=JSON.parse(value) as unknown;return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];}catch{return[];}
};

export function groupWire(row:Row):Row{return{
  id:text(row.id),name:text(row.name),description:row.description===null?null:text(row.description),
  memberCount:number(row.member_count),system:boolean(row.is_system),
  version:number(row.updated_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
};}

export function modelWire(row:Row):Row{return{
  id:text(row.id),displayName:text(row.display_name),provider:text(row.provider_key),providerModelId:text(row.model_key),
  transport:'api',systemPromptEligible:true,
  enabled:boolean(row.enabled),isTenantDefault:boolean(row.is_default),capabilities:jsonList(row.capabilities_json),
  contextWindowTokens:number(row.context_window),maxOutputTokens:number(row.max_output_tokens),
  inputPriceMicroUsdPerMillion:number(row.input_microusd_per_million),outputPriceMicroUsdPerMillion:number(row.output_microusd_per_million),
  cachedInputPriceMicroUsdPerMillion:row.cached_input_microusd_per_million===null?null:number(row.cached_input_microusd_per_million),
  speedClass:text(row.speed_class),qualityTier:number(row.quality_tier),multiModelEligible:boolean(row.multi_model_eligible),
  vendorJurisdiction:text(row.vendor_jurisdiction),processingRegion:text(row.processing_region),preferenceWeight:number(row.preference_weight),
  enabledGroupCount:number(row.enabled_group_count),version:number(row.updated_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
};}

export function assistantWire(row:Row):Row{return{
  id:text(row.id),name:text(row.name),description:row.description===null?null:text(row.description),
  systemPrompt:text(row.system_prompt),modelCatalogId:text(row.model_catalog_id),model:text(row.model),
  version:number(row.version),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
};}

export function providerWire(rows:readonly Row[]):Row[]{
  const grouped=new Map<string,Row[]>();
  for(const row of rows){const provider=text(row.provider_key);if(!provider)continue;const items=grouped.get(provider)??[];items.push(row);grouped.set(provider,items);}
  return [...grouped.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([provider,items])=>{
    const first=items[0]!;
    const rawSuffix=typeof first.credential_masked_suffix==='string'?first.credential_masked_suffix.trim():'';
    return {id:provider,provider,name:provider,enabled:boolean(first.enabled),status:boolean(first.enabled)?'active':'disabled',
      credentialSource:boolean(first.credential_configured)?'byok':'unconfigured',baseUrl:first.base_url===null?null:text(first.base_url),
      maskedSuffix:boolean(first.credential_configured)&&rawSuffix?rawSuffix.slice(-4):null,
      enabledGroups:items.filter(item=>boolean(item.group_enabled)&&typeof item.group_name==='string').map(item=>text(item.group_name)),
      groupAccess:items.filter(item=>typeof item.group_id==='string').map(item=>({groupId:text(item.group_id),enabled:boolean(item.group_enabled),version:number(item.group_version)})),
      updatedAt:iso(first.updated_at)};
  });
}

export function budgetWire(row:Row):Row{return{
  id:text(row.id),scope:text(row.scope_type),scopeId:row.scope_id===null?null:text(row.scope_id),scopeName:row.scope_name===null?null:text(row.scope_name),period:text(row.period),metric:text(row.metric),
  softLimit:row.soft_limit===null?null:number(row.soft_limit),hardLimit:number(row.hard_limit),timezone:text(row.timezone),
  enabled:boolean(row.enabled),status:boolean(row.enabled)?'active':'disabled',version:number(row.updated_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
};}

export function detectorWire(row:Row):Row{return{
  id:text(row.id),name:text(row.key),detectorKind:text(row.kind),enabled:boolean(row.enabled),builtin:boolean(row.builtin),
  config:typeof row.config_json==='string'?JSON.parse(row.config_json) as unknown:{},version:number(row.updated_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
};}
