import type Database from 'better-sqlite3';
import type { TenantDb } from '../../lib/db.js';
import type { TenantId } from '../../shared/types.js';
import { timeBuckets, zonedMonthStart } from './buckets.js';

export type AnalyticsQuery = Readonly<Record<string,string|undefined>>;
export type Granularity = 'hour'|'day'|'week'|'month';
export type Dimension = 'model'|'provider'|'group'|'user'|'project';
type Statement<Row> = Database.Statement<[TenantId, ...unknown[]], Row>;

export interface PointRow { bucket:string; requests:number; active_users:number; input_tokens:number; output_tokens:number; spend_micro_usd:number; errors:number; error_rate:number; linked_requests:number; violations:number }
export interface BreakdownRow { id:string|null; label:string|null; requests:number; active_users:number; input_tokens:number; output_tokens:number; spend_micro_usd:number; average_latency_ms:number|null; p95_latency_ms:number|null; errors:number; error_rate:number; linked_requests:number; violations:number }
export interface DetectorRow { detector:string; occurrences:number }
export interface AnalyticsPoint { bucket:string; label:string; bucketStartMs:number; requests:number; activeUsers:number; inputTokens:number; outputTokens:number; totalTokens:number; spendMicroUsd:number; errors:number; errorRate:number; violations:number|null; violationRate:number|null; value:number }
export interface AnalyticsBreakdownItem { id:string|null; dimension:string|null; label:string|null; requests:number; activeUsers:number; inputTokens:number; outputTokens:number; spendMicroUsd:number; averageLatencyMs:number|null; p95LatencyMs:number|null; errors:number; errorRate:number; violations:number|null; violationRate:number|null; value:number }
export interface AnalyticsPage<Item> { items:Item[]; nextCursor:string|null; hasMore:boolean }
export interface AnalyticsStatements { readonly timeseries:Statement<PointRow>; readonly breakdown:Readonly<Record<Dimension,Statement<BreakdownRow>>>; readonly detectors:Statement<DetectorRow>; readonly timezone:Statement<{timezone:string}> }

// Usage is charged to the assistant response. Preflight decisions belong to its parent user message,
// postflight decisions belong to the response, and an approved release retains one exact link to the
// original decision. Every hop stays inside the tenant; a conversation-level join would incorrectly
// attribute every thread decision to every request.
const PARENT_MESSAGE = `(SELECT parent.id FROM messages response JOIN messages parent ON parent.tenant_id=response.tenant_id AND parent.conversation_id=response.conversation_id AND parent.id=response.parent_message_id AND parent.role='user' WHERE response.tenant_id=u.tenant_id AND response.id=u.message_id AND response.role='assistant')`;
const APPROVAL_DECISION = `(SELECT approval.gate_decision_id FROM messages response JOIN policy_approval_requests approval ON approval.tenant_id=response.tenant_id AND approval.id=response.approval_id WHERE response.tenant_id=u.tenant_id AND response.id=u.message_id AND response.role='assistant')`;
const DECISION_LINK = `d.tenant_id=u.tenant_id AND (d.message_id=u.message_id OR d.message_id=${PARENT_MESSAGE} OR d.id=${APPROVAL_DECISION})`;
const VIOLATIONS = `(SELECT COUNT(*) FROM gate_decisions d WHERE ${DECISION_LINK} AND d.final_action<>'allow')`;
// The tenant predicate is the one anonymous parameter so that TenantDb still binds it first; every
// other filter is named, because better-sqlite3 rejects positional binding of ?NNN parameters and
// the bucket and dimension expressions sit textually ahead of this clause.
const WHERE = `u.tenant_id=? AND u.started_at>=:from AND u.started_at<:to AND (:userId IS NULL OR u.user_id=:userId) AND (:groupId IS NULL OR u.group_id=:groupId) AND (:modelId IS NULL OR u.model_catalog_id=:modelId OR u.model_key=:modelId) AND (:providerKey IS NULL OR u.provider_key=:providerKey) AND (:projectId IS NULL OR u.project_id=:projectId) AND (:status IS NULL OR u.status=:status) AND (:verdict IS NULL OR EXISTS(SELECT 1 FROM gate_decisions d WHERE ${DECISION_LINK} AND d.final_action=:verdict)) AND (:detector IS NULL OR EXISTS(SELECT 1 FROM gate_decisions d,json_each(d.matched_detector_keys_json) k WHERE ${DECISION_LINK} AND k.value=:detector))`;
const DIMENSIONS:Readonly<Record<Dimension,{key:string;label:string;join:string}>> = {
  model:{key:'COALESCE(u.model_catalog_id,u.model_key)',label:'COALESCE(m.display_name,u.model_key)',join:'LEFT JOIN model_catalog m ON m.tenant_id=u.tenant_id AND m.id=u.model_catalog_id'},
  provider:{key:'u.provider_key',label:'u.provider_key',join:''},
  group:{key:'u.group_id',label:'g.name',join:'LEFT JOIN groups g ON g.tenant_id=u.tenant_id AND g.id=u.group_id'},
  user:{key:'u.user_id',label:'us.display_name',join:'LEFT JOIN users us ON us.tenant_id=u.tenant_id AND us.id=u.user_id'},
  project:{key:'u.project_id',label:'p.name',join:'LEFT JOIN projects p ON p.tenant_id=u.tenant_id AND p.id=u.project_id'},
};
const RANGES:Readonly<Record<string,number>> = {'24h':86_400_000,'7d':604_800_000,'30d':2_592_000_000,'90d':7_776_000_000};
const SORTS = ['dimension','requests','activeUsers','inputTokens','outputTokens','spendMicroUsd','averageLatencyMs','p95LatencyMs','errors','errorRate','violations','violationRate'] as const;

