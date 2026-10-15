import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Provider, RoleKey, StreamEvent, ToneKey } from '@shared/types';
import { ApiClientError } from '../api.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { chatApi } from './api.js';
import { streamRequest } from './stream.js';
import { CHAT_EFFORTS, initialModel, reasoningEffort, routingSelection, type ChatEffort, type ChatMode } from './routing.js';
import type { ActiveRun, ChatBootstrap, ChatRunRequest, Conversation, FileDetail, FileRef, Message, Project, ProjectFile, Skill, UploadItem, UserPreferences } from './types.js';
import { hasAdminAccess, Sidebar } from './Sidebar.js';
import { ArchivedConversationsPage, ConversationDialog, type ConversationAction, type ConversationDialogState } from './ConversationManagement.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { RunWarningDialog, SkillDialog } from './Dialogs.js';
import { EmptyChat, NoModelsChat, ProjectDetailPage, ProjectsPage, SearchPage, SettingsPage, SkillsPage } from './Pages.js';
import { ConversationHeader } from './ConversationHeader.js';
import { useDeployment } from '../deployment.js';
import { bindPendingMessage, chatOwnerKey, failureFromStartCatch, ownerMatchesRoute, reconcileCompletedMessages, regenerateForSelection, retryForFailure, revisePendingMessage, runAfterFailure, startApprovalPolling } from './runState.js';
import { CHAT_UPLOAD_PROJECT_NAME, detachUpload, existingUploadProjectId, validateFiles, type FileValidationProblem } from './context.js';
import { parseChatRoute, type ChatRoute } from './routes.js';
import { canConfigureProviders } from './access.js';
import { useMobileDrawer } from '../accessibility/mobileDrawer.js';
import { useDocumentTitle } from '../documentTitle.js';
import './chat.css';
import { PRODUCT_NAME } from '@shared/brand.js';

type AttributedRun = ActiveRun & {modelId:string|null;provider:Provider|null};
const idle: AttributedRun = { runId:null, conversationId:null, assistantMessageId:null, modelId:null, provider:null, text:'',status:'idle', gate:null, responseGate:null, warningToken:null, failure:null, ownerKey:null, request:null };
const defaults: UserPreferences = { density:'comfortable', colorMode:'system', locale:'en' };
const effortStorageKey = 'app.chat.effort';
const settingsHistoryKey = 'app.settings.entry';
type ConversationMutation = 'rename'|'pin'|'unpin'|'archive'|'restore'|'delete';
type PendingTurn = Readonly<{ownerKey:string;message:Message}>;

export function applyMessageCreated(run:AttributedRun,event:Extract<StreamEvent,{event:'message.created'}>,ownerKey:string):AttributedRun {
  return run.ownerKey === ownerKey ? {...run,assistantMessageId:event.data.message.id,modelId:event.data.message.modelId,provider:event.data.message.provider} : run;
}

function ordered(conversations:readonly Conversation[]): Conversation[] {
  return [...conversations].sort((left,right) => Number(right.pinned)-Number(left.pinned) || Date.parse(right.updatedAt)-Date.parse(left.updatedAt) || right.id.localeCompare(left.id));
}

function route(): ChatRoute { return parseChatRoute(location.pathname)??{view:'chat',id:null}; }

function sameRoute(left:ChatRoute,right:ChatRoute):boolean {
  return left.view === right.view && left.id === right.id;
}

function storedEffort(): ChatEffort {
  try {
    const value = localStorage.getItem(effortStorageKey);
    if (CHAT_EFFORTS.includes(value as ChatEffort)) return value as ChatEffort;
  } catch { /* Device storage is optional. */ }
  return 'standard';
}

function fileDetail(file:FileRef,projectId:string|null):FileDetail {
  return {...file,projectId,extractedChars:null,gate:null,failureCode:null,version:0};
}

function existingUploads(files:readonly FileRef[],projectId:string|null):UploadItem[] {
  return files.map(file=>({localId:`existing:${file.id}`,file:null,remote:fileDetail(file,projectId),status:file.status==='ready'?'ready':'failed',error:null}));
}

