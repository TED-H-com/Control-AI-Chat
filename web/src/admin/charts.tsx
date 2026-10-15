import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatNumber, useI18n } from '../i18n/index.js';

export interface SeriesPoint {
  label:string;
  value:number;
  secondary?:number;
  bucketStartMs?:number;
  shortLabel?:string;
  longLabel?:string;
  dayKey?:string;
  tooltipLabel?:string;
  localHour?:number;
}

export interface AxisLabelCandidate {
  position:number;
  shortWidth:number;
  longWidth:number;
  dayKey:string;
  localHour?:number;
}

export interface SelectedAxisLabel {
  index:number;
  variant:'short'|'long';
  anchor:'start'|'middle'|'end';
  left:number;
  right:number;
}

const CHART_HEIGHT=190;
const CHART_FALLBACK_WIDTH=600;
const CHART_SIDE_PADDING=24;
const AXIS_Y=150;
const LABEL_Y=174;
const MIN_LABEL_GAP=8;
const MAX_AXIS_LABELS=8;
const HOURLY_STRIDES=[1,2,3,4,6,12,24] as const;
const useBrowserLayoutEffect=typeof window==='undefined'?useEffect:useLayoutEffect;

function placedLabel(candidates:readonly AxisLabelCandidate[],index:number,previous:SelectedAxisLabel|undefined,chartWidth:number):SelectedAxisLabel{
  const candidate=candidates[index];
  const variant:SelectedAxisLabel['variant']=!previous||candidate.dayKey!==candidates[previous.index].dayKey?'long':'short';
  const labelWidth=variant==='long'?candidate.longWidth:candidate.shortWidth;
  const centredLeft=candidate.position-labelWidth/2,centredRight=candidate.position+labelWidth/2;
  const anchor:SelectedAxisLabel['anchor']=centredLeft<0?'start':centredRight>chartWidth?'end':'middle';
  const left=anchor==='start'?candidate.position:anchor==='end'?candidate.position-labelWidth:candidate.position-labelWidth/2;
  return{index,variant,anchor,left,right:left+labelWidth};
}

function dailyStrides(count:number):number[]{
  const strides=[1,2,3,5,7,14,28];
  while(strides[strides.length-1]<count)strides.push(strides[strides.length-1]*2);
  return strides;
}

function indexesForStride(candidates:readonly AxisLabelCandidate[],stride:number,hourly:boolean):number[]{
  const offset=hourly?candidates.findIndex(candidate=>candidate.localHour!==undefined&&candidate.localHour%stride===0):0;
  if(offset<0)return[];
  const indexes:number[]=[];
  for(let index=offset;index<candidates.length;index+=stride)indexes.push(index);
  return indexes;
}

export function selectAxisLabels(candidates:readonly AxisLabelCandidate[],chartWidth:number,minimumGap=MIN_LABEL_GAP):SelectedAxisLabel[]{
  if(!candidates.length)return[];
  const hourly=candidates.every(candidate=>candidate.localHour!==undefined);
  const strides=hourly?[...HOURLY_STRIDES]:dailyStrides(candidates.length);
  const fits=(label:SelectedAxisLabel)=>label.left>=0&&label.right<=chartWidth;
  for(const stride of strides){
    const indexes=indexesForStride(candidates,stride,hourly);
    if(!indexes.length||indexes.length>MAX_AXIS_LABELS)continue;
    const selected:SelectedAxisLabel[]=[];
    for(const index of indexes)selected.push(placedLabel(candidates,index,selected.at(-1),chartWidth));
    if(selected.every((label,index)=>fits(label)&&(index===0||label.left-selected[index-1].right>=minimumGap)))return selected;
  }
  const fallbackIndexes=indexesForStride(candidates,strides[strides.length-1],hourly);
  if(!fallbackIndexes.length)return[];
  const fallback=placedLabel(candidates,fallbackIndexes[0],undefined,chartWidth);
  return fits(fallback)?[fallback]:[];
}

export function ChartCard({title,description,children,empty=false}:{title:string;description:string;children:ReactNode;empty?:boolean}){
  const {t}=useI18n();
  return <section className="ui-card ui-chart"><header><div><h2>{title}</h2><p>{description}</p></div></header>{empty?<div className="ui-chart-empty">{t('admin.charts.noData')}</div>:children}</section>;
}

interface Measurements {key:string;candidates:AxisLabelCandidate[]}