function timeseriesSql():string {
  return `WITH tenant_scope(tenant_id) AS (VALUES (?)),buckets AS (
    SELECT json_extract(value,'$.key') bucket,json_extract(value,'$.startMs') start_ms,json_extract(value,'$.endMs') end_ms FROM json_each(:buckets)
  ) SELECT b.bucket,b.start_ms bucket_start_ms,COUNT(u.started_at) requests,COUNT(DISTINCT u.user_id) active_users,
    COALESCE(SUM(u.input_tokens),0) input_tokens,COALESCE(SUM(u.output_tokens),0) output_tokens,COALESCE(SUM(u.cost_microusd),0) spend_micro_usd,
    COALESCE(SUM(u.status='failed'),0) errors,CASE WHEN COUNT(u.started_at)=0 THEN 0 ELSE SUM(u.status='failed')*1.0/COUNT(u.started_at) END error_rate,
    COUNT(u.message_id) linked_requests,COALESCE(SUM(CASE WHEN u.started_at IS NULL THEN 0 ELSE ${VIOLATIONS} END),0) violations
    FROM buckets b CROSS JOIN tenant_scope LEFT JOIN usage_records u ON u.tenant_id=tenant_scope.tenant_id
      AND u.started_at>=MAX(b.start_ms,:from) AND u.started_at<MIN(b.end_ms,:to)
      AND (:userId IS NULL OR u.user_id=:userId) AND (:groupId IS NULL OR u.group_id=:groupId)
      AND (:modelId IS NULL OR u.model_catalog_id=:modelId OR u.model_key=:modelId) AND (:providerKey IS NULL OR u.provider_key=:providerKey)
      AND (:projectId IS NULL OR u.project_id=:projectId) AND (:status IS NULL OR u.status=:status)
      AND (:verdict IS NULL OR EXISTS(SELECT 1 FROM gate_decisions d WHERE ${DECISION_LINK} AND d.final_action=:verdict))
      AND (:detector IS NULL OR EXISTS(SELECT 1 FROM gate_decisions d,json_each(d.matched_detector_keys_json) k WHERE ${DECISION_LINK} AND k.value=:detector))
    GROUP BY b.bucket,b.start_ms ORDER BY b.start_ms`;
}
function breakdownSql(dimension:Dimension):string {
  const {key,label,join}=DIMENSIONS[dimension];
  // CUME_DIST rather than PERCENT_RANK: percent_rank is 0 for a single-sample group, which would
  // report no p95 at all for the dimensions that have one request.
  return `WITH scoped AS (SELECT ${key} k,${label} label,u.user_id,u.message_id,u.input_tokens,u.output_tokens,u.cost_microusd,u.status,CASE WHEN u.completed_at IS NULL THEN NULL ELSE u.completed_at-u.started_at END latency,${VIOLATIONS} violations FROM usage_records u ${join} WHERE ${WHERE}),`
    +`ranked AS (SELECT k,latency,CUME_DIST() OVER (PARTITION BY k ORDER BY latency) pct FROM scoped WHERE latency IS NOT NULL) `
    +`SELECT b.*,CASE :sort WHEN 'dimension' THEN b.label WHEN 'activeUsers' THEN b.active_users WHEN 'inputTokens' THEN b.input_tokens WHEN 'outputTokens' THEN b.output_tokens WHEN 'spendMicroUsd' THEN b.spend_micro_usd WHEN 'averageLatencyMs' THEN b.average_latency_ms WHEN 'p95LatencyMs' THEN b.p95_latency_ms WHEN 'errors' THEN b.errors WHEN 'errorRate' THEN b.error_rate WHEN 'violations' THEN b.violations WHEN 'violationRate' THEN b.violations*1.0/NULLIF(b.linked_requests,0) ELSE b.requests END sort_value FROM (`
    +`SELECT s.k id,s.label label,COUNT(*) requests,COUNT(DISTINCT s.user_id) active_users,SUM(s.input_tokens) input_tokens,SUM(s.output_tokens) output_tokens,SUM(s.cost_microusd) spend_micro_usd,AVG(s.latency) average_latency_ms,(SELECT MIN(r.latency) FROM ranked r WHERE r.k IS s.k AND r.pct>=0.95) p95_latency_ms,SUM(s.status='failed') errors,SUM(s.status='failed')*1.0/COUNT(*) error_rate,SUM(s.message_id IS NOT NULL) linked_requests,SUM(s.violations) violations FROM scoped s GROUP BY s.k,s.label`
    +`) b WHERE (:search IS NULL OR b.label LIKE :search ESCAPE '\\') ORDER BY (CASE WHEN :direction='asc' THEN sort_value END) ASC,(CASE WHEN :direction='asc' THEN NULL ELSE sort_value END) DESC,b.label,b.id LIMIT :limit OFFSET :offset`;
}

