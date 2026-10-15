import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkServerTypeBoundary} from '../src/server-type-boundary.ts';

const webDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const offenders=checkServerTypeBoundary(webDir);

if(offenders.length>0){
  console.error('Web TypeScript boundary check failed: the web build runs without server/node_modules in Docker.');
  console.error('Every server file in the web type graph must be under server/src. Offending file(s):');
  for(const offender of offenders)console.error(`- ${offender}`);
  process.exitCode=1;
}else{
  console.log('Web TypeScript boundary check passed: all server files are under server/src.');
}
