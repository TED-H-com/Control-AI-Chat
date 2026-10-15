import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Copy,FileText,Pencil,RefreshCw} from 'lucide-react';
import {formatBytes,formatCurrency,formatDate,formatNumber,formatTime} from '../i18n/formatters.js';
import type {Locale} from '../i18n/types.js';
import {providerName} from '../providerNames.js';
import type {ActiveRun,ChatFailure,ChatRunRequest,GateSummary,Message} from './types.js';
import type {ChatTranslate} from './i18n.js';
import {MarkdownContent} from './MarkdownContent.js';
import {buildLedger,entryNumber,stampFor,type Stamp} from './ledger.js';
import type {AvailableModel,Provider} from '@shared/types';
import {RunFailureNotice} from './RunFailureNotice.js';

// Zoom can leave scrollTop fractional, and a delta can land between the scroll event and this
// metrics read. A small nonzero slack keeps those readers pinned without dragging back someone
// who has intentionally scrolled away from the stream.
export const PIN_SLACK=48;
export interface ScrollMetrics {scrollTop:number;scrollHeight:number;clientHeight:number}
export function isFollowingBottom(view:ScrollMetrics):boolean{return view.scrollHeight-view.scrollTop-view.clientHeight<=PIN_SLACK;}
function SafeContent({text,t}:{text:string;t:ChatTranslate}){return <MarkdownContent text={text} t={t}/>;}

function stampText(stamp:Stamp,t:ChatTranslate):string{
  const translate=t as (key:string,args?:Readonly<Record<string,string|number|Date>>)=>string;
  if(stamp.kind==='redact')return stamp.count===null?t('chat.stamp.redactPlain'):t('chat.stamp.redact',{count:stamp.count});
  if(stamp.kind==='mask')return stamp.count===null?t('chat.stamp.maskPlain'):t('chat.stamp.mask',{count:stamp.count});
  return translate(`chat.stamp.${stamp.kind}`);
}

function CheckpointStamp({stamp,receiptId,expanded,onToggle,t,live}:{stamp:Stamp;receiptId:string;expanded:boolean;onToggle:()=>void;t:ChatTranslate;live:boolean}){
  const previous=useRef(stamp.kind),[pressed,setPressed]=useState(false);
  useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined;if(live&&previous.current==='checking'&&stamp.kind!=='checking'){setPressed(true);timer=setTimeout(()=>setPressed(false),160);}previous.current=stamp.kind;return()=>timer&&clearTimeout(timer);},[live,stamp.kind]);
  const content=<><span className="ui-sr">{t('chat.stamp.label')}{t('chat.stamp.separator')}</span>{stampText(stamp,t)}</>;
  const className=`ui-stamp ui-stamp--${stamp.ink}${stamp.kind==='checking'?' is-checking':''}${pressed?' is-pressed':''}`;
  return stamp.toggles?<button type="button" className="ui-stamp-button" data-stamp data-stamp-kind={stamp.kind} aria-expanded={expanded} aria-controls={receiptId} onClick={onToggle}><span className={className}>{content}</span></button>:<span className={className} data-stamp data-stamp-kind={stamp.kind}>{content}</span>;
}