export function ChatApp() {
  const deployment=useDeployment(),brandName=deployment.brandName?.trim()||PRODUCT_NAME;
  const supportVisible=Boolean(deployment.support&&Object.values(deployment.support).some(Boolean));
  const { locale, setLocale, t } = useI18n();
  const [data, setData] = useState<ChatBootstrap>({ conversations:[], archivedConversations:[], projects:[], skills:[], models:[], assistants:[], activeConversation:null, preferences:defaults, adminAccess:false, canConfigureProviders:false, workspace:null });
  const [current, setCurrent] = useState(route);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string|null>(null);
  const [projectDetail,setProjectDetail]=useState<{project:Project;files:readonly ProjectFile[];conversations:readonly Conversation[]}|null>(null);
  const [projectMissing,setProjectMissing]=useState(false);
  const [draft, setDraft] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadProblem,setUploadProblem]=useState<FileValidationProblem|null>(null);
  const resetUploads = ():void => {
    setUploads([]);
    setUploadProblem(null);
  };
  const [modelId, setModelId] = useState('');
  const [assistantId,setAssistantId]=useState<string|null>(null);
  const [chatMode,setChatMode]=useState<ChatMode>('auto');
  const [effort, setEffort] = useState<ChatEffort>(storedEffort);
  const [tone,setTone]=useState<ToneKey>('default');
  const [role,setRole]=useState<RoleKey>('default');
  const [run, setRun] = useState(idle);
  const [pending, setPending] = useState<PendingTurn|null>(null);
  const [editingMessage, setEditingMessage] = useState<Message|null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [skill, setSkill] = useState<Skill|null>(null);
  const [showMetadata, setShowMetadata] = useState(() => localStorage.getItem('app.metadata') !== 'false');
  const [online, setOnline] = useState(navigator.onLine);
  const [conversationDialog, setConversationDialog] = useState<ConversationDialogState|null>(null);
  const [conversationDialogError, setConversationDialogError] = useState<string|null>(null);
  const [conversationBusyId, setConversationBusyId] = useState<string|null>(null);
  const [conversationFeedback, setConversationFeedback] = useState<{kind:'status'|'error';message:string}|null>(null);
  const conversationFeedbackRef = useRef<HTMLDivElement>(null);
  const sidebarRef=useRef<HTMLElement>(null),sidebarTriggerRef=useRef<HTMLButtonElement>(null),workspaceRef=useRef<HTMLDivElement>(null);
  const pendingRef = useRef<PendingTurn|null>(null);
  const loadRevision = useRef(0);
  const runAttempt = useRef(0);
  const runController = useRef<AbortController|null>(null);
  const projectFlight = useRef<Promise<Project>|null>(null);

  const sidebarActive=useMobileDrawer({open:sidebar,onClose:()=>setSidebar(false),mediaQuery:'(max-width: 1023px)',drawerRef:sidebarRef,triggerRef:sidebarTriggerRef,backgroundRef:workspaceRef});

  const setPendingTurn = (turn:PendingTurn|null): void => {
    pendingRef.current = turn;
    setPending(turn);
  };

  const clearPending = (ownerKey?:string): void => {
    if (ownerKey && pendingRef.current?.ownerKey !== ownerKey) return;
    setPendingTurn(null);
  };

  const load = async (target:ChatRoute=route(),abort=new AbortController()): Promise<void> => {
    const revision = ++loadRevision.current;
    setLoading(true);
    setLoadError(null);
    setProjectMissing(false);
    setProjectDetail(null);
    try {
      const [models, assistants, conversations, archivedConversations, projects, skills, capabilities] = await Promise.all([
        chatApi.models(abort.signal), chatApi.assistants(abort.signal), chatApi.conversations({status:'active'},abort.signal), chatApi.conversations({status:'archived'},abort.signal), chatApi.projects(abort.signal), chatApi.skills(abort.signal),
        chatApi.capabilities(abort.signal).catch(error => { if (abort.signal.aborted) throw error; return null; }),
      ]);
      const detail = target.id && target.view === 'chat' ? await chatApi.conversation(target.id,abort.signal) : null;
      let nextProjectDetail:null|{project:Project;files:readonly ProjectFile[];conversations:readonly Conversation[]}=null;
      let nextProjectMissing=false;
      if(target.id&&target.view==='projects'){
        try{const [project,files,projectConversations]=await Promise.all([chatApi.project(target.id,abort.signal),chatApi.projectFiles(target.id,abort.signal),chatApi.projectConversations(target.id,abort.signal)]);nextProjectDetail={project,files:files.data,conversations:projectConversations.data};}
        catch(error){if(error instanceof ApiClientError&&error.status===404)nextProjectMissing=true;else throw error;}
      }
      if (abort.signal.aborted || revision !== loadRevision.current || !sameRoute(route(),target)) return;
      setProjectDetail(nextProjectDetail);
      setProjectMissing(nextProjectMissing);
      setData(old => ({ ...old, models, assistants, conversations:conversations.data, archivedConversations:archivedConversations.data, projects:projects.data, skills:skills.data, activeConversation:detail, adminAccess:hasAdminAccess(capabilities), canConfigureProviders:canConfigureProviders(capabilities), workspace:capabilities?{name:capabilities.tenant?.name?.trim()||capabilities.tenantName?.trim()||capabilities.tenant?.slug?.trim()||capabilities.tenantSlug?.trim()||t('chat.nav.workspace'),slug:capabilities.tenant?.slug??capabilities.tenantSlug}:null }));
      setTone(detail?.conversation.tone??'default');
      setRole(detail?.conversation.role??'default');
      setAssistantId(detail?.conversation.assistantId??null);
      const optimistic = pendingRef.current;
      if (detail && optimistic?.message.conversationId === detail.conversation.id && detail.messages.some(message => message.id === optimistic.message.id)) clearPending(optimistic.ownerKey);
      // /models is already the enforced per-user allowlist. Never keep a stale or unsupported id.
      setModelId(old => initialModel(models, old)?.id ?? '');
    } catch {
      if (!abort.signal.aborted && revision === loadRevision.current && sameRoute(route(),target)) setLoadError(t('chat.state.loadError'));
    } finally {
      if (!abort.signal.aborted && revision === loadRevision.current && sameRoute(route(),target)) setLoading(false);
    }
  };

  // Refresh sidebar ordering and titles without replacing the active workspace.
  const refreshConversations = async (): Promise<void> => {
    try {
      const [conversations,archivedConversations] = await Promise.all([chatApi.conversations(),chatApi.conversations({status:'archived'})]);
      setData(old => ({ ...old, conversations:conversations.data, archivedConversations:archivedConversations.data }));
    } catch { /* A stale sidebar is preferable to an error screen. */ }
  };

  const refreshActiveConversation = async (conversationId:string): Promise<void> => {
    try {
      const detail = await chatApi.conversation(conversationId);
      if (route().id !== conversationId) return;
      setData(old => ({...old,activeConversation:detail}));
      const optimistic = pendingRef.current;
      if (optimistic?.message.conversationId === conversationId && detail.messages.some(message => message.id === optimistic.message.id)) clearPending(optimistic.ownerKey);
    } catch { /* The reconciled stream result remains visible until the next successful load. */ }
  };

  useEffect(() => {
    const abort = new AbortController();
    void load(current,abort);
    return () => abort.abort();
  }, [current.id, current.view]);
  useEffect(() => {
    if (!data.models.length) return;
    const fallback = initialModel(data.models, modelId);
    if (fallback && fallback.id !== modelId) setModelId(fallback.id);
  }, [data.models, modelId]);
  useEffect(() => {
    const sync = (): void => setOnline(navigator.onLine);
    addEventListener('online', sync);
    addEventListener('offline', sync);
    return () => {
      removeEventListener('online', sync);
      removeEventListener('offline', sync);
    };
  }, []);

  const navigate = (path:string): void => {
    const opensSettings = /^\/settings(?:\/|$)/.test(path);
    if (opensSettings && current.view === 'settings') history.replaceState(history.state ?? {}, '', path);
    else history.pushState(opensSettings ? { [settingsHistoryKey]: true } : {}, '', path);
    setCurrent(route());
    setEditingMessage(null);
    resetUploads();
    setSidebar(false);
  };
  const closeSettings = (): void => {
    if (history.state?.[settingsHistoryKey] === true) {
      history.back();
      return;
    }
    history.replaceState({}, '', '/chat');
    setCurrent(route());
    setEditingMessage(null);
    resetUploads();
    setSidebar(false);
  };
  useEffect(() => {
    const pop = (): void => { setCurrent(route()); setEditingMessage(null); resetUploads(); };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);

  const applyConversation = (conversation:Conversation): void => {
    setData(old => {
      const withoutActive = old.conversations.filter(item => item.id !== conversation.id);
      const withoutArchived = old.archivedConversations.filter(item => item.id !== conversation.id);
      return {
        ...old,
        conversations:conversation.status === 'active' ? ordered([...withoutActive,conversation]) : withoutActive,
        archivedConversations:conversation.status === 'archived' ? ordered([...withoutArchived,conversation]) : withoutArchived,
        activeConversation:old.activeConversation?.conversation.id === conversation.id ? {...old.activeConversation,conversation} : old.activeConversation,
      };
    });
  };

  const successMessage = (mutation:ConversationMutation): string => {
    switch (mutation) {
      case 'rename': return t('chat.conversation.success.renamed');
      case 'pin': return t('chat.conversation.success.pinned');
      case 'unpin': return t('chat.conversation.success.unpinned');
      case 'archive': return t('chat.conversation.success.archived');
      case 'restore': return t('chat.conversation.success.restored');
      case 'delete': return t('chat.conversation.success.deleted');
    }
  };

  const mutateConversation = async (mutation:ConversationMutation,conversation:Conversation,title?:string): Promise<boolean> => {
    setConversationBusyId(conversation.id);
    setConversationDialogError(null);
    setConversationFeedback(null);
    try {
      if (mutation === 'delete') {
        await chatApi.deleteConversation(conversation.id,conversation.version);
        setData(old => ({
          ...old,
          conversations:old.conversations.filter(item => item.id !== conversation.id),
          archivedConversations:old.archivedConversations.filter(item => item.id !== conversation.id),
          activeConversation:old.activeConversation?.conversation.id === conversation.id ? null : old.activeConversation,
        }));
      } else {
        const body = mutation === 'rename' ? {title} : mutation === 'pin' ? {pinned:true} : mutation === 'unpin' ? {pinned:false} : mutation === 'archive' ? {status:'archived'} : {status:'active'};
        applyConversation(await chatApi.updateConversation(conversation.id,body,conversation.version));
      }
      setConversationFeedback({kind:'status',message:successMessage(mutation)});
      if (route().id === conversation.id && (mutation === 'archive' || mutation === 'delete')) navigate(mutation === 'archive' ? '/archived' : '/chat');
      if (mutation === 'archive' || mutation === 'restore' || mutation === 'delete') requestAnimationFrame(() => conversationFeedbackRef.current?.focus());
      return true;
    } catch (error) {
      const stale = error instanceof ApiClientError && (error.status === 404 || error.status === 409 || error.status === 412 || error.body.error.code === 'PRECONDITION_FAILED');
      const rejected = error instanceof ApiClientError && error.status < 500;
      const message = stale ? t('chat.conversation.error.stale') : rejected ? t('chat.conversation.error.rejected') : t('chat.conversation.error.uncertain');
      if (stale) {
        setConversationDialog(null);
        setConversationFeedback({kind:'error',message});
        void refreshConversations();
      } else if (rejected && conversationDialog?.conversation.id === conversation.id) {
        setConversationDialogError(message);
      } else {
        setConversationDialog(null);
        setConversationFeedback({kind:'error',message});
        if (!rejected) void refreshConversations();
      }
      return false;
    } finally {
      setConversationBusyId(null);
    }
  };

  const manageConversation = (action:ConversationAction,conversation:Conversation): void => {
    setConversationDialogError(null);
    setConversationFeedback(null);
    if (action === 'rename' || action === 'delete') {
      setConversationDialog({kind:action,conversation});
      return;
    }
    if (action === 'pin') void mutateConversation(conversation.pinned?'unpin':'pin',conversation);
    else void mutateConversation('archive',conversation);
  };

  const applyEvent = (event:StreamEvent,ownerKey:string): void => {
    switch (event.event) {
      case 'run.created': {
        const optimistic = pendingRef.current;
        if (optimistic?.ownerKey === ownerKey) setPendingTurn({...optimistic,message:bindPendingMessage(optimistic.message,event.data.run.conversationId,event.data.run.userMessageId)!});
        setRun(old => old.ownerKey === ownerKey ? ({ ...old, runId:event.data.run.id, conversationId:event.data.run.conversationId, assistantMessageId:event.data.run.assistantMessageId, status:'gating' }) : old);
        break;
      }
      case 'run.status':
        setRun(old => old.ownerKey === ownerKey ? ({ ...old,status:event.data.status === 'streaming' ? 'streaming' : old.status }) : old);
        break;
      case 'message.created':
        setRun(old => applyMessageCreated(old,event,ownerKey));
        break;
      case 'gate.notice':
        setRun(old => old.ownerKey === ownerKey ? ({
          ...old,
          status:event.data.direction==='inbound'?old.status:event.data.action === 'warn' ? 'warning' : event.data.action === 'require_approval' ? 'approval' : old.status,
          warningToken:event.data.confirmationToken ?? null,
          ...(event.data.direction==='inbound'
            ? {responseGate:{decisionId:event.data.decisionId,action:event.data.action,direction:event.data.direction,detectorCount:0,protectedItemCount:event.data.protectedItemCount,approvalId:event.data.approvalId??null,userNotice:event.data.message}}
            : {gate:{decisionId:event.data.decisionId,action:event.data.action,direction:event.data.direction,detectorCount:0,protectedItemCount:event.data.protectedItemCount,approvalId:event.data.approvalId??null,userNotice:event.data.message}}),
        }) : old);
        break;
      case 'assistant.delta':
        setRun(old => old.ownerKey === ownerKey ? ({ ...old,text:old.text + event.data.text, status:'streaming', assistantMessageId:event.data.messageId }) : old);
        break;
      case 'run.completed': {
        const conversationId = event.data.conversationId;
        const pendingTurn = pendingRef.current;
        const optimistic = pendingTurn?.ownerKey === ownerKey ? pendingTurn.message : null;
        setData(old => old.activeConversation?.conversation.id === conversationId
          ? {...old,activeConversation:{...old.activeConversation,messages:reconcileCompletedMessages(old.activeConversation.messages,optimistic,event.data.message)}}
          : old);
        clearPending(ownerKey);
        setRun(old => old.ownerKey === ownerKey ? idle : old);
        // Put a server-created first conversation into the URL before a later refresh can lose it.
        const activeRoute = route();
        if (conversationId && ownerMatchesRoute(ownerKey,activeRoute.view,activeRoute.id) && !activeRoute.id) {
          history.replaceState({}, '', `/chat/${encodeURIComponent(conversationId)}`);
          setCurrent(route());
        } else if (activeRoute.id === conversationId) {
          void refreshActiveConversation(conversationId);
        }
        void refreshConversations();
        break;
      }
      case 'run.cancelled':
        clearPending(ownerKey);
        setRun(old => old.ownerKey === ownerKey ? idle : old);
        if (ownerMatchesRoute(ownerKey,route().view,route().id)) void load();
        else void refreshConversations();
        break;
      case 'run.failed':
        // Keep the pending question visible next to the failure instead of silently removing it.
        setRun(old => old.ownerKey === ownerKey ? runAfterFailure(old,event.data) : old);
        break;
    }
  };

  const start = async (request:ChatRunRequest,ownerKey:string): Promise<void> => {
    const attempt = ++runAttempt.current;
    const abort = new AbortController();
    runController.current = abort;
    setRun({ ...idle, ownerKey, request, status:'gating' });
    try {
      await streamRequest(request.path,request.body,abort.signal,event => {
        if (attempt === runAttempt.current) applyEvent(event,ownerKey);
      });
    } catch (caught) {
      if (!abort.signal.aborted && attempt === runAttempt.current) setRun(old => old.ownerKey === ownerKey ? ({ ...old, status:'error', failure:failureFromStartCatch(caught) }) : old);
    } finally {
      if (attempt === runAttempt.current && runController.current === abort) runController.current = null;
    }
  };

  const activeConversation = current.view === 'chat' && data.activeConversation?.conversation.id === current.id ? data.activeConversation : null;
  const busy = ['gating', 'streaming', 'stopping', 'warning', 'approval'].includes(run.status);
  const stoppable = ['gating', 'streaming', 'stopping'].includes(run.status);
  const requestEffort = reasoningEffort(effort);
  const chatSelection=routingSelection(data.models,chatMode,modelId);
  const regenerate=(messageId:string)=>regenerateForSelection(messageId,chatMode,modelId,assistantId,chatSelection,requestEffort,tone,role);
  const ensureUploadProject = async ():Promise<string> => {
    const existing=existingUploadProjectId(activeConversation?.conversation.projectId,data.projects);
    if(existing)return existing;
    if(!projectFlight.current)projectFlight.current=chatApi.createProject({name:CHAT_UPLOAD_PROJECT_NAME});
    try {
      const created=await projectFlight.current;
      setData(old=>({...old,projects:old.projects.some(project=>project.id===created.id)?old.projects:[created,...old.projects]}));
      return created.id;
    } finally { projectFlight.current=null; }
  };
  const addFiles = (files:readonly File[]):void => {
    setUploadProblem(null);
    const currentFiles=uploads.flatMap(item=>item.file?[item.file]:item.remote?[{name:item.remote.name,size:item.remote.sizeBytes}]:[]);
    const problem=validateFiles([...currentFiles,...files]);
    if(problem){setUploadProblem(problem);return;}
    const items=files.map(file=>({localId:crypto.randomUUID(),file,remote:null,status:'uploading' as const,error:null}));
    setUploads(old=>[...old,...items]);
    void (async()=>{
      let projectId:string;
      try{projectId=await ensureUploadProject();}
      catch{
        setUploads(old=>old.map(item=>items.some(candidate=>candidate.localId===item.localId)?{...item,status:'failed',error:t('chat.composer.error.upload_failed')}:item));
        return;
      }
      await Promise.all(items.map(async item=>{
        try{
          const remote=await chatApi.uploadFile(item.file!,projectId);
          const status=remote.status==='ready'?'ready':remote.status==='rejected'?'rejected':'failed';
          const error=status==='ready'?null:t('chat.composer.error.scan_failed');
          setUploads(old=>old.map(candidate=>candidate.localId===item.localId?{...candidate,remote,status,error}:candidate));
        }catch(error){
          const problem=error instanceof ApiClientError&&error.body.error.code==='FILE_TOO_LARGE'?'size_limit'
            :error instanceof ApiClientError&&error.body.error.code==='FILE_TYPE_NOT_ALLOWED'?'type_denied':'upload_failed';
          const message=t(`chat.composer.error.${problem}`);
          setUploads(old=>old.map(candidate=>candidate.localId===item.localId?{...candidate,status:'failed',error:message}:candidate));
        }
      }));
    })();
  };
  const removeUpload = (item:UploadItem):void => {
    setUploads(old=>detachUpload(old,item.localId));
  };
  const send = (): void => {
    if (current.view !== 'chat' || !online || (chatMode==='single'&&!modelId&&!assistantId) || (!draft.trim()&&!uploads.some(item=>item.status==='ready')) || busy || uploads.some(item=>item.status!=='ready'||!item.remote)) return;
    const content = draft.trim();
    const ownerKey = chatOwnerKey(current.id);
    const editing = editingMessage?.conversationId === current.id ? editingMessage : null;
    const attached=uploads.flatMap(item=>item.remote?[item.remote]:[]);
    const fileIds=attached.map(file=>file.id);
    const projectId=activeConversation?.conversation.projectId??attached[0]?.projectId??undefined;
    const request = editing
      ? chatApi.editRequest(editing.id,content,chatSelection,requestEffort,tone,role,assistantId??null,fileIds)
      : chatApi.runRequest({ conversationId:current.id ?? undefined, projectId, content, ...chatSelection, fileIds, reasoningEffort:requestEffort, tone, role, assistantId:assistantId??null, clientRequestId:crypto.randomUUID() });
    setPendingTurn({ownerKey,message:{ id:crypto.randomUUID(), conversationId:current.id ?? '', parentMessageId:null, role:'user', content, modelId:null, provider:null, createdAt:new Date().toISOString(), inputTokens:null, outputTokens:null, costUsd:null, gate:null, attachments:attached, version:1 }});
    setDraft('');
    resetUploads();
    setEditingMessage(null);
    void start(request,ownerKey);
  };

  const stopRun = (): void => {
    const runId = run.runId;
    setRun(old => ({ ...old, status:'stopping' }));
    const finish = (): void => {
      runAttempt.current += 1;
      runController.current?.abort();
      runController.current = null;
      setRun(idle);
      if (run.ownerKey) clearPending(run.ownerKey);
      void load();
    };
    if (runId) void chatApi.stop(runId).catch(() => undefined).finally(finish);
    else finish();
  };

  // This closes only the local notice. There is no API that cancels a durable approval request.
  const dismissApproval = (): void => {
    runAttempt.current += 1;
    runController.current?.abort();
    runController.current = null;
    setRun(idle);
    if (run.ownerKey) clearPending(run.ownerKey);
    void load();
  };

  const reviseWarning = (): void => {
    const pendingTurn = pendingRef.current?.ownerKey === run.ownerKey ? pendingRef.current : null;
    const revision = revisePendingMessage(pendingTurn?.message ?? null);
    if (revision.draft !== null) setDraft(revision.draft);
    if(pendingTurn)setUploads(existingUploads(pendingTurn.message.attachments,activeConversation?.conversation.projectId??null));
    runAttempt.current += 1;
    runController.current?.abort();
    runController.current = null;
    if (run.ownerKey) clearPending(run.ownerKey);
    setRun(idle);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.ui-composer textarea')?.focus());
  };

  const chooseEffort = (next:ChatEffort): void => {
    setEffort(next);
    try { localStorage.setItem(effortStorageKey, next); } catch { /* Device storage is optional. */ }
  };

  const chooseModel = (id:string): void => {
    const selected = data.models.find(model => model.id === id && model.enabled);
    if (!selected) return;
    setModelId(selected.id);
  };
  const chooseMode=(mode:ChatMode):void=>{setChatMode(mode);if(mode==='multi_model')chooseEffort('fast')};

  useEffect(()=>{
    if(run.status!=='approval'||!run.runId||!run.conversationId||!run.ownerKey||current.view!=='chat')return;
    const runId=run.runId;
    const conversationId=run.conversationId;
    const ownerKey=run.ownerKey;
    return startApprovalPolling({
      fetchRun:signal=>chatApi.run(runId,signal),
      fetchConversation:signal=>chatApi.conversation(conversationId,signal),
      onResolved:detail=>{
        const activeRoute=route();
        if(!ownerMatchesRoute(ownerKey,activeRoute.view,activeRoute.id))return;
        setData(old=>({...old,activeConversation:detail}));
        clearPending(ownerKey);
        setRun(old=>old.ownerKey===ownerKey&&old.status==='approval'?idle:old);
        if(!activeRoute.id){
          history.replaceState({},'',`/chat/${encodeURIComponent(conversationId)}`);
          setCurrent(route());
        }
        void refreshConversations();
      },
    });
  },[current.id,current.view,run.conversationId,run.ownerKey,run.runId,run.status]);

  const runVisible = ownerMatchesRoute(run.ownerKey,current.view,current.id);
  const availableModels=useMemo(()=>data.models.filter(model=>model.enabled),[data.models]);
  const messages = useMemo(() => {
    const stored = activeConversation?.messages ?? [];
    const optimistic = runVisible && pending?.ownerKey === run.ownerKey ? pending.message : null;
    return optimistic && !stored.some(message => message.id === optimistic.id) ? [...stored, optimistic] : stored;
  }, [activeConversation, pending, run.ownerKey, runVisible]);
  const status = run.status === 'streaming' ? t('chat.message.responding') : run.status === 'stopping' ? t('chat.message.stopping') : null;
  const retry=run.failure?retryForFailure(run.failure,run.request,regenerate):null;
  const conversationKey = current.id ?? activeConversation?.conversation.id ?? 'new';
  const emptyChat = current.view === 'chat' && availableModels.length>0 && !loading && !loadError && messages.length === 0 && !(runVisible && (run.text || busy));
  const headerTitle = current.view === 'chat' ? activeConversation?.conversation.title ?? t('chat.nav.newChat')
    : current.view === 'archived' ? t('chat.conversation.archivedTitle')
    : current.view === 'search' ? t('chat.nav.search')
    : current.view === 'projects' ? projectDetail?.project.name??t('chat.nav.projects')
    : current.view === 'skills' ? t('chat.nav.skills')
    : t('chat.nav.settings');
  useDocumentTitle(headerTitle);

  return <div className="ui-app">
    <a className="ui-skip" href="#chat-main">{t('chat.accessibility.skip')}</a>
    {sidebarActive && <div className="ui-sidebar-backdrop" aria-hidden="true" onClick={() => setSidebar(false)} />}
    <ConversationHeader title={headerTitle} t={t} productName={brandName} brandIconUrl={deployment.brandIconUrl} adminAccess={data.adminAccess} navigationOpen={sidebarActive} navigationTriggerRef={sidebarTriggerRef} onOpenNavigation={() => setSidebar(true)} />
    <Sidebar drawerRef={sidebarRef} open={sidebarActive} conversations={data.conversations} projects={data.projects} activeId={current.view==='chat'?current.id:null} archivedActive={current.view==='archived'} busyId={conversationBusyId} adminAccess={data.adminAccess} workspace={data.workspace} locale={locale} t={t} onNavigate={navigate} onAction={manageConversation} onClose={() => setSidebar(false)} />
    <div ref={workspaceRef} className={`ui-workspace${emptyChat?' is-empty-chat':''}${(!online||conversationFeedback)?' has-notice':''}`}>
      {(!online||conversationFeedback)&&<div className="ui-notice-stack">
        {!online && <div className="ui-offline" role="status"><strong>{t('chat.status.offline')}</strong></div>}
        {conversationFeedback && <div ref={conversationFeedbackRef} tabIndex={-1} className={`ui-conversation-feedback ${conversationFeedback.kind==='error'?'is-error':''}`} role={conversationFeedback.kind==='error'?'alert':'status'}><strong>{conversationFeedback.message}</strong><button type="button" className="ui-icon-button" title={t('common.close')} aria-label={t('common.close')} onClick={() => setConversationFeedback(null)}><X size={17}/></button></div>}
      </div>}
      {loading && (!data.models.length || Boolean(current.view === 'chat' && current.id && !activeConversation) || Boolean(current.view === 'projects' && current.id && !projectDetail && !projectMissing))
        ? <main id="chat-main" className="ui-state" aria-busy="true">{t('chat.state.loading')}</main>
        : loadError
          ? <main id="chat-main" className="ui-state" role="alert">{loadError}<button className="ui-button ui-secondary" onClick={() => void load()}>{t('common.retry')}</button>{supportVisible&&<p>{t('chat.settings.support')}: {deployment.support?.vendorName} {deployment.support?.email&&<a href={`mailto:${deployment.support.email}`}>{deployment.support.email}</a>} {deployment.support?.phone} {deployment.support?.url&&<a href={deployment.support.url} rel="noreferrer">{deployment.support.url}</a>}</p>}</main>
          : current.view === 'archived'
            ? <ArchivedConversationsPage conversations={data.archivedConversations} locale={locale} busyId={conversationBusyId} t={t} onRestore={conversation => void mutateConversation('restore',conversation)} onAction={manageConversation} />
          : current.view === 'search'
            ? <SearchPage locale={locale} t={t} onOpen={id => navigate(`/chat/${encodeURIComponent(id)}`)} />
            : current.view === 'projects'
              ? current.id
                ? <ProjectDetailPage detail={projectMissing?null:projectDetail} locale={locale} t={t} onBack={()=>navigate('/projects')} onOpenConversation={id=>navigate(`/chat/${encodeURIComponent(id)}`)} onUpdate={async(name,instructions)=>{if(!projectDetail)return;const project=await chatApi.updateProject(projectDetail.project.id,{name,instructions},projectDetail.project.version);setProjectDetail(old=>old?{...old,project}:old);setData(old=>({...old,projects:old.projects.map(item=>item.id===project.id?project:item)}));}} />
                : <ProjectsPage projects={data.projects} locale={locale} t={t} onOpen={id => navigate(`/projects/${encodeURIComponent(id)}`)} onCreate={(name, instructions) => void chatApi.createProject({ name, instructions }).then(() => load())} />
              : current.view === 'skills'
                ? <SkillsPage skills={data.skills} locale={locale} t={t} onInvoke={setSkill} />
                : current.view === 'settings'
                  ? <SettingsPage models={data.models} showMetadata={showMetadata} locale={locale} t={t} support={deployment.support} onClose={closeSettings} onLocale={next => void setLocale(next)} onMetadata={value => { setShowMetadata(value); localStorage.setItem('app.metadata', String(value)); }} onArchived={() => navigate('/archived')} />
                  : messages.length || (runVisible && (run.text || busy))
                    ? <MessageList conversationKey={conversationKey} messages={messages} models={data.models} streamText={runVisible?run.text:''} streamStatus={runVisible?(status ?? undefined):undefined} streamPhase={runVisible?run.status:undefined} streamModelId={runVisible?run.modelId:null} streamProvider={runVisible?run.provider:null} liveGate={runVisible?run.gate:null} liveResponseGate={runVisible?run.responseGate:null} failure={runVisible?run.failure:null} retry={runVisible?retry:null} failureSupport={supportVisible?<p>{t('chat.settings.support')}: {deployment.support?.vendorName} {deployment.support?.email&&<a href={`mailto:${deployment.support.email}`}>{deployment.support.email}</a>} {deployment.support?.phone} {deployment.support?.url&&<a href={deployment.support.url} rel="noreferrer">{deployment.support.url}</a>}</p>:null} showMetadata={showMetadata} locale={locale} t={t} onEdit={message => { if (busy || current.id !== message.conversationId) return; setEditingMessage(message); setDraft(message.content); setUploads(existingUploads(message.attachments,activeConversation?.conversation.projectId??null)); document.querySelector<HTMLTextAreaElement>('.ui-composer textarea')?.focus(); }} onRegenerate={message => { if (busy || current.id !== message.conversationId)return;const request=regenerate(message.id);if(request)void start(request,chatOwnerKey(message.conversationId)); }} onRetry={request=>{document.querySelector<HTMLTextAreaElement>('.ui-composer textarea')?.focus();if(run.ownerKey)void start(request,run.ownerKey);}} onDismissApproval={runVisible&&run.status==='approval'?dismissApproval:undefined} />
                    : availableModels.length===0
                      ? <NoModelsChat t={t} canConfigure={data.canConfigureProviders} support={deployment.support}/>
                      : <EmptyChat t={t} onPrompt={text => { setEditingMessage(null); setDraft(text); }} />}
      {current.view === 'chat' && availableModels.length>0 && <Composer text={draft} onText={setDraft} models={availableModels} modelId={modelId} onModel={chooseModel} assistants={data.assistants} assistantId={assistantId} onAssistant={setAssistantId} mode={chatMode} onMode={chooseMode} effort={effort} onEffort={chooseEffort} tone={tone} onTone={setTone} role={role} onRole={setRole} streaming={runVisible&&stoppable} disabled={!online || busy} uploads={uploads} uploadProblem={uploadProblem} onFiles={addFiles} onDismissUploadProblem={()=>setUploadProblem(null)} onRemoveFile={removeUpload} onSend={send} onStop={stopRun} t={t} />}
    </div>
    <RunWarningDialog visible={runVisible} run={run} t={t} onBack={reviseWarning} onConfirm={() => { if (run.warningToken&&run.ownerKey) { const request = chatApi.confirmWarning(run.warningToken); void start(request,run.ownerKey); } }} />
    {conversationDialog && <ConversationDialog state={conversationDialog} busy={conversationBusyId!==null} error={conversationDialogError} t={t} onClose={() => {setConversationDialog(null);setConversationDialogError(null);}} onRename={title => {
      const state = conversationDialog;
      if (state?.kind === 'rename') void mutateConversation('rename',state.conversation,title).then(saved => {if(saved)setConversationDialog(null);});
    }} onDelete={() => {
      const state = conversationDialog;
      if (state?.kind === 'delete') void mutateConversation('delete',state.conversation).then(deleted => {if(deleted)setConversationDialog(null);});
    }} />}
    <SkillDialog skill={skill} t={t} onClose={() => setSkill(null)} onApply={args => {
      if (!skill) return;
      setEditingMessage(null);
      setDraft(skill.template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key:string) => args[key] ?? ''));
      setSkill(null);
    }} />
  </div>;
}

export default ChatApp;
