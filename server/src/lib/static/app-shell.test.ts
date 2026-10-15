import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {Hono} from 'hono';
import {staticSurfaces} from './app-shell.js';

const roots:string[]=[];
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});

test('the app shell is served for every host without a 421',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gateway-static-'));roots.push(root);await mkdir(root,{recursive:true});
  await writeFile(join(root,'index.html'),'APP SHELL');
  const app=new Hono();app.use('*',staticSurfaces({appRoot:root}));
  for(const host of ['customer.example','unknown.invalid','legacy.example.test']){
    const response=await app.request('/some/client/route',{headers:{Host:host}});
    assert.equal(response.status,200);assert.equal(await response.text(),'APP SHELL');
  }
});

test('fonts have the right media type, missing assets stay 404, and client routes get the shell',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gateway-static-assets-'));roots.push(root);
  await mkdir(join(root,'fonts'),{recursive:true});await mkdir(join(root,'assets'),{recursive:true});
  await writeFile(join(root,'index.html'),'APP SHELL');await writeFile(join(root,'fonts','plex.woff2'),'font bytes');
  const app=new Hono();app.use('*',staticSurfaces({appRoot:root}));
  const font=await app.request('/fonts/plex.woff2');assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/woff2');assert.equal(font.headers.get('cache-control'),'public, max-age=86400');
  assert.equal((await app.request('/fonts/missing.woff2')).status,404);
  assert.equal((await app.request('/assets/missing-abcdefgh.js')).status,404);
  const route=await app.request('/chat/anything');assert.equal(route.status,200);assert.equal(await route.text(),'APP SHELL');assert.equal(route.headers.get('cache-control'),'no-cache');
});
