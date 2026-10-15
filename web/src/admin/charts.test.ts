import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n/index.js';
import { LineChart, selectAxisLabels, type AxisLabelCandidate } from './charts.js';

const chartWidth=600;
const candidates=(count:number,labelWidth:number,{hourly=false,startHour=0}:{hourly?:boolean;startHour?:number}={}):AxisLabelCandidate[]=>Array.from({length:count},(_,index)=>({
  position:count===1?24:24+index*((chartWidth-48)/(count-1)),
  shortWidth:labelWidth,
  longWidth:labelWidth,
  dayKey:`day-${Math.floor((startHour+index)/24)}`,
  ...(hourly?{localHour:(startHour+index)%24}:{}),
}));

function assertGeometry(selected:ReturnType<typeof selectAxisLabels>){
  for(const label of selected){
    assert.ok(label.left>=0,`label ${label.index} left the chart: ${label.left}`);
    assert.ok(label.right<=chartWidth,`label ${label.index} left the chart: ${label.right}`);
  }
  for(let index=1;index<selected.length;index++)assert.ok(selected[index].left-selected[index-1].right>=8,`labels ${selected[index-1].index} and ${selected[index].index} were too close`);
}

test('axis labels stay in bounds and at least 8 px apart across series sizes and label widths',()=>{
  for(const count of [1,2,24,30,90]){
    const pointGap=count>1?(chartWidth-48)/(count-1):chartWidth;
    for(const labelWidth of [4,Math.max(12,pointGap+4),80])assertGeometry(selectAxisLabels(candidates(count,labelWidth),chartWidth));
  }
});

test('axis labels choose the smallest round stride with at most 8 labels that fits',()=>{
  assert.deepEqual(selectAxisLabels(candidates(30,10),chartWidth).map(label=>label.index),[0,5,10,15,20,25]);
  assert.deepEqual(selectAxisLabels(candidates(30,70),chartWidth).map(label=>label.index),[0,7,14,21,28]);
});

test('hourly labels align a four-point stride to local hours divisible by four',()=>{
  const atTwenty=candidates(24,20,{hourly:true,startHour:20});atTwenty[1].longWidth=100;atTwenty[3].shortWidth=120;
  const atTwentyOne=candidates(24,20,{hourly:true,startHour:21});atTwentyOne[0].longWidth=100;
  assert.deepEqual(selectAxisLabels(atTwenty,chartWidth).map(label=>label.index),[0,4,8,12,16,20]);
  assert.deepEqual(selectAxisLabels(atTwentyOne,chartWidth).map(label=>label.index),[3,7,11,15,19,23]);
});

test('axis labels are evenly spaced by one selected stride across series sizes',()=>{
  for(const count of [1,2,7,24,25,30,31,90]){
    const indexes=selectAxisLabels(candidates(count,10),chartWidth).map(label=>label.index);
    const strides=indexes.slice(1).map((index,position)=>index-indexes[position]);
    assert.ok(indexes.length>0,`no label was selected for ${count} points`);
    assert.ok(new Set(strides).size<=1,`${count} points used strides ${strides.join(', ')}`);
  }
});

test('labels that would cross chart edges are anchored inward and stay inside',()=>{
  const selected=selectAxisLabels([
    {position:4,shortWidth:20,longWidth:20,dayKey:'one'},
    {position:96,shortWidth:20,longWidth:20,dayKey:'one'},
  ],100);
  assert.deepEqual(selected.map(label=>({index:label.index,anchor:label.anchor,left:label.left,right:label.right})),[
    {index:0,anchor:'start',left:4,right:24},
    {index:1,anchor:'end',left:76,right:96},
  ]);
});

test('when no hourly stride fits only the first aligned label is drawn, or none',()=>{
  assert.deepEqual(selectAxisLabels(candidates(240,20,{hourly:true,startHour:1}),chartWidth).map(label=>label.index),[23]);
  assert.deepEqual(selectAxisLabels(candidates(240,700,{hourly:true,startHour:1}),chartWidth),[]);
});

test('axis labels use long text first and on each new local day under a stride',()=>{
  const dayKeys=['one','one','one','two','two','two','two','two','three','three','three','three'];
  const selected=selectAxisLabels(candidates(12,20).map((candidate,index)=>({...candidate,dayKey:dayKeys[index]})),chartWidth);
  assert.deepEqual(selected.map(label=>label.index),[0,2,4,6,8,10]);
  assert.deepEqual(selected.map(label=>label.variant),['long','short','long','short','long','short']);
});

test('the unmeasured and static chart uses the 600 px fallback without painting labels',()=>{
  Object.defineProperty(globalThis,'location',{value:{search:'',pathname:'/'},configurable:true});
  Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null},configurable:true});
  const markup=renderToStaticMarkup(createElement(I18nProvider,{children:createElement(LineChart,{data:[{label:'Sep 28',value:1,shortLabel:'4 PM',longLabel:'Sep 28, 4 PM',dayKey:'2026-09-28'}],label:'Requests'})}));
  assert.match(markup,/viewBox="0 0 600 190"/u);
  assert.doesNotMatch(markup,/data-axis-label=/u);
});
