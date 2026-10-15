import type { UploadItem } from './types.js';
import { PRODUCT_NAME } from '@shared/brand.js';

export interface ContextAllocation { reservedOutput:number; usable:number; projectInstructions:number; projectFiles:number; currentTurnFiles:number; skill:number; conversationHistory:number }
export function allocateContext(windowTokens:number,reservedSystem:number,configuredOutput:number): ContextAllocation {
  const reservedOutput=Math.min(configuredOutput,Math.floor(windowTokens*.2)); const usable=Math.max(0,windowTokens-reservedOutput-reservedSystem);
  const projectInstructions=Math.min(8000,Math.floor(usable*.15)); const projectFiles=Math.min(32000,Math.floor(usable*.3));
  const currentTurnFiles=Math.min(32000,Math.floor(usable*.25)); const skill=Math.min(8000,Math.floor(usable*.1));
  return {reservedOutput,usable,projectInstructions,projectFiles,currentTurnFiles,skill,conversationHistory:Math.max(0,usable-projectInstructions-projectFiles-currentTurnFiles-skill)};
}

export const ACCEPTED_UPLOADS='.pdf,.docx,.xlsx,.pptx,.txt,.csv,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,text/markdown';
const ACCEPTED_UPLOAD_EXTENSIONS=new Set(ACCEPTED_UPLOADS.split(',').filter(value=>value.startsWith('.')).map(value=>value.slice(1)));
export const CHAT_UPLOAD_PROJECT_NAME=`${PRODUCT_NAME} uploads`;
export function existingUploadProjectId(conversationProjectId:string|null|undefined,projects:readonly {id:string;name:string}[]):string|null {
  if(conversationProjectId)return conversationProjectId;
  return projects.find(project=>project.name===CHAT_UPLOAD_PROJECT_NAME)?.id??null;
}
export type FileValidationProblem = 'file_limit' | 'size_limit' | 'type_denied';
export function validateFiles(files: readonly Pick<File,'name'|'size'>[]): FileValidationProblem | null {
  if(files.length>10) return 'file_limit';
  if(files.reduce((n,file)=>n+file.size,0)>50*1024*1024) return 'size_limit';
  if(files.some(file=>file.size>25*1024*1024)) return 'size_limit';
  if(files.some(file=>!ACCEPTED_UPLOAD_EXTENSIONS.has(file.name.split('.').at(-1)?.toLowerCase()??''))) return 'type_denied';
  return null;
}

// Uploads are deduplicated by project and digest. A draft cannot know whether the returned file row
// was newly created or already backs a historical message, so removing a chip is local detach only.
export function detachUpload(items:readonly UploadItem[],localId:string):UploadItem[] {
  return items.filter(item=>item.localId!==localId);
}