function Receipt({id,gate,row,stamp,open,t,live,onDismiss}:{id:string;gate:GateSummary;row:'prompt'|'response';stamp:Stamp;open:boolean;t:ChatTranslate;live:boolean;onDismiss?:()=>void}){
  const translate=t as (key:string,args?:Readonly<Record<string,string|number|Date>>)=>string;
  const counted=(key:string,uncounted:string)=>gate.protectedItemCount===null?translate(uncounted):translate(key,{count:gate.protectedItemCount});
  let title:string,body:string,next:string|null=null,draftSafe:string|null=null,status:string|null=null;
  if(row==='response'&&stamp.kind==='withheld'){title=t('chat.gate.response.withheld.title');body=t('chat.gate.response.withheld.body');next=t('chat.gate.response.withheld.next');}
  else if(row==='response'&&stamp.kind==='redact'){title=t('chat.gate.response.redacted.title');body=counted('chat.gate.response.redacted.body','chat.gate.response.redacted.bodyUncounted');}
  else if(row==='response'&&stamp.kind==='mask'){title=t('chat.gate.response.masked.title');body=counted('chat.gate.response.masked.body','chat.gate.response.masked.bodyUncounted');}
  else if(stamp.kind==='redact'){title=t('chat.gate.redacted.title');body=counted('chat.gate.redacted.body','chat.gate.redacted.bodyUncounted');next=t('chat.gate.redacted.next');}
  else if(stamp.kind==='mask'){title=t('chat.gate.masked.title');body=counted('chat.gate.masked.body','chat.gate.masked.bodyUncounted');next=t('chat.gate.masked.next');}
  else if(stamp.kind==='warn'){title=t('chat.gate.warning.title');body=t('chat.gate.warning.body');}
  else if(stamp.kind==='require_approval'){title=t('chat.gate.approval.title');body=t('chat.gate.approval.policy');draftSafe=t('chat.gate.approval.draftSafe');next=t('chat.gate.approval.next');status=live?t('chat.gate.approval.status.pending'):null;}
  else{title=t('chat.gate.blocked.title');body=t('chat.gate.blocked.policy');next=t('chat.gate.blocked.next');}
  return <section id={id} className={`ui-receipt ui-receipt--${stamp.ink}`} data-receipt-kind={stamp.kind} data-receipt-row={row} hidden={!open} {...(live&&stamp.kind==='block'?{role:'alert'}:{})}><div className="ui-receipt__title"><strong>{title}</strong>{status&&<span>{status}</span>}</div><p>{body}</p>{draftSafe&&<p>{draftSafe}</p>}{next&&<p>{next}</p>}{onDismiss&&stamp.kind==='require_approval'&&<button type="button" className="ui-button ui-secondary" onClick={onDismiss}>{t('chat.gate.approval.dismiss')}</button>}</section>;
}

function GateBlock({gate,row,t,live,onDismiss}:{gate:GateSummary|null;row:'prompt'|'response';t:ChatTranslate;live:boolean;onDismiss?:()=>void}){
  const stamp=stampFor({gate,row}),[open,setOpen]=useState(stamp?.receiptOpen??false);
  useEffect(()=>setOpen(stamp?.receiptOpen??false),[stamp?.kind,stamp?.receiptOpen]);
  if(!gate||!stamp)return null;
  const id=`gate-receipt-${row}-${gate.decisionId}`;
  return <><span className="ui-stamp-slot"><CheckpointStamp stamp={stamp} receiptId={id} expanded={open} onToggle={()=>setOpen(value=>!value)} t={t} live={live}/></span><Receipt id={id} gate={gate} row={row} stamp={stamp} open={open} t={t} live={live} onDismiss={onDismiss}/></>;
}

function LivePromptGate({gate,status,t,onDismiss}:{gate:GateSummary|null;status:ActiveRun['status'];t:ChatTranslate;onDismiss?:()=>void}){
  const stamp=stampFor({gate,row:'prompt',liveStatus:status}),[open,setOpen]=useState(stamp?.receiptOpen??false);
  useEffect(()=>setOpen(stamp?.receiptOpen??false),[stamp?.kind,stamp?.receiptOpen]);
  if(!stamp)return null;
  const id=`gate-receipt-live-${gate?.decisionId??'checking'}`;
  return <div className="ui-live-gate" role="status" aria-live="polite"><span className="ui-stamp-slot"><CheckpointStamp stamp={stamp} receiptId={id} expanded={open} onToggle={()=>setOpen(value=>!value)} t={t} live/></span>{gate&&<Receipt id={id} gate={gate} row="prompt" stamp={stamp} open={open} t={t} live onDismiss={onDismiss}/>}</div>;
}

