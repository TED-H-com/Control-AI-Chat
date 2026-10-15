import { Archive, FolderKanban, Pin, Plus, Search, Settings, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Ref } from 'react';
import type { Conversation, Project } from './types.js';
import type { Permission } from '@shared/api';
import type { Locale } from '../i18n/types.js';
import { formatDate } from '../i18n/formatters.js';
import type { ChatTranslate } from './i18n.js';
import { ConversationActionMenu, type ConversationAction } from './ConversationManagement.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';

export const hasAdminAccess=(capabilities:{permissions:readonly Permission[]}|null):boolean=>Boolean(capabilities?.permissions.includes('admin:users'));
interface WorkspaceIdentity {name:string;slug?:string}
export interface SidebarProps {open:boolean;conversations:readonly Conversation[];projects:readonly Project[];activeId:string|null;archivedActive:boolean;busyId:string|null;adminAccess:boolean;workspace:WorkspaceIdentity|null;locale:Locale;t:ChatTranslate;drawerRef?:Ref<HTMLElement>;onNavigate:(path:string)=>void;onAction:(action:ConversationAction,conversation:Conversation)=>void;onClose:()=>void}

export function Sidebar({open,conversations,projects,activeId,archivedActive,busyId,adminAccess,workspace,locale,t,drawerRef,onNavigate,onAction,onClose}:SidebarProps){return <aside id="ui-chat-navigation" ref={drawerRef} className={`ui-sidebar ${open?'is-open':''}`} aria-label={t('chat.nav.primary')} role={open?'dialog':undefined} aria-modal={open||undefined} tabIndex={open?-1:undefined}>
  <div className="ui-drawer-head"><button type="button" className="ui-mobile-only ui-icon-button" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}><X size={19}/></button></div>
  <button className="ui-secondary ui-new-chat" onClick={()=>onNavigate('/chat')}><Plus size={18}/><span>{t('chat.nav.newChat')}</span></button>
  <nav className="ui-primary-nav"><button onClick={()=>onNavigate('/search')}><Search size={17}/><span>{t('chat.nav.search')}</span></button><button onClick={()=>onNavigate('/projects')}><FolderKanban size={17}/><span>{t('chat.nav.projects')}</span></button><button onClick={()=>onNavigate('/skills')}><Sparkles size={17}/><span>{t('chat.nav.skills')}</span></button></nav>
  <section className="ui-project-nav"><h2>{t('chat.nav.projects')}</h2>{projects.length===0?<p>{t('chat.project.sidebarEmpty')}</p>:projects.map(project=><button key={project.id} onClick={()=>onNavigate(`/projects/${encodeURIComponent(project.id)}`)}>{project.name}</button>)}</section>
  <section className="ui-conversation-nav"><h2>{t('chat.nav.conversations')}</h2>{conversations.length===0?<p>{t('chat.nav.noConversations')}</p>:conversations.map(item=><div className={`ui-conversation-row ${item.id===activeId?'active':''}`} key={item.id}><button type="button" aria-current={item.id===activeId?'page':undefined} className="ui-conversation-link" onClick={()=>onNavigate(`/chat/${encodeURIComponent(item.id)}`)}><span>{item.pinned?<><Pin size={14} aria-hidden="true"/><span className="ui-sr">{t('chat.conversation.pinned')}: </span></>:null}<span className="ui-conversation-title">{item.title}</span></span><small>{formatDate(item.updatedAt,locale,{month:'short',day:'numeric'})}</small></button><ConversationActionMenu conversation={item} disabled={busyId!==null} t={t} onAction={onAction}/></div>)}</section>
  <div className="ui-sidebar-footer"><button type="button" className={archivedActive?'active':undefined} aria-current={archivedActive?'page':undefined} onClick={()=>onNavigate('/archived')}><Archive size={17}/><span>{t('chat.settings.archived')}</span></button>
    <button onClick={()=>onNavigate('/settings/general')}><Settings size={17}/><span>{t('chat.nav.settings')}</span></button>
    <div className="ui-drawer-only"><LanguageSwitcher/>{adminAccess&&<a className="ui-admin-link" href="/admin/users"><ShieldCheck size={17}/><span>{t('chat.nav.adminConsole')}</span></a>}</div>
    {workspace&&<div className="ui-workspace-identity"><span>{t('chat.nav.workspace')}</span><strong title={workspace.name}>{workspace.name}</strong></div>}
  </div>
 </aside>}
