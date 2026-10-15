import {spawnSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

export function checkServerTypeBoundary(webDir:string):string[]{
  const npx=process.platform==='win32'?'npx.cmd':'npx';
  const result=spawnSync(npx,['tsc','-p','tsconfig.json','--noEmit','--listFiles'],{cwd:webDir,encoding:'utf8'});
  if(!result.error){
    const files=result.stdout.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
    const offenders=findOffenders(webDir,files);
    if(offenders.length>0)return offenders;
    if(result.status!==0)throw new Error(`${result.stdout}${result.stderr}`);
    return [];
  }
  if((result.error as NodeJS.ErrnoException).code!=='EPERM')throw result.error;

  const configPath=path.join(webDir,'tsconfig.json');
  const config=ts.readConfigFile(configPath,ts.sys.readFile);
  if(config.error)throw new Error(ts.formatDiagnostic(config.error,formatHost));
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,webDir,{noEmit:true},configPath);
  if(parsed.errors.length>0)throw new Error(ts.formatDiagnostics(parsed.errors,formatHost));
  const program=ts.createProgram(parsed.fileNames,parsed.options);
  const offenders=findOffenders(webDir,program.getSourceFiles().map(file=>file.fileName));
  if(offenders.length>0)return offenders;
  const diagnostics=ts.getPreEmitDiagnostics(program);
  if(diagnostics.length>0)throw new Error(ts.formatDiagnostics(diagnostics,formatHost));
  return [];
}

function findOffenders(webDir:string,files:readonly string[]):string[]{
  const serverDir=path.resolve(webDir,'../server');
  const serverSrcDir=path.join(serverDir,'src');
  const isWithin=(parent:string,file:string):boolean=>file===parent||file.startsWith(`${parent}${path.sep}`);
  return files.map(file=>path.resolve(webDir,file)).filter(file=>isWithin(serverDir,file)&&!isWithin(serverSrcDir,file));
}

const formatHost:ts.FormatDiagnosticsHost={
  getCanonicalFileName:fileName=>fileName,
  getCurrentDirectory:ts.sys.getCurrentDirectory,
  getNewLine:()=>ts.sys.newLine,
};
