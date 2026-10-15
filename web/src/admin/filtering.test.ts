// @ts-nocheck -- the production web tsconfig intentionally excludes Node test types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ADMIN_TEXT_FILTER_DEBOUNCE_MS,createDebouncedCommit,FILTER_NAVIGATION_OPTIONS,paramsWithTextFilterDrafts,textFilterDrafts,writeAdminHistory} from './filtering.js';
import {SCREENS} from './catalog.js';

test('rapid text filter changes coalesce and an immediate select cancels pending text work',()=>{
  const timers:Array<{callback:()=>void;delay:number;cancelled:boolean}>=[];
  const controls={
    set:(callback:()=>void,delay:number)=>{const timer={callback,delay,cancelled:false};timers.push(timer);return timer;},
    clear:(timer:{cancelled:boolean})=>{timer.cancelled=true;},
  };
  const committed:string[]=[];
  const runPending=()=>{for(const timer of timers)if(!timer.cancelled){timer.cancelled=true;timer.callback();}};
  const debounce=createDebouncedCommit(value=>committed.push(value),ADMIN_TEXT_FILTER_DEBOUNCE_MS,controls);
  debounce.schedule('a');debounce.schedule('ad');debounce.schedule('admin');
  assert.deepEqual(committed,[]);
  runPending();
  assert.deepEqual(committed,['admin']);
  assert.ok(timers.every(timer=>timer.delay===300));

  debounce.schedule('pending text');
  debounce.immediate('select changed');
  runPending();
  assert.deepEqual(committed,['admin','select changed']);
  const source=readFileSync(new URL('components.tsx',import.meta.url),'utf8');
  assert.match(source,/committer\.current!\.schedule/u);
  assert.match(source,/committer\.current!\.immediate/u);
  assert.match(source,/onChangeRef\.current\(next,FILTER_NAVIGATION_OPTIONS\)/u);
});

test('filter navigation replaces the current history entry and keeps drafted text in mixed changes',()=>{
  const screen=SCREENS.find(item=>item.key==='users')!;
  const params=new URLSearchParams({status:'active',sort:'displayName'});
  const drafts={...textFilterDrafts(screen,params),search:'Ada'};
  const next=paramsWithTextFilterDrafts(screen,params,drafts);
  assert.equal(next.get('search'),'Ada');
  assert.equal(next.get('status'),'active');
  assert.equal(next.get('sort'),'displayName');

  const pushed:string[]=[],replaced:string[]=[];
  const history={pushState:(_state:unknown,_unused:string,url:string)=>pushed.push(url),replaceState:(_state:unknown,_unused:string,url:string)=>replaced.push(url)};
  writeAdminHistory(history,'/admin/users',next,FILTER_NAVIGATION_OPTIONS);
  writeAdminHistory(history,'/admin/users',new URLSearchParams({search:'Ada Lovelace'}),FILTER_NAVIGATION_OPTIONS);
  assert.deepEqual(pushed,[],'typing must not add Back-button entries');
  assert.deepEqual(replaced,['/admin/users?status=active&sort=displayName&search=Ada','/admin/users?search=Ada+Lovelace']);
  const violations=SCREENS.find(item=>item.key==='violations')!;
  assert.equal(Object.hasOwn(textFilterDrafts(violations,new URLSearchParams({date:'2026-09-06'})),'date'),false,'date pickers stay immediate');
  assert.match(readFileSync(new URL('AdminConsole.tsx',import.meta.url),'utf8'),/writeAdminHistory\(history,path,next,options\)/u);
});
