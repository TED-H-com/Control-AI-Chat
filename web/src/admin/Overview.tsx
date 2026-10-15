import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatCurrency, formatNumber, runtimeTranslation, useI18n, type Locale, type Translate, type TranslationKey } from '../i18n/index.js';
import { adminGet } from './api.js';
import { BarChart, ChartCard, LineChart, type SeriesPoint } from './charts.js';
import { adminZoneName, Empty, ErrorPanel, FilterBar, formatAdminDate, Loading, PageHead } from './components.js';
import { SCREENS } from './catalog.js';
import { readableDetectorName } from './Violations.js';
import { type AdminQueryNavigate } from './filtering.js';
import { createLatestRequestRunner } from './latest-request.js';

export interface Summary {requests:number;activeUsers:number;tokens:{total:number};spendMicroUsd:number;blockedRequests:number;pendingApprovals:number;budgetUsedMicroUsd:number|null;budgetLimitMicroUsd:number|null;providerErrorRate:number|null;dataFreshThrough:string|null}
export interface Nudge {key:string;ruleId:string;category:'cost'|'policy'|'governance';priority:'high'|'medium';count?:number;percent?:number}

function series(raw:unknown):SeriesPoint[]{
  if(!raw||typeof raw!=='object')return[];
  const rows='items'in raw?(raw as {items:unknown}).items:'data'in raw?(raw as {data:unknown}).data:raw;
  return Array.isArray(rows)?rows.map((value,index)=>{const row=value as Record<string,unknown>;return{label:String(row.label??row.bucket??row.name??index+1),value:Number(row.value??row.totalTokens??row.requests??row.spendMicroUsd??row.spend_micro_usd??0),bucketStartMs:typeof row.bucketStartMs==='number'?row.bucketStartMs:undefined}}):[];
}

const OVERVIEW_MODEL_LIMIT=6;
export function overviewActivity(summary:Summary,locale:Locale):Array<readonly [TranslationKey,string]> {
  const items:Array<readonly [TranslationKey,string]>=[['admin.overview.requests',formatNumber(summary.requests,locale)],['admin.overview.activeUsers',formatNumber(summary.activeUsers,locale)],['admin.overview.tokens',formatNumber(summary.tokens.total,locale)],['admin.overview.spend',formatCurrency(summary.spendMicroUsd/1_000_000,'USD',locale)],['admin.overview.blockedRequests',formatNumber(summary.blockedRequests,locale)],['admin.overview.pendingApprovals',formatNumber(summary.pendingApprovals,locale)]];
  if(summary.providerErrorRate!==null)items.push(['admin.overview.providerErrorRate',formatNumber(summary.providerErrorRate,locale,{style:'percent',maximumFractionDigits:1})]);
  if(summary.budgetUsedMicroUsd!==null&&summary.budgetLimitMicroUsd!==null&&summary.budgetLimitMicroUsd>0)items.push(['admin.overview.budgetUtilization',formatNumber(summary.budgetUsedMicroUsd/summary.budgetLimitMicroUsd,locale,{style:'percent',maximumFractionDigits:0})]);
  return items;
}
export function detectorSeries(raw:unknown,translate:Translate,locale:Parameters<typeof readableDetectorName>[2]):SeriesPoint[] {
  return series(raw).map(point=>({...point,label:readableDetectorName(point.label,translate,locale)}));
}
export function chartDate(bucketStartMs:number,locale:string,timeZone:string,granularity:string):Pick<SeriesPoint,'shortLabel'|'longLabel'|'dayKey'|'tooltipLabel'|'localHour'> {
  const formatter=(options:Intl.DateTimeFormatOptions,formatLocale=locale)=>{try{return new Intl.DateTimeFormat(formatLocale,{...options,timeZone})}catch{return new Intl.DateTimeFormat(formatLocale,{...options,timeZone:'UTC'})}};
  const format=(options:Intl.DateTimeFormatOptions,formatLocale=locale)=>formatter(options,formatLocale).format(bucketStartMs);
  const dateOptions:Intl.DateTimeFormatOptions={month:'short',day:'numeric'},hourOptions:Intl.DateTimeFormatOptions=locale==='zh-TW'?{hour:'numeric',hourCycle:'h23'}:{hour:'numeric'};
  const dateLabel=format(dateOptions),tooltipLabel=format({...dateOptions,...hourOptions}),hourly=granularity==='hour';
  const dayParts=formatter({year:'numeric',month:'2-digit',day:'2-digit'},'en').formatToParts(bucketStartMs);
  const part=(type:Intl.DateTimeFormatPartTypes)=>dayParts.find(item=>item.type===type)?.value??'';
  const localHour=hourly?Number(formatter({hour:'numeric',hourCycle:'h23'},'en').formatToParts(bucketStartMs).find(item=>item.type==='hour')?.value):undefined;
  return{shortLabel:hourly?format(hourOptions):dateLabel,longLabel:hourly?tooltipLabel:dateLabel,dayKey:`${part('year')}-${part('month')}-${part('day')}`,tooltipLabel:hourly?tooltipLabel:dateLabel,...(hourly?{localHour}:{})};
}