export function LineChart({data,label}:{data:SeriesPoint[];label:string}){
  const {locale,t}=useI18n();
  const containerRef=useRef<HTMLDivElement>(null),svgRef=useRef<SVGSVGElement>(null);
  const [width,setWidth]=useState(CHART_FALLBACK_WIDTH),[measurements,setMeasurements]=useState<Measurements|null>(null);
  const axisLabels=useMemo(()=>data.map((point,index)=>({short:point.shortLabel??point.label,long:point.longLabel??point.label,dayKey:point.dayKey??String(index),localHour:point.localHour})),[data]);
  const measurementKey=useMemo(()=>`${width}\u0000${axisLabels.map(point=>`${point.short}\u0001${point.long}\u0001${point.dayKey}\u0001${point.localHour??''}`).join('\u0002')}`,[axisLabels,width]);

  useBrowserLayoutEffect(()=>{
    const container=containerRef.current;if(!container)return;
    const update=()=>{const measured=container.getBoundingClientRect().width;setWidth(current=>measured>0&&Math.abs(current-measured)>.01?measured:current)};
    update();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(update);observer.observe(container);return()=>observer.disconnect();
  },[]);

  useBrowserLayoutEffect(()=>{
    const svg=svgRef.current;if(!svg)return;
    let active=true;
    const measure=()=>{
      if(!active)return;
      const candidates=axisLabels.map((point,index)=>{
        const short=svg.querySelector<SVGTextElement>(`[data-axis-measure="short"][data-axis-index="${index}"]`);
        const long=svg.querySelector<SVGTextElement>(`[data-axis-measure="long"][data-axis-index="${index}"]`);
        return{position:CHART_SIDE_PADDING+index*((width-CHART_SIDE_PADDING*2)/Math.max(1,data.length-1)),shortWidth:short?.getComputedTextLength()??0,longWidth:long?.getComputedTextLength()??0,dayKey:point.dayKey,localHour:point.localHour};
      });
      if(candidates.every(candidate=>candidate.shortWidth>0&&candidate.longWidth>0))setMeasurements({key:measurementKey,candidates});
    };
    const fonts=typeof document==='undefined'?undefined:document.fonts;
    const invalidate=()=>setMeasurements(current=>current?.key===measurementKey?null:current);
    if(!fonts||fonts.status==='loaded')measure();
    void fonts?.ready.then(measure);
    fonts?.addEventListener('loading',invalidate);fonts?.addEventListener('loadingdone',measure);
    return()=>{active=false;fonts?.removeEventListener('loading',invalidate);fonts?.removeEventListener('loadingdone',measure)};
  },[axisLabels,data.length,measurementKey,width]);

  if(!data.length)return null;
  const max=Math.max(1,...data.map(point=>point.value)),title=t('admin.charts.overTime',{label});
  const x=(index:number)=>CHART_SIDE_PADDING+index*((width-CHART_SIDE_PADDING*2)/Math.max(1,data.length-1));
  const points=data.map((point,index)=>`${x(index)},${AXIS_Y-point.value/max*118}`).join(' ');
  const selected=measurements?.key===measurementKey?selectAxisLabels(measurements.candidates,width):[];
  return <div className="ui-svg" ref={containerRef}><svg ref={svgRef} viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={title}>
    <title>{title}</title>
    <line x1={CHART_SIDE_PADDING} y1={AXIS_Y} x2={width-CHART_SIDE_PADDING} y2={AXIS_Y} className="axis"/>
    <polyline points={points} className="line"/>
    {data.map((point,index)=>{const tooltip=`${point.tooltipLabel??point.longLabel??point.label}: ${formatNumber(point.value,locale)} ${label}`;return <g key={`${point.label}-${index}`}><circle cx={x(index)} cy={AXIS_Y-point.value/max*118} r="4"><title>{tooltip}</title></circle></g>})}
    <g aria-hidden="true">{axisLabels.flatMap((point,index)=>[
      <text className="ui-axis-measure" data-axis-measure="short" data-axis-index={index} key={`short-${index}`}>{point.short}</text>,
      <text className="ui-axis-measure" data-axis-measure="long" data-axis-index={index} key={`long-${index}`}>{point.long}</text>,
    ])}</g>
    {selected.map(item=><text data-axis-label="" data-axis-index={item.index} key={`axis-${item.index}`} x={x(item.index)} y={LABEL_Y} textAnchor={item.anchor}>{item.variant==='long'?axisLabels[item.index].long:axisLabels[item.index].short}</text>)}
  </svg></div>;
}

export function BarChart({data,label,formatValue}:{data:SeriesPoint[];label:string;formatValue?:(value:number)=>string}){
  const {locale,t}=useI18n();
  if(!data.length)return null;
  const max=Math.max(1,...data.map(point=>point.value)),display=formatValue??((value:number)=>formatNumber(value,locale));
  return <div className="ui-bars" role="img" aria-label={t('admin.charts.ranked',{label})}>{data.map((point,index)=><div key={`${point.label}-${index}`}><span>{point.label}</span><div><i style={{width:`${point.value/max*100}%`}}/><b>{display(point.value)}</b></div></div>)}</div>;
}
