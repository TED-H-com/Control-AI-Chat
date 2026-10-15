import { apiFetch } from '../api.js';
import type { AvailableAssistant, AvailableModel, ChatInput, ChatRun, Conversation, ConversationDetail, FileDetail, Me, Permission, Project, RoleKey, Skill, ToneKey, UserPreferences, UUID } from '@shared/types';
import type { ChatMode, ReasoningEffort } from './routing.js';
import type { PinnableProvider } from '@shared/types';
import type { ProjectFile } from './types.js';

export type ChatInputWithEffort = Pick<ChatInput,'conversationId'|'projectId'|'content'|'fileIds'|'clientRequestId'> & { reasoningEffort: ReasoningEffort;tone?:ToneKey;role?:RoleKey;assistantId?:string|null;mode:ChatMode;modelId?:string;provider?:PinnableProvider };
export interface ChatCapabilities { permissions:readonly Permission[];tenantId?:string;tenantName?:string;tenantSlug?:string;tenant?:{id:string;name:string;slug:string} }
export interface ChatSelection {mode:ChatMode;modelId?:string;provider?:PinnableProvider}
export interface CursorPage<T> {data:T[];hasMore:boolean;nextCursor:string|null}
export type ConversationListOptions = Readonly<{status?:'active'|'archived';q?:string;cursor?:string|null;limit?:number}>;

export function conversationListPath({status='active',q,cursor,limit=200}:ConversationListOptions={}):string{
  const params=new URLSearchParams({limit:String(limit),status});
  if(q)params.set('q',q);
  if(cursor)params.set('cursor',cursor);
  return `/api/v1/conversations?${params}`;
}

export async function collectConversationSearch(q:string,fetchPage:(options:ConversationListOptions)=>Promise<CursorPage<Conversation>>):Promise<Conversation[]>{
  const collect=async(status:'active'|'archived'):Promise<Conversation[]>=>{
    const data:Conversation[]=[];
    let cursor:string|null=null;
    do{
      const response=await fetchPage({status,q,cursor,limit:200});
      data.push(...response.data);
      cursor=response.hasMore?response.nextCursor:null;
    }while(cursor);
    return data;
  };
  const pages=await Promise.all([collect('active'),collect('archived')]);
  return pages.flat().sort((left,right)=>Date.parse(right.updatedAt)-Date.parse(left.updatedAt)||right.id.localeCompare(left.id));
}

