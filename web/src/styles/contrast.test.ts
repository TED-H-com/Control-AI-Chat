// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('./tokens.css',import.meta.url),'utf8');
function declarations(selector){const match=new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*\\{([^}]+)\\}`).exec(css);assert.ok(match,`missing ${selector}`);return Object.fromEntries([...match[1].matchAll(/--([\w-]+)\s*:\s*([^;\n}]+)/g)].map(item=>[item[1],item[2].trim()]));}
const light=declarations(':root'),dark={...light,...declarations("[data-mode='dark']")};
function luminance(hex){assert.match(hex,/^#[0-9a-f]{6}$/i);const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function ratio(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(values[0]+.05)/(values[1]+.05)}
const pairs=[...['text','text-2','muted'].flatMap(f=>['bg','panel','panel-2'].map(b=>[f,b])),...['bg','panel','primary-soft'].map(b=>['primary',b]),['text','primary-soft'],['muted','primary-soft'],['on-primary','primary'],['on-seal','seal'],['amber','amber-soft'],['amber','panel'],['crimson','crimson-soft'],['crimson','panel'],['green','green-soft'],['green','panel']];
test('specified token text pairs meet WCAG AA in light and dark modes',()=>{for(const[mode,tokens]of Object.entries({light,dark})){const report=[];for(const[foreground,background]of pairs){const measured=ratio(tokens[foreground],tokens[background]);report.push(`${foreground}/${background}=${measured.toFixed(2)}`);assert.ok(measured>=4.5,`${mode} ${foreground}/${background}: ${measured.toFixed(2)} < 4.5`)}console.log(`${mode}: ${report.join(', ')}`)}});