export function NudgeCards({nudges}:{nudges:readonly Nudge[]}){
  const {locale,t}=useI18n();
  if(nudges.length===0)return null;
  return <div className="ui-nudges">{nudges.map(n=><article className="ui-card" key={n.key}><header><span className="ui-status">{runtimeTranslation(t,'admin.nudges.categories',n.category)}</span><span className="ui-status" data-priority={n.priority}>{runtimeTranslation(t,'admin.nudges.priorities',n.priority)}</span></header><p>{runtimeTranslation(t,'admin.nudges.body',n.ruleId,{count:n.count??0,percent:formatNumber(n.percent??0,locale,{style:'percent',maximumFractionDigits:0})})}</p></article>)}</div>;
}

export function Overview({params,navigate,timeZone}:{params:URLSearchParams;navigate:AdminQueryNavigate;timeZone:string}){
  const {locale,t}=useI18n();
  const [summary,setSummary]=useState<Summary|null>(null);
  const [time,setTime]=useState<SeriesPoint[]>([]);
  const [breakdown,setBreakdown]=useState<SeriesPoint[]>([]);
  const [detectors,setDetectors]=useState<SeriesPoint[]>([]);
  const [nudges,setNudges]=useState<Nudge[]>([]);
  const [loading,setLoading]=useState(true);
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState<Error|null>(null);
  const headingId=useId(),region=useRef<HTMLElement>(null);
  const requests=useRef(createLatestRequestRunner());
  const query=new URLSearchParams(params);if(!query.has('range'))query.set('range','30d');
  const load=useCallback(async()=>{
    setLoading(true);setError(null);
    await requests.current.run(async()=>{
      const breakdownQuery=new URLSearchParams(query);breakdownQuery.set('sort','spendMicroUsd');breakdownQuery.set('limit',String(OVERVIEW_MODEL_LIMIT));
      return Promise.all([
        adminGet<Summary>('/admin/dashboard',query),adminGet<{items:Nudge[]}>('/admin/nudges',query),adminGet<{items:unknown[];granularity:string}>('/admin/analytics/timeseries',query),adminGet<unknown>('/admin/analytics/breakdown',breakdownQuery),
        adminGet<unknown>('/admin/analytics/detectors',query),
      ]);
    },{
      success:([nextSummary,nextNudges,nextTime,nextBreakdown,nextDetectors])=>{
        setSummary(nextSummary);setNudges(nextNudges.items);setTime(series(nextTime).map(point=>point.bucketStartMs===undefined?point:{...point,...chartDate(point.bucketStartMs,locale,timeZone,nextTime.granularity)}));setBreakdown(series(nextBreakdown));setDetectors(detectorSeries(nextDetectors,t,locale));
        setLoaded(true);
      },
      error:caught=>setError(caught instanceof Error?caught:new Error(t('admin.common.loadError'))),
      settled:()=>setLoading(false),
    });
  },[params.toString(),locale,timeZone,t]);
  useEffect(()=>{void load();return()=>requests.current.invalidate()},[load]);
  const activity=summary?overviewActivity(summary,locale):[];
  const content=!summary||(summary.requests===0&&nudges.length===0)?<Empty>{t('admin.screen.overview.1')}</Empty>:<><NudgeCards nudges={nudges}/><div className="ui-kpis">{activity.map(([key,value])=><article key={key}><span>{t(key)}</span><strong>{value}</strong></article>)}</div><div className="ui-chart-grid"><ChartCard title={t('admin.overview.usageTitle')} description={t('admin.overview.usageDescription',{zone:adminZoneName(locale,timeZone)})}><LineChart data={time} label={t('admin.overview.requests')}/></ChartCard><ChartCard title={t('admin.overview.spendTitle')} description={t('admin.overview.spendDescription')}><p>{t('admin.overview.spendTop',{count:breakdown.length})}</p><BarChart data={breakdown} label={t('admin.overview.spend')} formatValue={value=>formatCurrency(value/1_000_000,'USD',locale)}/></ChartCard></div><ChartCard title={t('admin.overview.detectorsTitle')} description={t('admin.overview.detectorsDescription')} empty={detectors.length===0}><BarChart data={detectors} label={t('admin.overview.detections')}/></ChartCard>{summary.dataFreshThrough&&<p className="ui-fresh">{t('admin.overview.fresh',{date:formatAdminDate(summary.dataFreshThrough,locale,timeZone)})}</p>}</>;
  return <><PageHead headingId={headingId} title={t('admin.screens.overview')} description={t('admin.screen.overview.0')} actions={<button className="ui-button ui-secondary" onClick={()=>print()}>{t('admin.actions.printPdf')}</button>}/><FilterBar screen={SCREENS[0]} params={params} onChange={navigate}/><section ref={region} role="region" aria-labelledby={headingId} tabIndex={0} aria-busy={loading}>{error&&<ErrorPanel error={error} retry={()=>{region.current?.focus();void load()}}/>}{!loaded&&loading?<Loading/>:loaded?content:null}</section></>;
}
