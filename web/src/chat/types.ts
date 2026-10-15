import type {
  ApiError, AvailableAssistant, AvailableModel, Conversation, ConversationDetail, FileDetail, FileRef, GateSummary,
  Message, Project, Skill, UserPreferences, UUID,
} from '@shared/types';

export type { AvailableAssistant, AvailableModel, Conversation, ConversationDetail, FileDetail, FileRef, GateSummary, Message, Project, Skill, UserPreferences, UUID };
export interface ProjectFile extends FileRef {projectId:UUID;extractedText:string|null}
export type ChatLocale = 'en' | 'zh-TW';
export type ChatView = 'chat' | 'search' | 'projects' | 'skills' | 'settings' | 'archived';

export interface ChatBootstrap {
  conversations: readonly Conversation[];
  archivedConversations: readonly Conversation[];
  projects: readonly Project[];
  skills: readonly Skill[];
  models: readonly AvailableModel[];
  assistants: readonly AvailableAssistant[];
  activeConversation: ConversationDetail | null;
  preferences: UserPreferences;
  adminAccess: boolean;
  canConfigureProviders: boolean;
  workspace: {name:string;slug?:string}|null;
}

export interface ChatRunRequest {
  path: string;
  body: unknown;
}

export type ChatFailure =
  | {kind:'run';error:ApiError['error'];partialMessageId:UUID|null}
  | {kind:'api';error:ApiError['error'];status:number}
  | {kind:'status';status:number}
  | {kind:'interrupted'};

export interface UploadItem {
  localId: string;
  file: File | null;
  remote: FileDetail | null;
  status: 'uploading' | 'processing' | 'ready' | 'rejected' | 'failed';
  error: string | null;
}

export interface ActiveRun {
  runId: UUID | null;
  conversationId: UUID | null;
  assistantMessageId: UUID | null;
  text: string;
  status: 'gating' | 'warning' | 'approval' | 'streaming' | 'stopping' | 'idle' | 'error';
  gate: GateSummary | null;
  responseGate: GateSummary | null;
  warningToken: string | null;
  failure: ChatFailure | null;
  ownerKey: string | null;
  request: ChatRunRequest | null;
}

export interface SkillInvocation {
  skill: Skill;
  arguments: Readonly<Record<string, string>>;
  preview: string;
}
