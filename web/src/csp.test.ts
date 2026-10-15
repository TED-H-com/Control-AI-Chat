// @ts-nocheck -- Vite's plugin context is exercised through its public dev-server API.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build,createServer} from 'vite';
import {CONTENT_SECURITY_POLICY,productionCspPlugin} from './csp.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const meta=`<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;

test('the CSP matches the exact security contract',()=>{
  // This policy is a security contract, so a change to it must change this test in the same commit.
  assert.equal(CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'");
});

test('the production build contains exactly the original CSP policy',async t=>{
 const output=mkdtempSync(join(tmpdir(),'csp-build-'));t.after(()=>rmSync(output,{recursive:true,force:true}));
 await build({root,configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),logLevel:'silent',build:{outDir:output,emptyOutDir:true}});
 const html=readFileSync(join(output,'index.html'),'utf8');
 assert.equal(html.split(meta).length-1,1);
});

test('the development transform omits the CSP meta tag',async()=>{
 const server=await createServer({root,configFile:false,plugins:[productionCspPlugin],server:{middlewareMode:true,watch:null}});
 try{
  const source=readFileSync(new URL('../index.html',import.meta.url),'utf8'),html=await server.transformIndexHtml('/login',source);
  assert.doesNotMatch(html,/http-equiv=["']Content-Security-Policy["']/iu);
 }finally{await server.close()}
});
