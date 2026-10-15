import type Database from 'better-sqlite3';
import type { RouteRequest, RouteResult } from '../../routes/types.js';

/**
 * Liveness and readiness, kept apart because an orchestrator does two different things with them:
 * a failed liveness probe restarts the process, a failed readiness probe only takes it out of
 * rotation. So liveness must not consult the database — a locked or briefly unavailable SQLite file
 * is exactly the case where restarting makes things worse, and a liveness check that touches it turns
 * a recoverable stall into a crash loop.
 *
 * Neither probe reports a version, a path or a row count. `/health/ready` is declared `internal` in
 * the route catalog, but `mountDefinitions` only enforces `tenant`, so in practice both are reachable
 * from the internet; the response is written to be safe under that assumption rather than to rely on
 * a gate that is not there.
 */
export interface HealthDependencies { readonly database:Database.Database; readonly startedAt:number; readonly now?:()=>number }

interface Check { name:string; ok:boolean }

export function createHealthProbes(deps:HealthDependencies):{supports(operation:string):boolean;execute(operation:string,request:RouteRequest):RouteResult} {
  const now=deps.now??Date.now;
  // The schema and chain reads are ordinary reusable statements. `PRAGMA quick_check`, however,
  // must be started fresh for each probe. A first SQLITE_BUSY from another short-lived maintenance
  // or bootstrap connection can leave a prepared PRAGMA statement returning no row on later calls,
  // which keeps a healthy process permanently out of rotation until it is restarted.
  const readable=deps.database.prepare('SELECT 1 ok FROM schema_version ORDER BY version DESC LIMIT 1') as Database.Statement<[],{ok:number}>;
  const chainHealthy=deps.database.prepare("SELECT NOT EXISTS(SELECT 1 FROM audit_chain_heads WHERE status<>'healthy') ok") as Database.Statement<[],{ok:number}>;
  return {
    supports:operation=>operation==='health.live'||operation==='health.ready',
    execute(operation){
      if(operation==='health.live')return {body:{status:'ok',uptimeSeconds:Math.floor((now()-deps.startedAt)/1000)}};
      const checks:Check[]=[];
      // Two distinct failures: the file is gone or unreadable, and the file is readable but has no
      // migrations applied. The second is a fresh volume mounted over a provisioned one, which a
      // single "can I query" check reports as healthy right up until the first tenant lookup.
      let migrated=false;
      try { migrated=readable.get()?.ok===1 } catch { migrated=false }
      checks.push({name:'schema',ok:migrated});
      let intact=false;
      try { intact=deps.database.pragma('quick_check(1)',{simple:true})==='ok' } catch { intact=false }
      checks.push({name:'integrity',ok:intact});
      let chain=false;
      try { chain=chainHealthy.get()?.ok===1 } catch { chain=false }
      // One compromised tenant takes this process out of rotation. For a compliance product,
      // continuing to serve while its tamper evidence is compromised is the worse failure; SPEC
      // §7.2 already constrains a deployment to one application container.
      checks.push({name:'chain',ok:chain});
      const ok=checks.every(check=>check.ok);
      // 503 rather than a 200 carrying `status:'degraded'`. Every load balancer understands the
      // status code; only a bespoke one reads the body.
      return ok?{body:{status:'ready',checks}}:{status:503,body:{status:'not_ready',checks}};
    },
  };
}
