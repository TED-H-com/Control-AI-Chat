// @ts-nocheck -- web production tsconfig intentionally excludes Node test types.
import test from 'node:test'; import assert from 'node:assert/strict'; import { CHAT_UPLOAD_PROJECT_NAME, allocateContext, detachUpload, existingUploadProjectId, validateFiles } from './context.js';
test('context allocation respects caps and sums to usable budget',()=>{const result=allocateContext(100_000,2_000,30_000);assert.equal(result.reservedOutput,20_000);assert.equal(result.projectInstructions,8_000);assert.equal(result.projectFiles,23_400);assert.equal(result.currentTurnFiles,19_500);assert.equal(result.skill,7_800);assert.equal(result.conversationHistory,19_300);assert.equal(result.projectInstructions+result.projectFiles+result.currentTurnFiles+result.skill+result.conversationHistory,result.usable)});
test('file validation enforces count, aggregate, per-file, and dangerous suffix limits',()=>{
  const file=(name:string,size:number)=>({name,size});
  assert.equal(validateFiles(Array.from({length:11},(_,index)=>file(`${index}.txt`,1))),'file_limit');
  assert.equal(validateFiles([file('large.pdf',25*1024*1024+1)]),'size_limit');
  assert.equal(validateFiles([file('a.pdf',25*1024*1024),file('b.pdf',25*1024*1024),file('c.txt',1)]),'size_limit');
  for(const name of ['photo.png','payload.bin','payload.exe','script.js','page.html','vector.svg','archive.zip','macro.docm'])assert.equal(validateFiles([file(name,10)]),'type_denied');
  for(const name of ['report.pdf','document.docx','sheet.xlsx','slides.pptx','notes.txt','data.csv','readme.md'])assert.equal(validateFiles([file(name,10)]),null,name);
});
test('upload project selection never falls back to an unrelated project',()=>{
  const projects=[{id:'unrelated',name:'Quarterly planning'},{id:'managed',name:CHAT_UPLOAD_PROJECT_NAME}];
  assert.equal(existingUploadProjectId('conversation-project',projects),'conversation-project');
  assert.equal(existingUploadProjectId(null,projects),'managed');
  assert.equal(existingUploadProjectId(null,projects.slice(0,1)),null);
});
test('detaching a deduplicated upload never removes the shared server file',()=>{
  const remote={id:'shared-file'};
  const first={localId:'first',file:null,remote,status:'ready',error:null};
  const duplicate={localId:'duplicate',file:null,remote,status:'ready',error:null};
  const detached=detachUpload([first,duplicate],duplicate.localId);
  assert.deepEqual(detached,[first]);
  assert.strictEqual(detached[0]?.remote,remote,'the existing shared file reference remains intact');
});
