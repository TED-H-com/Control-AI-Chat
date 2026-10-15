import { useEffect, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import type { Locale } from '../i18n/types.js';
import { formatDate } from '../i18n/formatters.js';
import type { ChatTranslate } from './i18n.js';
import type { Conversation } from './types.js';

export type ConversationAction = 'rename'|'pin'|'archive'|'delete';
export type ConversationDialogState = Readonly<{kind:'rename'|'delete';conversation:Conversation}>;

interface ActionMenuProps {
  conversation:Conversation;
  archived?:boolean;
  disabled?:boolean;
  t:ChatTranslate;
  onAction:(action:ConversationAction,conversation:Conversation)=>void;
}

export function ConversationActionMenu({conversation,archived=false,disabled=false,t,onAction}:ActionMenuProps) {
  const [open,setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (restoreFocus=false): void => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
    const outside = (event:PointerEvent): void => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const escape = (event:KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    return () => {
      document.removeEventListener('pointerdown',outside);
      document.removeEventListener('keydown',escape);
    };
  },[open]);

  const choose = (action:ConversationAction): void => {
    close();
    trigger.current?.focus();
    onAction(action,conversation);
  };

  const move = (event:React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : event.key === 'ArrowDown' ? (current+1)%items.length : (current-1+items.length)%items.length;
    items[next]?.focus();
  };

  return <div className="ui-conversation-actions">
    <button ref={trigger} type="button" className="ui-conversation-kebab" aria-disabled={disabled?'true':undefined} title={t('chat.conversation.menu',{title:conversation.title})} aria-label={t('chat.conversation.menu',{title:conversation.title})} aria-haspopup="menu" aria-expanded={open} onClick={() => {if(!disabled)setOpen(value => !value)}}><Ellipsis size={18} aria-hidden="true"/></button>
    {open && <div ref={menu} className="ui-conversation-menu" role="menu" aria-label={t('chat.conversation.menu',{title:conversation.title})} onKeyDown={move}>
      <button type="button" role="menuitem" onClick={() => choose('rename')}>{t('chat.conversation.rename')}</button>
      <button type="button" role="menuitem" onClick={() => choose('pin')}>{t(conversation.pinned?'chat.conversation.unpin':'chat.conversation.pin')}</button>
      {!archived && <button type="button" role="menuitem" onClick={() => choose('archive')}>{t('chat.conversation.archive')}</button>}
      <button type="button" role="menuitem" className="ui-danger-action" onClick={() => choose('delete')}>{t('chat.conversation.delete')}</button>
    </div>}
  </div>;
}

interface ConversationDialogProps {
  state:ConversationDialogState|null;
  busy:boolean;
  error:string|null;
  t:ChatTranslate;
  onClose:()=>void;
  onRename:(title:string)=>void;
  onDelete:()=>void;
}

export function ConversationDialog({state,busy,error,t,onClose,onRename,onDelete}:ConversationDialogProps) {
  const [title,setTitle] = useState(state?.conversation.title ?? '');
  const dialog = useRef<HTMLFormElement>(null);
  const previousFocus = useRef<HTMLElement|null>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => setTitle(state?.conversation.title ?? ''),[state]);
  useEffect(() => {
    if (!state) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focus = requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[data-dialog-initial]')?.focus());
    const escape = (event:KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
    };
    document.addEventListener('keydown',escape);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener('keydown',escape);
      previousFocus.current?.focus();
    };
  },[state?.conversation.id,state?.kind]);
  if (!state) return null;

  const rename = state.kind === 'rename';
  const heading = rename ? t('chat.conversation.renameTitle') : t('chat.conversation.deleteTitle');
  const keyDown = (event:React.KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
  };
  return <div className="ui-modal" role="presentation" onPointerDown={event => {if(event.target===event.currentTarget&&!busy)onClose();}}>
    <form ref={dialog} role="dialog" aria-modal="true" aria-labelledby="conversation-dialog-title" aria-busy={busy} onKeyDown={keyDown} onSubmit={event => {event.preventDefault();if(busy)return;if(rename){const next=title.trim();if(next)onRename(next);}else onDelete();}}>
      <h2 id="conversation-dialog-title">{heading}</h2>
      {rename
        ? <label>{t('chat.conversation.name')}<input data-dialog-initial required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label>
        : <p>{t('chat.conversation.deleteBody',{title:state.conversation.title})}</p>}
      {error && <p className="ui-dialog-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="ui-button ui-secondary" data-dialog-initial={!rename||undefined} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)onClose()}}>{t('common.cancel')}</button>
        <button type="submit" className={rename?'ui-button ui-primary':'ui-button ui-danger'} disabled={rename&&!title.trim()} aria-disabled={busy?'true':undefined}>{busy?t('chat.conversation.working'):rename?t('common.save'):t('chat.conversation.confirmDelete')}</button>
      </footer>
    </form>
  </div>;
}

interface ArchivedPageProps {
  conversations:readonly Conversation[];
  locale:Locale;
  busyId:string|null;
  t:ChatTranslate;
  onRestore:(conversation:Conversation)=>void;
  onAction:(action:ConversationAction,conversation:Conversation)=>void;
}

export function ArchivedConversationsPage({conversations,locale,busyId,t,onRestore,onAction}:ArchivedPageProps) {
  return <main id="chat-main" className="ui-page ui-archive-page">
    <h1>{t('chat.conversation.archivedTitle')}</h1>
    <p>{t('chat.conversation.archivedDescription')}</p>
    {conversations.length === 0
      ? <div className="ui-state"><p>{t('chat.conversation.archivedEmpty')}</p></div>
      : <ul className="ui-archive-list">{conversations.map(conversation => <li key={conversation.id}>
          <div className="ui-archive-copy"><strong>{conversation.title}</strong><small>{t('chat.conversation.updated',{date:formatDate(conversation.updatedAt,locale)})}</small></div>
          <div className="ui-archive-actions">
            <button type="button" className="ui-button ui-secondary" aria-disabled={busyId!==null?'true':undefined} onClick={() => {if(busyId===null)onRestore(conversation)}}>{t('chat.conversation.restore')}</button>
            <ConversationActionMenu conversation={conversation} archived disabled={busyId!==null} t={t} onAction={onAction} />
          </div>
        </li>)}</ul>}
  </main>;
}
