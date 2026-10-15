import {createHash} from 'node:crypto';
import {issueOperatorPasswordLink} from './issue-password-link-core.js';
import {createAuditService,createTenantRetentionPolicy} from '../lib/audit/index.js';

function argument(name:string):string|undefined {
  const flag=`--${name}`;
  for(let index=2;index<process.argv.length;index++){const value=process.argv[index]!;if(value===flag)return process.argv[index+1];if(value.startsWith(`${flag}=`))return value.slice(flag.length+1)}
  return undefined;
}
function required(name:string):string {const value=argument(name)?.trim();if(!value)throw new Error(`${name} is required`);return value}

try {
  const [{db},{config}]=await Promise.all([import('../lib/db.js'),import('../config.js')]);
  const key=(label:string)=>createHash('sha256').update(`${label}:${config.auditKey}`).digest();
  const audit=createAuditService({database:db,ipHmacKey:key('ip'),transcriptKey:tenantId=>key(`transcript:${tenantId}`),retentionPolicy:createTenantRetentionPolicy(db)});
  const result=issueOperatorPasswordLink(db,audit,{workspaceSlug:required('workspace'),email:required('email'),appOrigin:config.appOrigin});
  console.log(result.url);
  db.close();
} catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1}