function modelIdentity(provider:Provider|null,modelId:string|null,models:readonly AvailableModel[],t:ChatTranslate):{model:string;provider:string|null}{const found=models.find(model=>model.id===modelId);return{model:found?.displayName??t('chat.message.speaker.model'),provider:providerName(provider)};}
function Attachments({message,locale,t}:{message:Message;locale:Locale;t:ChatTranslate}){return message.attachments.length?<div className="ui-message-attachments" aria-label={t('chat.message.attachments')}>{message.attachments.map(file=><div key={file.id}><FileText size={16} aria-hidden="true"/><a href={`/api/v1/files/${encodeURIComponent(file.id)}/content`} download={file.name} title={t('chat.message.downloadAttachment',{name:file.name})}>{file.name}</a><small>{formatBytes(file.sizeBytes,locale)}</small></div>)}</div>:null;}
function RowActions({message,content,t,onEdit,onRegenerate,copy}:{message:Message;content:string;t:ChatTranslate;onEdit:(message:Message)=>void;onRegenerate:(message:Message)=>void;copy:(text:string)=>void}){return <div className="ui-message-actions" aria-label={t('chat.message.actions')}><button type="button" title={t('chat.message.copyTooltip')} aria-label={t('chat.message.copy')} onClick={()=>copy(content)}><Copy size={15} aria-hidden="true"/></button>{message.role==='user'?<button type="button" title={t('chat.message.edit')} aria-label={t('chat.message.edit')} onClick={()=>onEdit(message)}><Pencil size={15} aria-hidden="true"/></button>:<button type="button" title={t('chat.message.regenerate')} aria-label={t('chat.message.regenerate')} onClick={()=>onRegenerate(message)}><RefreshCw size={15} aria-hidden="true"/></button>}</div>;}

export interface MessageListProps{conversationKey?:string;messages:readonly Message[];models?:readonly AvailableModel[];streamText?:string;streamStatus?:string;streamPhase?:ActiveRun['status'];streamModelId?:string|null;streamProvider?:Provider|null;liveGate?:GateSummary|null;liveResponseGate?:GateSummary|null;failure?:ChatFailure|null;retry?:ChatRunRequest|null;failureSupport?:ReactNode;showMetadata:boolean;locale:Locale;t:ChatTranslate;onEdit:(message:Message)=>void;onRegenerate:(message:Message)=>void;onRetry?:(request:ChatRunRequest)=>void;onDismissApproval?:()=>void;}

