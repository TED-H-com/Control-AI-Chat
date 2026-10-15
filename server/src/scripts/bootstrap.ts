import 'dotenv/config';
import {bootstrapTenant,requireBootstrapSecrets} from './bootstrap-core.js';

function fail(message:string):never {console.error(message);process.exitCode=1;throw new Error('__BOOTSTRAP_EXIT__');}
function argument(name:string):string|undefined {
  const aliases=[`--${name.toLowerCase().replaceAll('_','-')}`,`--${name.toLowerCase()}`,`--${name}`];
  for(let index=2;index<process.argv.length;index++)for(const alias of aliases){
    const value=process.argv[index]!;
    if(value===alias)return process.argv[index+1];
    if(value.startsWith(`${alias}=`))return value.slice(alias.length+1);
  }
  return undefined;
}
function requiredInput(name:string):string {
  const value=(argument(name)??process.env[name])?.trim();
  if(!value)fail(`${name} is required`);
  return value;
}

try {
  try{requireBootstrapSecrets(process.env);}catch(error){fail(error instanceof Error?error.message:String(error));}
  const workspaceName=requiredInput('WORKSPACE_NAME');
  const adminEmail=requiredInput('ADMIN_EMAIL').toLowerCase();
  const adminName=(argument('ADMIN_NAME')??process.env.ADMIN_NAME)?.trim()||'Admin';
  if(workspaceName.length>200)fail('WORKSPACE_NAME must be at most 200 characters');
  if(adminName.length>200)fail('ADMIN_NAME must be at most 200 characters');
  if(adminEmail.length>254||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(adminEmail))fail('ADMIN_EMAIL must be a valid email address');

  const [{db},{config}]=await Promise.all([import('../lib/db.js'),import('../config.js')]);
  const result=await bootstrapTenant(db,{workspaceName,adminEmail,adminName});
  if(!result.created)console.log(`Workspace already exists: ${result.slug}`);
  else {
    console.log(`Login URL: ${config.appOrigin.replace(/\/$/u,'')}/login`);
    console.log(`Email: ${result.email}`);
    console.log(`Password: ${result.password}`);
  }
  db.close();
} catch(error) {
  if(!(error instanceof Error&&error.message==='__BOOTSTRAP_EXIT__')){
    console.error(error instanceof Error?error.message:String(error));process.exitCode=1;
  }
}