/** Preparation is deliberately separate from request execution; execution always uses TenantDb. */
export function prepareAnalyticsStatements(database:Database.Database):AnalyticsStatements {
  const breakdown={} as Record<Dimension,Statement<BreakdownRow>>;
  const timeseries=database.prepare(timeseriesSql()) as Statement<PointRow>;
  for(const dimension of Object.keys(DIMENSIONS) as Dimension[]) breakdown[dimension]=database.prepare(breakdownSql(dimension)) as Statement<BreakdownRow>;
  const detectors=database.prepare(`SELECT key.value AS detector,COUNT(*) AS occurrences FROM gate_decisions d,json_each(d.matched_detector_keys_json) key WHERE d.tenant_id=? AND d.decided_at>=? AND d.decided_at<? GROUP BY key.value ORDER BY occurrences DESC,key.value ASC LIMIT ?`) as Statement<DetectorRow>;
  const timezone=database.prepare(`SELECT timezone FROM tenant_settings WHERE tenant_id=?`) as Statement<{timezone:string}>;
  return {timeseries,breakdown,detectors,timezone};
}

export function analyticsDetectors(tenant:TenantDb,rawQuery:AnalyticsQuery,statements:AnalyticsStatements,now:()=>number=Date.now):{items:Array<{label:string;value:number}>} {
  const query=clean(rawQuery),{fromMs,toMs}=resolveRange(query.range,now(),tenantTimeZone(tenant,statements));
  const rows=tenant.all(statements.detectors,fromMs,toMs,12);
  return {items:rows.map(row=>({label:row.detector,value:row.occurrences}))};
}

export function analyticsTimeseries(tenant:TenantDb,rawQuery:AnalyticsQuery,statements:AnalyticsStatements,now:()=>number=Date.now):AnalyticsPage<AnalyticsPoint>&{granularity:Granularity} {
  const query=clean(rawQuery),timeZone=tenantTimeZone(tenant,statements),selected=granularity(query.granularity,query.range),window=resolveRange(query.range,now(),timeZone),buckets=timeBuckets(window.fromMs,window.toMs,selected,timeZone);
  const rows=tenant.all(statements.timeseries,{...filters(query,now(),5_000,0,timeZone),buckets:JSON.stringify(buckets)});
  return {items:rows.map(point),nextCursor:null,hasMore:false,granularity:selected};
}

export function analyticsBreakdown(tenant:TenantDb,rawQuery:AnalyticsQuery,statements:AnalyticsStatements,now:()=>number=Date.now):AnalyticsPage<AnalyticsBreakdownItem> {
  const query=clean(rawQuery),limit=bounded(query.limit),offset=cursorOffset(query.cursor);
  const sort=query.sort===undefined?'requests':one(query.sort,SORTS,'sort');
  const rows=tenant.all(statements.breakdown[dimension(query.dimension)],{...filters(query,now(),limit,offset,tenantTimeZone(tenant,statements)),search:like(query.search),sort,direction:query.direction==='asc'?'asc':'desc'});
  return page(rows.map(item),limit,offset);
}