export function MessageList({conversationKey='',messages,models=[],streamText='',streamStatus,streamPhase,streamModelId=null,streamProvider=null,liveGate=null,liveResponseGate=null,failure=null,retry=null,failureSupport,showMetadata,locale,t,onEdit,onRegenerate,onRetry=()=>{},onDismissApproval}:MessageListProps){
  const view=useRef<HTMLElement>(null),[pinned,setPinned]=useState(true),previousConversation=useRef(conversationKey),[announcement,setAnnouncement]=useState({text:'',seq:0});
  // Follow new streamed content only while the reader is already at the bottom; otherwise their
  // current reading position wins until they explicitly jump back to the latest response.
  useLayoutEffect(()=>{const element=view.current;if(!element)return;if(previousConversation.current!==conversationKey){previousConversation.current=conversationKey;setPinned(true);element.scrollTop=element.scrollHeight;return}if(pinned)element.scrollTop=element.scrollHeight;},[conversationKey,pinned,messages.length,streamText,streamStatus,streamPhase,liveGate?.decisionId,liveResponseGate?.decisionId,failure]);
  // Clipboard access can be denied or unavailable even when the API exists, so surface a useful
  // announcement instead of leaving a rejected promise behind.
  const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setAnnouncement(old=>({text:t('chat.message.copied'),seq:old.seq+1}));}catch{setAnnouncement(old=>({text:t('chat.message.copyFailed'),seq:old.seq+1}));}};
  const entries=buildLedger(messages),live=streamPhase!==undefined&&streamPhase!=='idle',lastEntry=entries.length-1;
  return <main id="chat-main" ref={view} onScroll={()=>{const element=view.current;if(element)setPinned(isFollowingBottom(element));}} className="ui-timeline" aria-label={t('chat.message.timeline')}>
    {entries.map((entry,index)=>{const number=entryNumber(entry.number),shortTime=formatTime(entry.startedAt,locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),fullTime=formatDate(entry.startedAt,locale,{dateStyle:'medium',timeStyle:'short'}),isLive=live&&index===lastEntry,outboundBlock=failure?.kind==='run'&&failure.error.code==='GATE_BLOCKED'&&failure.partialMessageId===null,liveResponse=Boolean(isLive&&!outboundBlock&&(streamText||streamStatus||streamPhase==='streaming'||streamPhase==='stopping'||liveResponseGate||failure));return <div className="ui-ledger-block" key={entry.prompt?.id??entry.responses[0]!.id}>
      {entry.dateRule&&<div className="ui-date-rule"><time dateTime={entry.startedAt}>{formatDate(entry.startedAt,locale,{dateStyle:'medium'})}</time><span/></div>}
      <article className="ui-entry" aria-label={t('chat.message.entryLabel',{number,time:fullTime})}><div className="ui-entry-gutter" aria-hidden="true"><span>{number}</span><time dateTime={entry.startedAt} title={fullTime}>{shortTime}</time></div><div className="ui-entry-content"><div className="ui-entry-meta" aria-hidden="true"><span>{number}</span><time dateTime={entry.startedAt} title={fullTime}>{shortTime}</time></div>
        {entry.prompt&&(()=>{const message=entry.prompt,gate=isLive?(liveGate??message.gate):message.gate,livePromptStatus=isLive&&streamPhase==='error'&&liveResponseGate?'streaming':streamPhase,stamp=stampFor({gate,row:'prompt',liveStatus:isLive?livePromptStatus:undefined}),blocked=stamp?.kind==='block';return <section className="ui-message-row ui-prompt-row"><header><strong>{t('chat.message.speaker.user')}</strong>{isLive?<LivePromptGate gate={gate} status={livePromptStatus!} t={t} onDismiss={onDismissApproval}/>:<GateBlock gate={gate} row="prompt" t={t} live={false}/>}</header>{!blocked&&<><div className="ui-message-content"><SafeContent text={message.content} t={t}/></div><Attachments message={message} locale={locale} t={t}/><RowActions message={message} content={message.content} t={t} onEdit={onEdit} onRegenerate={onRegenerate} copy={text=>void copy(text)}/></>}</section>;})()}
        {entry.responses.map(message=>{const stamp=stampFor({gate:message.gate,row:'response'}),withheld=stamp?.kind==='withheld',identity=modelIdentity(message.provider,message.modelId,models,t),input=message.inputTokens===null?'—':formatNumber(message.inputTokens,locale),output=message.outputTokens===null?'—':formatNumber(message.outputTokens,locale),cost=message.costUsd===null?'—':formatCurrency(message.costUsd,'USD',locale,{minimumFractionDigits:message.costUsd<1?4:2,maximumFractionDigits:message.costUsd<1?4:2}),verdict=message.gate?.action??'allow';return <section key={message.id} className="ui-message-row ui-response-row"><header><strong>{identity.model}</strong>{identity.provider&&<span>{identity.provider}</span>}<GateBlock gate={message.gate} row="response" t={t} live={false}/></header>{!withheld&&<><div className="ui-message-content"><SafeContent text={message.content} t={t}/></div><Attachments message={message} locale={locale} t={t}/>{showMetadata&&<div className="ui-metadata">{t('chat.metadata.summary',{model:identity.model,input,output,cost,verdict:t(`chat.metadata.verdict.${verdict}`)})}</div>}<RowActions message={message} content={message.content} t={t} onEdit={onEdit} onRegenerate={onRegenerate} copy={text=>void copy(text)}/></>}</section>;})}
        {liveResponse&&(()=>{const failedBlock=failure?.kind==='run'&&failure.error.code==='GATE_BLOCKED',stamp=stampFor({gate:liveResponseGate,row:'response'}),withheld=failedBlock||stamp?.kind==='withheld',identity=modelIdentity(streamProvider,streamModelId,models,t);return <section className="ui-message-row ui-response-row" aria-busy={streamPhase==='streaming'||streamPhase==='stopping'}><header><strong>{identity.model}</strong>{identity.provider&&<span>{identity.provider}</span>}{liveResponseGate&&!failedBlock&&<div className="ui-live-gate" role="status" aria-live="polite"><GateBlock gate={liveResponseGate} row="response" t={t} live/></div>}</header>{!withheld&&streamText&&<div className="ui-message-content"><SafeContent text={streamText} t={t}/></div>}{!failure&&!withheld&&streamStatus&&<span className="ui-stream-status" role="status">{streamStatus}</span>}{failure&&<RunFailureNotice failure={failure} retry={retry} support={failureSupport} onRetry={onRetry} t={t}/>}</section>;})()}
      </div></article>
    </div>;})}
    {!pinned&&<div className="ui-jump"><button type="button" className="ui-button ui-secondary" onClick={()=>setPinned(true)}>{t('chat.message.jumpToLatest')} <span aria-hidden="true">↓</span></button></div>}{/* aria-live announces changes, so re-key repeated copy results into fresh nodes. */}<span className="ui-sr" aria-live="polite"><span key={announcement.seq}>{announcement.text}</span></span>
  </main>;
}