async function allProjectPages<T>(path:string,signal?:AbortSignal):Promise<CursorPage<T>>{
  const data:T[]=[];
  let cursor:string|null=null;
  do{
    const page:CursorPage<T>=await apiFetch<CursorPage<T>>(`${path}?limit=200${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal});
    data.push(...page.data);
    cursor=page.hasMore?page.nextCursor:null;
  }while(cursor);
  return{data,hasMore:false,nextCursor:null};
}

const mutationHeaders = (version?: number): Record<string,string> => ({
  'Idempotency-Key':crypto.randomUUID(),
  ...(version === undefined ? {} : {'If-Match':`"${version}"`}),
});

export const chatApi = {
  models: (signal?:AbortSignal) => apiFetch<AvailableModel[]>('/api/v1/models',{signal}),
  assistants: (signal?:AbortSignal) => apiFetch<AvailableAssistant[]>('/api/v1/assistants',{signal}),
  conversations: (options:ConversationListOptions={},signal?:AbortSignal) => apiFetch<CursorPage<Conversation>>(conversationListPath(options),{signal}),
  conversation: (id: UUID, signal?:AbortSignal) => apiFetch<ConversationDetail>(`/api/v1/conversations/${encodeURIComponent(id)}`,{signal}),
  run: async(id:UUID,signal?:AbortSignal)=>(await apiFetch<{run:ChatRun}>(`/api/v1/chat/runs/${encodeURIComponent(id)}`,{signal})).run,
  projects: (signal?:AbortSignal) => apiFetch<CursorPage<Project>>('/api/v1/projects?limit=200',{signal}),
  project: (id:UUID,signal?:AbortSignal) => apiFetch<Project>(`/api/v1/projects/${encodeURIComponent(id)}`,{signal}),
  projectFiles: (id:UUID,signal?:AbortSignal) => allProjectPages<ProjectFile>(`/api/v1/projects/${encodeURIComponent(id)}/files`,signal),
  projectConversations: (id:UUID,signal?:AbortSignal) => allProjectPages<Conversation>(`/api/v1/projects/${encodeURIComponent(id)}/conversations`,signal),
  skills: (signal?:AbortSignal) => apiFetch<CursorPage<Skill>>('/api/v1/skills?limit=200',{signal}),
  capabilities: (signal?:AbortSignal) => apiFetch<ChatCapabilities>('/api/v1/admin/me/capabilities',{signal}),
  updateConversation: (id: UUID, body: Record<string, unknown>, version: number) => apiFetch<Conversation>(`/api/v1/conversations/${encodeURIComponent(id)}`, {method:'PATCH',headers:mutationHeaders(version),body:JSON.stringify(body)}),
  deleteConversation: (id: UUID, version: number) => apiFetch<void>(`/api/v1/conversations/${encodeURIComponent(id)}`, {method:'DELETE',headers:mutationHeaders(version)}),
  createProject: (body: {name:string;instructions?:string}) => apiFetch<Project>('/api/v1/projects', {method:'POST',headers:mutationHeaders(),body:JSON.stringify(body)}),
  uploadFile: (file:File,projectId:UUID) => { const body=new FormData();body.set('file',file);body.set('projectId',projectId);return apiFetch<FileDetail>('/api/v1/files',{method:'POST',headers:mutationHeaders(),body}); },
  updateProject: (id: UUID, body: {name?:string;instructions?:string}, version: number) => apiFetch<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, {method:'PATCH',headers:mutationHeaders(version),body:JSON.stringify(body)}),
  // Four message-level actions pointed at paths the server never routed, so regenerate, edit and
  // resend, stop, and “send anyway” after a warning each answered 404. The server's paths are in
  // server/src/routes/catalog.ts and server/src/routes/chat.ts; these are those.
  stop: (runId: UUID) => apiFetch<{runId:UUID;status:string}>(`/api/v1/chat/runs/${encodeURIComponent(runId)}`, {method:'DELETE'}),
  confirmWarning: (token: string) => ({path:`/api/v1/gate/confirmations/${encodeURIComponent(token)}`, body:{confirmed:true}}),
  preferences: (body: Partial<UserPreferences>) => apiFetch<UserPreferences>('/api/v1/me/preferences', {method:'PATCH',headers:mutationHeaders(),body:JSON.stringify(body)}),
  me: (signal?:AbortSignal) => apiFetch<Me>('/api/v1/auth/me',{signal}),
  mfaSetup: () => apiFetch<{secret:string;otpauthUri:string}>('/api/v1/identity/mfa/totp/setup',{method:'POST',body:'{}'}),
  mfaVerify: (code:string) => apiFetch<{recoveryCodes:string[];enabledAt:number}>('/api/v1/identity/mfa/totp/verify',{method:'POST',body:JSON.stringify({code})}),
  mfaDelete: () => apiFetch<void>('/api/v1/identity/mfa/totp',{method:'DELETE'}),
  runRequest: (input: ChatInputWithEffort) => ({path:'/api/v1/chat/runs', body:input}),
  regenerateRequest: (messageId: UUID, selection:ChatSelection, reasoningEffort: ReasoningEffort, tone:ToneKey, role:RoleKey, assistantId:string|null) => ({path:'/api/v1/chat/runs/regenerate', body:{messageId,...selection,reasoningEffort,tone,role,assistantId,clientRequestId:crypto.randomUUID()}}),
  editRequest: (messageId: UUID, content:string, selection:ChatSelection, reasoningEffort:ReasoningEffort, tone:ToneKey, role:RoleKey, assistantId:string|null, fileIds?:readonly UUID[]) => ({path:'/api/v1/chat/runs/edit-resend',body:{messageId,content,...selection,reasoningEffort,tone,role,assistantId,...(fileIds?{fileIds} : {}),clientRequestId:crypto.randomUUID()}}),
};
