import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { config } from './config.js';
import { db, statements } from './lib/db.js';
import type { AppVariables } from './lib/http/index.js';
import { handleRequestError } from './lib/http/errors.js';
import { forTenant } from './lib/db.js';
import { createV1Routes } from './routes/index.js';
import { approvalReleaseWorker, audit, deploymentBlobs, resolvePrincipal, retentionPolicy, services } from './integration-services.js';
import { securityHeaders, requestSizeLimit, apiV1Authentication, apiV1CsrfProtection, governanceRateLimit, publicLoginRateLimit, DEFAULT_UPLOAD_LIMIT } from './lib/middleware/index.js';
import { staticSurfaces } from './lib/static/index.js';
import { RateLimiter } from './lib/governance/rateLimit.js';
import { startAuditWorkers } from './app/audit/workers.js';
import { verifiedClientAddress } from './lib/http/client-ip.js';
import { APP_VERSION } from './version.js';
import { PRODUCT_NAME } from './shared/brand.js';

const startedAt = Date.now();
export const app = new Hono<{Variables:AppVariables}>();
/**
 * A 500 answers the caller "Internal server error" and deliberately says no more. That is right for
 * the caller and wrong for the operator: nothing was written anywhere, so a production 500 could be
 * observed but not diagnosed — a governed product whose own failures leave no trace is not one an
 * administrator can run. The stack goes to the journal keyed by the requestId the caller was handed,
 * which is the only thread tying a user's report back to what actually happened. Statuses the caller
 * caused (401/403/404/409/422) stay quiet; they are not faults.
 */
app.onError(handleRequestError);
app.use('*',async (c,next) => {
  c.set('requestId',c.req.header('X-Request-Id') ?? crypto.randomUUID());
  let peer='unknown';try{peer=getConnInfo(c).remote.address??'unknown'}catch{}
  c.set('verifiedClientIp',verifiedClientAddress({peer,forwarded:c.req.header('X-Gateway-Proxy-Client-IP'),suppliedSecret:c.req.header('X-Gateway-Proxy-Secret'),trustedProxySecret:config.proxySharedSecret}));
  await next();
  c.header('X-Request-Id',c.get('requestId'));
});
app.use('*',securityHeaders());
app.use('/api/v1/auth/login',publicLoginRateLimit());
app.use('/api/v1/auth/password/forgot',publicLoginRateLimit({path:'/api/v1/auth/password/forgot'}));
app.use('/api/v1/auth/password/reset',publicLoginRateLimit({path:'/api/v1/auth/password/reset'}));
// One ceiling per route class. The 1 MiB JSON limit was applied to all of /api/*, so every attachment
// over 1 MiB was rejected at the edge with a PAYLOAD_TOO_LARGE the files adapter never saw and could
// not explain — and DEFAULT_UPLOAD_LIMIT, which exists for exactly this, was unused. It stays scoped
// to the one multipart route; every JSON body keeps the 1 MiB default.
const jsonLimit=requestSizeLimit(),uploadLimit=requestSizeLimit({maxBytes:DEFAULT_UPLOAD_LIMIT});
app.use('/api/*',(c,next)=>(c.req.method==='POST'&&c.req.path==='/api/v1/files'?uploadLimit:jsonLimit)(c,next));
app.get('/api/health',(c) => {
  const database = statements.health.get()?.ok === 1 ? 'ok' : 'error';
  return c.json({status:database === 'ok' ? 'ok' : 'degraded',version:APP_VERSION,
    uptime:Math.floor((Date.now()-startedAt)/1000),db:database,providers:[]});
});

// MOUNT: authentication and identity routes
app.use('/api/v1/*',apiV1Authentication({resolvePrincipal,tenantDatabase:tenantId=>forTenant({tenantId})}));
app.use('/api/v1/*',governanceRateLimit(new RateLimiter(db),audit));
const allowedOrigins=new Set([config.appOrigin.toLowerCase(),...(config.nodeEnv==='production'?[]:['http://localhost:5173','http://localhost:5174'])]);
app.use('/api/v1/*',apiV1CsrfProtection({allowedOrigins}));
// MOUNT: tenant chat, project, skill, and file routes
// MOUNT: gate, governance, audit, and admin routes
app.route('/api/v1',createV1Routes(services));

const webRoot = resolve(process.cwd(),'../web/dist');
app.use('*',staticSurfaces({appRoot:webRoot}));

// Revocation commits before its directory is removed, so a crash cannot leave a credential
// routable. The revoked rows are a durable cleanup queue and are drained before this process serves.
const auditWorkers=startAuditWorkers({database:db,audit,retentionPolicy,blobStore:deploymentBlobs,retentionEnforcementEnabled:config.retentionEnforcementEnabled,logger:console});

const server = serve({fetch:app.fetch,hostname:config.host,port:config.port},info => {
  console.log(`${PRODUCT_NAME} listening on http://${info.address}:${info.port}`);
});
let closing = false;
async function shutdown(signal:string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await Promise.all([auditWorkers.stop(),approvalReleaseWorker.stop()]);
    db.pragma('optimize');
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1),10_000).unref();
}
process.once('SIGTERM',()=>void shutdown('SIGTERM'));
process.once('SIGINT',()=>void shutdown('SIGINT'));