// A cleared filter arrives as an empty string, which would otherwise match nothing at all.
function clean(query:AnalyticsQuery):AnalyticsQuery {
  const result:Record<string,string>={};
  for(const [key,value] of Object.entries(query)) if(value!==undefined&&value.trim()!=='')result[key]=value.trim();
  return result;
}
// The Analytics screen sends `group`/`model`/`project`; the Overview screen sends the same filters
// as `groupId`/`modelId`/`projectId`, and both call these two endpoints.
function filters(query:AnalyticsQuery,nowMs:number,limit:number,offset:number,timeZone='UTC'):Record<string,unknown> {
  const window=range(query.range,nowMs,timeZone);
  return {from:window.fromMs,to:window.toMs,userId:query.user??query.userId??null,groupId:query.group??query.groupId??null,modelId:query.model??query.modelId??null,providerKey:query.provider??query.providerId??null,projectId:query.project??query.projectId??null,status:query.status??null,verdict:query.verdict??null,detector:query.detector??null,limit:limit+1,offset};
}
function point(row:PointRow&{bucket_start_ms?:number}):AnalyticsPoint {
  return {bucket:row.bucket,label:row.bucket,bucketStartMs:Number(row.bucket_start_ms),requests:row.requests,activeUsers:row.active_users,inputTokens:row.input_tokens,outputTokens:row.output_tokens,totalTokens:row.input_tokens+row.output_tokens,spendMicroUsd:row.spend_micro_usd,errors:row.errors,errorRate:row.error_rate,...(row.requests===0?{violations:0,violationRate:0}:violations(row)),value:row.requests};
}
function item(row:BreakdownRow):AnalyticsBreakdownItem {
  // `dimension` is the catalog's column key and `label` is what the chart reads; both are the name
  // of the grouped entity. `value` feeds the Overview spend chart.
  return {id:row.id,dimension:row.label,label:row.label,requests:row.requests,activeUsers:row.active_users,inputTokens:row.input_tokens,outputTokens:row.output_tokens,spendMicroUsd:row.spend_micro_usd,averageLatencyMs:row.average_latency_ms,p95LatencyMs:row.p95_latency_ms,errors:row.errors,errorRate:row.error_rate,...violations(row),value:row.spend_micro_usd};
}
// Historical or externally imported usage can still have no message link. Reporting zero there
// would read as "no violations" instead of "not attributable".
function violations(row:{linked_requests:number;violations:number}):{violations:number|null;violationRate:number|null} {
  return row.linked_requests===0?{violations:null,violationRate:null}:{violations:row.violations,violationRate:row.violations/row.linked_requests};
}
function page<Item>(items:Item[],limit:number,offset:number):AnalyticsPage<Item> {
  const hasMore=items.length>limit; if(hasMore)items.pop();
  return {items,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({v:1,offset:offset+limit})).toString('base64url'):null};
}
/**
 * Exported because the Overview screen calls /admin/dashboard, /analytics/timeseries and
 * /analytics/breakdown together with one `range`, and the KPI cards would otherwise cover a
 * different window than the chart drawn under them.
 */
export function resolveRange(value:string|undefined,nowMs:number,timeZone='UTC'):{fromMs:number;toMs:number} {
  return range(value,nowMs,timeZone);
}
function range(value:string|undefined,nowMs:number,timeZone:string):{fromMs:number;toMs:number} {
  const key=value??'30d';
  if(key==='month')return {fromMs:zonedMonthStart(nowMs,timeZone),toMs:nowMs+1};
  const span=RANGES[key]; if(span===undefined)throw new TypeError(`range must be one of ${Object.keys(RANGES).join(', ')}, month`);
  return {fromMs:nowMs-span,toMs:nowMs+1};
}
// A 24h window over per-day buckets is a single point, so the default follows the range.
function granularity(value:string|undefined,rangeValue:string|undefined):Granularity {
  return value===undefined?(rangeValue==='24h'?'hour':'day'):one(value,['hour','day','week','month'] as const,'granularity');
}
function tenantTimeZone(tenant:TenantDb,statements:AnalyticsStatements):string {return tenant.get(statements.timezone)?.timezone??'UTC'}
function dimension(value:string|undefined):Dimension {
  return value===undefined?'model':one(value,Object.keys(DIMENSIONS) as Dimension[],'dimension');
}
function one<T extends string>(value:string,allowed:readonly T[],name:string):T {
  if(!(allowed as readonly string[]).includes(value))throw new TypeError(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}
function bounded(value:string|undefined):number {
  const parsed=value===undefined?100:Number(value);
  if(!Number.isInteger(parsed)||parsed<1||parsed>500)throw new TypeError('limit must be 1..500');
  return parsed;
}
function like(value:string|undefined):string|null {
  return value===undefined?null:`%${value.replace(/[\\%_]/gu,character=>`\\${character}`)}%`;
}
// Unsigned, unlike the audit cursor: this one carries an offset into an already tenant-scoped and
// permission-checked aggregate, so forging it grants no access the same query would not return.
function cursorOffset(value:string|undefined):number {
  if(value===undefined)return 0;
  try { const decoded=JSON.parse(Buffer.from(value,'base64url').toString()) as {v?:unknown;offset?:unknown};
    if(decoded.v===1&&Number.isInteger(decoded.offset)&&Number(decoded.offset)>=0&&Number(decoded.offset)<=1_000_000)return Number(decoded.offset); } catch { /* falls through to the shared rejection */ }
  throw new TypeError('cursor is not a valid analytics cursor');
}
