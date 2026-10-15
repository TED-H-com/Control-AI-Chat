// @ts-nocheck -- provider wiring contract test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('support contact loading is enabled only for authenticated app shells',()=>{
 const provider=readFileSync(new URL('deployment.tsx',import.meta.url),'utf8'),app=readFileSync(new URL('App.tsx',import.meta.url),'utf8');
 assert.match(provider,/if\(authenticated\)void fetch\('\/api\/v1\/deployment\/support'/u);
 assert.match(app,/route\.kind==='admin'\) return <DeploymentProvider authenticated>/u);
 assert.match(app,/route\.kind==='chat'\) return <DeploymentProvider authenticated>/u);
 assert.match(app,/return <DeploymentProvider><I18nProvider>\{content\(<NotFoundPage area="app"\/>\)\}/u);
 assert.match(app,/route\.kind==='login'\) return <DeploymentProvider>/u);
 assert.match(app,/route\.kind==='setup'\|\|route\.kind==='reset-password'\|\|route\.kind==='forgot-password'[\s\S]*?return <DeploymentProvider>/u);
});
