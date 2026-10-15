import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const executablePath=process.env.CHROMIUM_PATH;
if(!executablePath){
  console.error('CHROMIUM_PATH is required (for example: CHROMIUM_PATH=/path/to/chromium npm run visual:audit).');
  process.exit(2);
}

const base=process.env.BASE??'http://127.0.0.1:4177';
const out=process.env.OUT??fileURLToPath(new URL('../visual-audit-output/',import.meta.url));
const liveGateOnly=process.env.LIVE_GATE_ONLY==='1';
const phraseOnly=process.env.PHRASE_ONLY==='1';
const focusOnly=process.env.FOCUS_ONLY==='1';
const chatVisibilityLoops=Number.parseInt(process.env.CHAT_VISIBILITY_LOOPS??'0',10);
const chatTransitionLoops=Number.parseInt(process.env.CHAT_TRANSITION_LOOPS??'0',10);
mkdirSync(out,{recursive:true});

const locales=['en','zh-TW','ja'];
const sendLabels={en:'Send','zh-TW':'送出',ja:'送信'};
const adminNames={
  en:{overview:'Overview',policies:'Policies','custom-terms':'Protected terms',compliance:'Rule map',detectors:'Detectors',violations:'Violations',audit:'Audit log',analytics:'Usage',assets:'Projects and skills',users:'Users',groups:'Groups',roles:'Roles',models:'Models',assistants:'Assistants',providers:'Providers',budgets:'Budgets',retention:'Retention',settings:'Workspace settings'},
  'zh-TW':{overview:'總覽',policies:'政策','custom-terms':'受保護詞彙',compliance:'規則對照',detectors:'偵測器',violations:'違規事件',audit:'稽核紀錄',analytics:'使用情況',assets:'專案與技能',users:'使用者',groups:'群組',roles:'角色',models:'模型',assistants:'助理',providers:'供應商',budgets:'預算',retention:'保留政策',settings:'工作空間設定'},
  ja:{overview:'概要',policies:'ポリシー','custom-terms':'保護対象語',compliance:'ルール対応表',detectors:'検出器',violations:'違反管理',audit:'監査ログ',analytics:'利用状況',assets:'プロジェクトとスキル',users:'ユーザー',groups:'グループ',roles:'ロール',models:'モデル',assistants:'アシスタント',providers:'プロバイダー',budgets:'予算',retention:'保持ポリシー',settings:'ワークスペース設定'},
};
const adminGroups={en:['Protection','Review','Records','Organization','AI services','Settings'],'zh-TW':['防護','審查','紀錄','組織','AI 服務','設定'],ja:['保護','レビュー','記録','組織','AI サービス','設定']};
const auditLabels={
  en:[['Policy gate','Approved content released'],['Identity','Password reset requested'],['Chat','Conversation created'],['Billing','Denied by request rate limit'],['Administration','Role changed'],['System','Retention data purged']],
  'zh-TW':[['政策閘道','已放行核准內容'],['身分識別','已要求重設密碼'],['聊天','已建立對話'],['帳務','已因要求頻率上限拒絕'],['管理','已變更角色'],['系統','已依保留政策清除資料']],
  ja:[['ポリシーゲート','承認済みコンテンツを送信'],['認証','パスワードリセットを申請'],['チャット','会話を作成'],['請求','リクエスト上限により拒否'],['管理','ロールを変更'],['システム','保持期間に基づきデータを消去']],
};
const refusalText={
  en:{load:'You do not have permission for this action. Ask a workspace owner for access.',invite:'A user with this email already exists. Open that user instead.',budget:'A budget that applies to you cannot cover this request. Contact your administrator.',roles:['Owner','Compliance reviewer','Member']},
  'zh-TW':{load:'您沒有執行此操作的權限。請向工作空間擁有者申請權限。',invite:'已有使用者使用這個電子郵件。請改為開啟該使用者。',budget:'適用於您的預算不足以完成這項要求。請聯絡管理員。',roles:['擁有者','法遵審核者','成員']},
  ja:{load:'この操作に必要な権限がありません。ワークスペースの所有者にアクセス権を依頼してください。',invite:'このメールアドレスのユーザーはすでに存在します。そのユーザーを開いてください。',budget:'このアカウントに適用される予算では、このリクエストを処理できません。管理者にお問い合わせください。',roles:['所有者','コンプライアンス審査担当','メンバー']},
};
const modes=['light','dark'];
const viewports=[
  {name:'390x844',width:390,height:844},
  {name:'768x1024',width:768,height:1024},
  {name:'1440x900',width:1440,height:900},
];
const now='2026-09-28T12:00:00.000Z';
const modelFor=(provider,index)=>({id:`model-${provider}`,provider,providerModelId:`${provider}-fixture`,displayName:`Governed model ${index+1}`,transport:'api',systemPromptEligible:true,capabilities:['text','reasoning'],enabled:true,inputUsdPerMillion:1,outputUsdPerMillion:2,contextTokens:128000,maxOutputTokens:8192,version:1,isDefault:index===0,recommendedForProvider:true,groupRestriction:null});
const models=['openai','anthropic','google','xai'].map(modelFor),model=models[0];
const nextDay='2026-09-29T12:00:00.000Z';
const conversation={id:'conv-1',projectId:null,title:'Quarterly vendor review and ownership plan',status:'active',pinned:true,tone:'default',role:'default',assistantId:null,createdAt:now,updatedAt:nextDay,deletedAt:null,messageCount:10,version:2};
const archivedConversation={...conversation,id:'conv-archived',title:'Archived control review',status:'archived',pinned:false,messageCount:0};
let gateSequence=0;
const gate=(action,protectedItemCount=0,userNotice='SERVER-TEXT-SENTINEL',direction='outbound')=>({decisionId:`gate-${++gateSequence}`,action,direction,detectorCount:action==='allow'?0:1,protectedItemCount,approvalId:action==='require_approval'?'approval-1':null,userNotice});
const messages=[
  {id:'u1',conversationId:'conv-1',parentMessageId:null,role:'user',content:'Compare the renewal risks and give me a concise action plan.',modelId:null,provider:null,createdAt:now,inputTokens:null,outputTokens:null,costUsd:null,gate:gate('allow'),attachments:[],version:1},
  {id:'a1',conversationId:'conv-1',parentMessageId:'u1',role:'assistant',content:'The highest-risk items are data retention and the termination window.\n\n```ts\nconst owner = "Legal";\n```',modelId:model.id,provider:'openai',createdAt:'2026-09-28T12:01:00.000Z',inputTokens:40,outputTokens:64,costUsd:0.0032,gate:null,attachments:[],version:1},
  {id:'u2',conversationId:'conv-1',parentMessageId:null,role:'user',content:'Contact the three account owners at [EMAIL_1], [EMAIL_2], and [EMAIL_3].',modelId:null,provider:null,createdAt:'2026-09-28T12:02:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:gate('redact',3),attachments:[],version:1},
  {id:'a2',conversationId:'conv-1',parentMessageId:'u2',role:'assistant',content:'I can prepare a neutral outreach draft.',modelId:model.id,provider:'openai',createdAt:'2026-09-28T12:03:00.000Z',inputTokens:18,outputTokens:28,costUsd:0.0014,gate:null,attachments:[],version:1},
  {id:'u3',conversationId:'conv-1',parentMessageId:null,role:'user',content:'',modelId:null,provider:null,createdAt:'2026-09-28T12:04:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:gate('block'),attachments:[],version:1},
  {id:'u4',conversationId:'conv-1',parentMessageId:null,role:'user',content:'Review the acquisition materials.',modelId:null,provider:null,createdAt:'2026-09-28T12:05:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:gate('require_approval'),attachments:[],version:1},
  {id:'u5',conversationId:'conv-1',parentMessageId:null,role:'user',content:'Summarize the restricted response.',modelId:null,provider:null,createdAt:nextDay,inputTokens:null,outputTokens:null,costUsd:null,gate:gate('allow'),attachments:[],version:1},
  {id:'a5',conversationId:'conv-1',parentMessageId:'u5',role:'assistant',content:'',modelId:model.id,provider:'openai',createdAt:'2026-09-29T12:01:00.000Z',inputTokens:12,outputTokens:0,costUsd:0.0004,gate:gate('warn',0,'SERVER-TEXT-SENTINEL','inbound'),attachments:[],version:1},
  {id:'u6',conversationId:'conv-1',parentMessageId:null,role:'user',content:'Check this vendor evidence and explain the remaining risk.',modelId:null,provider:null,createdAt:'2026-09-29T12:02:00.000Z',inputTokens:null,outputTokens:null,costUsd:null,gate:gate('warn'),attachments:[],version:1},
  {id:'a6',conversationId:'conv-1',parentMessageId:'u6',role:'assistant',content:'Two sensitive values were replaced. The remaining evidence supports a medium residual risk.',modelId:model.id,provider:'openai',createdAt:'2026-09-29T12:03:00.000Z',inputTokens:26,outputTokens:42,costUsd:0.0021,gate:gate('redact',2,'SERVER-TEXT-SENTINEL','inbound'),attachments:[{id:'file-1',name:'vendor-evidence.pdf',mimeType:'application/pdf',sizeBytes:1536,createdAt:'2026-09-29T11:59:00.000Z'}],version:1},
];
const pageOf=data=>({data,hasMore:false,nextCursor:null});
const ownerPermissions=['audit:read','audit:export','admin:users','admin:groups','admin:settings','model:read','model:write','assistant:read','assistant:write','policy:read','policy:write','approval:read','approval:decide','budget:read','budget:write','project:read','skill:read','legal_hold:manage'];
const capabilities={tenantId:'tenant-1',userId:'user-1',tenantName:'Northstar Systems',tenantSlug:'northstar',roleIds:['owner'],assignableRoles:['admin','compliance','member'],permissions:ownerPermissions,tenantTimezone:'Asia/Taipei',tenantCurrency:'USD',contentAccessReasonRequired:false,tenant:{id:'tenant-1',name:'Northstar Systems',slug:'northstar',status:'active'}};
const adminCapabilities={...capabilities,userId:'admin-user',roleIds:['admin'],assignableRoles:['admin','member']};
const ownerActions={changeStatus:true,changeRole:true,deprovision:true,signOut:true,credentialLink:'reset'};
const withheldActions={changeStatus:false,changeRole:false,deprovision:false,signOut:false,credentialLink:null};
let adminPersona='owner';
const me={user:{id:'user-1',email:'admin@example.test',displayName:'Admin User',avatarUrl:null},tenant:{id:'tenant-1',name:'Northstar Systems',slug:'northstar'},membership:{id:'member-1',roles:[],groups:[],permissions:capabilities.permissions},preferences:{density:'comfortable',colorMode:'light',locale:'en'},mfa:{enabled:false},sessionId:'session-1'};
const summary={requests:2841,activeUsers:38,tokens:{total:1842000},spendMicroUsd:18240000,blockedRequests:17,pendingApprovals:3,budgetUsedMicroUsd:18240000,budgetLimitMicroUsd:50000000,providerErrorRate:0.006,dataFreshThrough:now};
const adminRecord={id:'record-1',version:3,name:'Northstar control',displayName:'Northstar control',email:'owner@example.test',description:'A realistic checkpoint-ledger record.',status:'active',state:'active',severity:'high',roles:['Owner'],groups:['Operations'],mfaEnabled:true,lastActiveAt:now,source:'workspace',memberCount:12,enabledModels:4,policies:3,budgetUtilization:.42,updatedAt:now,type:'system',permissionCount:17,assignedUsers:8,lastChangedBy:'Admin User',permission:'policy:write',provider:'openai',enabled:true,capabilities:['text','reasoning'],contextWindowTokens:128000,maxOutputTokens:4096,inputPriceMicroUsdPerMillion:2500000,outputPriceMicroUsdPerMillion:10000000,enabledGroupCount:3,requests30d:2841,spend30d:18240000,isTenantDefault:true,credentialSource:'byok',lastRotatedAt:now,lastTestAt:now,p95LatencyMs:842,errorRate:.006,enabledGroups:['Operations'],configured:true,unhealthy:false,scopes:['Workspace'],ruleCount:4,publishedVersion:3,matches30d:91,blocks30d:17,updatedBy:'Admin User',scopeType:'tenant',detector:'secret',action:'block',author:'Admin User',changed:now,detectorKind:'secret',builtin:true,activeVersion:2,threshold:.9,policiesUsing:3,matches7d:23,overrideRate:.04,confirmedRate:.96,occurredAt:now,user:'Alex Morgan',rule:'Credentials protection',direction:'outbound',redactedExcerpt:'API key [REDACTED]',assignee:'Morgan Lee',assigneeId:'user-2',dueAt:nextDay,approvalOnly:true,category:'gate',actor:'Admin User',subject:'Vendor review',verdict:'block',requestId:'request-1',chainStatus:'active',ip:'192.0.2.10',scope:'tenant',scopeName:'Northstar Systems',period:'monthly',metric:'usd',tokenLimit:2000000,usdLimit:50000000,softLimit:40000000,hardLimit:50000000,currentUsage:18240000,utilization:.3648,forecast:31000000,resetAt:nextDay,capType:'hard',active:true,overSoft:false,overHard:false,dimension:'Governed model',requests:2841,activeUsers:38,inputTokens:1200000,outputTokens:642000,spendMicroUsd:18240000,averageLatencyMs:521,errors:17,violations:29,violationRate:.0102,owner:'Admin User',members:12,conversations:48,files:22,bytes:15728640,lastActivityAt:now,sharing:'workspace',fileType:'pdf',inactiveRange:'30d',dataClass:'conversations',retentionDays:90,minimumDays:30,maximumDays:365,legalHolds:1,nextPurgeAt:nextDay,estimatedRows:4200,estimatedBytes:8388608,editable:true,model:'Governed model 1',modelCatalogId:model.id,systemPrompt:'Use approved sources.',project:'Quarterly review'};
const legalHolds=[
  {id:'hold-active',scopeType:'user',scopeId:'user-2',scopeLabel:'Morgan Lee',startsAt:null,endsAt:null,reason:'Pending employment matter',placedBy:'Admin User',placedAt:now,releasedBy:null,releasedAt:null,releaseReason:null,status:'active'},
  {id:'hold-range',scopeType:'date_range',scopeId:null,scopeLabel:null,startsAt:'2026-01-31T16:00:00.000Z',endsAt:'2026-02-28T16:00:00.000Z',reason:'Q1 supplier dispute',placedBy:'Admin User',placedAt:now,releasedBy:null,releasedAt:null,releaseReason:null,status:'active'},
  {id:'hold-released',scopeType:'project',scopeId:'project-1',scopeLabel:'Quarterly review',startsAt:null,endsAt:null,reason:'Completed investigation',placedBy:'Admin User',placedAt:'2026-09-20T12:00:00.000Z',releasedBy:'Admin User',releasedAt:now,releaseReason:'Matter closed',status:'released'},
];
const laterLegalHold={id:'hold-page-2',scopeType:'user',scopeId:'user-3',scopeLabel:'Jordan Park',startsAt:null,endsAt:null,reason:'Records request',placedBy:'Admin User',placedAt:now,releasedBy:null,releasedAt:null,releaseReason:null,status:'active'};
const gateRule={id:'rule-1',policy_id:'policy-1',policy_name:'Sensitive data policy',detector_id:'detector-1',detector_key:'secret',detector_kind:'secret',scope_type:'tenant',scope_id:null,direction:'outbound',action:'block',severity:'high',config_json:'{}',enabled:1,priority:100,updated_at:Date.parse(now)};
const gateRules=[gateRule,{...gateRule,id:'rule-2',detector_id:'detector-2',detector_key:'custom-terms',detector_kind:'keyword',priority:90},{...gateRule,id:'rule-3',detector_id:'detector-3',detector_key:'acme-codenames',detector_kind:'keyword',priority:80}];
const detector={id:'detector-1',name:'secret',detectorKind:'secret',config:{},enabled:true,builtin:true};
const policy={id:'policy-1',name:'Sensitive data policy',description:'Protect credentials and regulated data.',enabled:1,priority:100};
const violation={...adminRecord,id:'violation-1',status:'open',version:4,approvalId:'approval-1',approvalVersion:2,approvalStatus:'pending',approvalExpiresAt:'2027-09-29T12:00:00.000Z',releaseAvailable:true,releaseStatus:'pending_review',releaseErrorCode:null,releaseMessageId:null,releaseAttempts:0,allowedTransitions:['triaged','in_review','resolved','dismissed'],comments:[],resolutionReason:null,resolvedBy:null,resolvedById:null,resolvedAt:null};
const auditEvent={...adminRecord,id:'audit-1',category:'gate',action:'gate.approval_released',verdict:'block',actorType:'user',detail:{policiesApplied:[{ruleId:'rule-1',ruleName:'Credentials protection',detector:'secret',action:'block'}],matchCount:1,ruleCount:1,cleansedPrompt:{text:'Send [REDACTED] to the approved model.',transformed:true}}};
const auditEvents=[auditEvent,
  {...adminRecord,id:'audit-2',category:'identity',action:'identity.password_reset_requested',subject:'Morgan Lee',actorType:'user'},
  {...adminRecord,id:'audit-3',category:'chat',action:'chat.conversation_created',subject:'Quarterly review',actorType:'user'},
  {...adminRecord,id:'audit-4',category:'billing',action:'billing.rate_limit_denied',subject:'Workspace member',actorType:'service'},
  {...adminRecord,id:'audit-5',category:'admin',action:'admin.role_changed',subject:'Compliance Reviewer',actorType:'user'},
  {...adminRecord,id:'audit-6',category:'system',action:'system.retention_purged',subject:'Northstar Systems',actorType:'service'},
];
const report={base,out,startedAt:new Date().toISOString(),shots:[],failures:[]};
let preference={locale:'en',colorMode:'light',density:'comfortable',defaultModelId:model.id};
let shotErrors={console:[],page:[],request:[],api:[]};
const supportRequests=[];
const meRequests=[];
let requireMfaOnLogin=false;
let holdChatRun=false;
let refuseNextChatBudget=false;
let failNextUsersLoad=false;
let refuseNextInvitation=false;
let failNextHoldPage=false;
let failNextHoldFirstPage=false;
let holdNextHoldPage=false;
let holdPage2GetCount=0;
let heldHoldPageStarted=Promise.resolve();
let markHeldHoldPageStarted=()=>{};
let releaseHeldHoldPage=()=>{};
let holdNextHoldFirstPage=false;
let heldHoldFirstPageStarted=Promise.resolve();
let markHeldHoldFirstPageStarted=()=>{};
let releaseHeldHoldFirstPage=()=>{};
const legalHoldPosts=[];
const legalHoldReleasePosts=[];
let retentionGetCount=0;

const browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light'});
const page=await context.newPage();
page.on('console',message=>{if(message.type()==='error')shotErrors.console.push(message.text())});
page.on('pageerror',error=>shotErrors.page.push(String(error)));
page.on('requestfailed',request=>{const reason=request.failure()?.errorText??'unknown';if(!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason))shotErrors.request.push({url:request.url(),reason})});
page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(pathname==='/api/v1/deployment/support')supportRequests.push({url:request.url(),method:request.method()});if(pathname.startsWith('/api/v1/me/'))meRequests.push({url:request.url(),method:request.method()})});

const routeApi=async route=>{
  const request=route.request();
  const url=new URL(request.url());
  const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'&&refuseNextChatBudget){refuseNextChatBudget=false;return respond({error:{code:'BUDGET_HARD_LIMIT',message:'SERVER-TEXT-SENTINEL',requestId:'visual-audit',retryable:false}},422)}
  if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'&&holdChatRun)return new Promise(()=>{});
  if(url.pathname==='/api/v1/me/preferences'){
    if(request.method()==='PATCH')preference={...preference,...request.postDataJSON()};
    return respond(preference);
  }
  if(url.pathname==='/api/v1/deployment')return respond({brandName:'Control AI Chat',brandIconUrl:null,canEmail:true});
  if(url.pathname==='/api/v1/deployment/support')return respond({support:{vendorName:'Visual Support',email:'help@example.test',phone:null,url:'https://support.example.test',notes:'Workspace assistance'}});
  if(url.pathname==='/api/v1/auth/me')return respond({...me,preferences:{density:preference.density,colorMode:preference.colorMode,locale:preference.locale}});
  if(url.pathname==='/api/v1/models')return respond(models);
  if(url.pathname==='/api/v1/assistants')return respond([]);
  if(url.pathname==='/api/v1/conversations')return respond(pageOf(url.searchParams.get('status')==='archived'?[archivedConversation]:[conversation]));
  if(url.pathname==='/api/v1/conversations/conv-1'&&request.method()==='GET')return respond({conversation,messages});
  if(url.pathname==='/api/v1/conversations/conv-1'&&request.method()==='PATCH')return respond({...conversation,...request.postDataJSON(),version:conversation.version+1});
  if(url.pathname==='/api/v1/projects'&&request.method()==='POST')return respond({id:'project-upload',name:'Chat attachments',instructions:'',fileCount:0,conversationCount:0,createdAt:now,updatedAt:now,version:1});
  if(url.pathname==='/api/v1/files'&&request.method()==='POST'){
    const body=request.postDataBuffer()?.toString('utf8')??'';
    const name=body.match(/filename="([^"]+)"/)?.[1]??'unknown-upload';
    const rejected=name==='restricted-evidence.pdf';
    return respond({id:rejected?'file-rejected':'file-ready',projectId:'project-upload',name,mimeType:'application/pdf',sizeBytes:rejected?3072:2048,status:rejected?'rejected':'ready',sha256:'a'.repeat(64),createdAt:now,extractedChars:rejected?null:40,gate:null,failureCode:null,version:1});
  }
  if(url.pathname==='/api/v1/projects'||url.pathname==='/api/v1/skills')return respond(pageOf([]));
  if(url.pathname==='/api/v1/admin/me/capabilities')return respond(adminPersona==='admin'?adminCapabilities:capabilities);
  if(url.pathname==='/api/v1/admin/dashboard')return respond(summary);
  if(url.pathname==='/api/v1/admin/nudges')return respond({items:[{key:'approvals-pending',ruleId:'approvalsPending',category:'governance',priority:'high',count:3}]});
  if(url.pathname==='/api/v1/admin/analytics/timeseries')return respond({items:[{label:'Sep 27',bucketStartMs:1790438400000,value:120},{label:'Sep 28',bucketStartMs:1790524800000,value:164}],granularity:'day'});
  if(url.pathname==='/api/v1/admin/analytics/breakdown')return respond(url.searchParams.has('limit')?{items:[{label:'Governed model',value:18240000}]}:{items:[adminRecord],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/analytics/detectors')return respond({items:[{label:'secret',value:17}]});
  if(url.pathname==='/api/v1/admin/custom-terms')return respond({terms:[{term:'confidential roadmap',action:'block'},{term:'acquisition target',action:'warn'}],counts:{flag:0,warn:1,redact:0,block:1}});
  if(url.pathname==='/api/v1/admin/compliance')return respond({scopes:{groups:[{id:'group-1',name:'Operations'}],models:[{id:model.id,name:model.displayName}]},scope:{type:url.searchParams.get('scopeType')??'tenant',id:url.searchParams.get('scopeId'),label:'Northstar Systems'},direction:url.searchParams.get('direction')??'outbound',detectors:[{detectorId:'detector-1',key:'secret',name:'Secret credentials',kind:'secret',builtin:true,detectorEnabled:true,effectiveAction:'block',covered:true,contributingRuleCount:3},{detectorId:'detector-2',key:'pii',name:'Personal information',kind:'pii',builtin:true,detectorEnabled:true,effectiveAction:'redact',covered:true,contributingRuleCount:2}],summary:{block:1,warn:0,mask:0,redact:1,flag:0,allow:0,notCovered:0,requireApproval:0}});
  if(url.pathname==='/api/v1/gate/rules/rule-1')return respond(gateRule);
  if(url.pathname==='/api/v1/gate/rules')return respond({items:gateRules,nextCursor:null,total:gateRules.length});
  if(url.pathname==='/api/v1/gate/policies')return respond({items:[policy],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/violations/assignees')return respond({items:[{id:'user-2',name:'Morgan Lee',email:'morgan@example.test'}]});
  if(url.pathname==='/api/v1/admin/violations/violation-1')return respond({item:violation});
  if(url.pathname==='/api/v1/admin/violations')return respond({items:[violation],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/audit/events/audit-1')return respond(auditEvent);
  if(url.pathname==='/api/v1/audit/events')return respond({items:auditEvents,nextCursor:null,total:auditEvents.length});
  if(url.pathname==='/api/v1/admin/settings')return respond({name:'Northstar Systems',status:'active',default_locale:'en',timezone:'Asia/Taipei',conversation_retention_days:90,retain_full_transcripts:false,requests_per_minute:120,concurrent_streams:8,accepted_upload_mime_types:['text/plain','text/csv','text/markdown','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'],max_upload_bytes:26214400,updated_at:now});
  if(url.pathname==='/api/v1/admin/detectors')return respond({items:[{...adminRecord,...detector}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/models')return respond({items:[{...adminRecord,id:model.id,displayName:model.displayName,provider:model.provider}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/assistants')return respond({items:[{...adminRecord,id:'assistant-1',name:'Policy analyst',description:'Reviews policy evidence.',model:model.displayName,modelCatalogId:model.id}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/providers')return respond({items:[{...adminRecord,id:'openai',provider:'openai'}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/users'&&request.method()==='POST'){
    if(refuseNextInvitation){refuseNextInvitation=false;return respond({error:{code:'CONFLICT',message:'SERVER-TEXT-SENTINEL',requestId:'visual-audit',retryable:false,details:{reason:'email_taken'}}},409)}
    return respond({item:{...adminRecord,id:'user-invited',displayName:'Visual Invite',email:'visual-invite@example.test',status:'invited',roles:['member'],actions:{...ownerActions,credentialLink:'setup'}},auditEventId:'audit-invite',setup:{purpose:'setup',url:'https://control.example/setup#visual-audit-secret',expiresAt:'2026-09-29T12:00:00.000Z',emailSent:true,emailFailure:null}},201);
  }
  if(url.pathname==='/api/v1/admin/users'){
    if(failNextUsersLoad){failNextUsersLoad=false;return respond({error:{code:'FORBIDDEN',message:'SERVER-TEXT-SENTINEL',requestId:'visual-audit',retryable:false,details:{reason:'missing_permission'}}},403)}
    return respond(adminPersona==='admin'?{items:[{...adminRecord,id:'user-1',displayName:'Workspace Owner',email:'owner@example.test',roles:['owner'],actions:withheldActions},{...adminRecord,id:'reviewer-1',displayName:'Compliance Reviewer',email:'reviewer@example.test',roles:['compliance'],actions:withheldActions},{...adminRecord,id:'member-1',displayName:'Workspace Member',email:'member@example.test',roles:['member'],actions:ownerActions}],nextCursor:null,total:3}:{items:[{...adminRecord,id:'user-2',displayName:'Morgan Lee',email:'morgan@example.test',roles:['member'],actions:ownerActions}],nextCursor:null,total:1});
  }
  if(url.pathname==='/api/v1/admin/users/user-2/credential-link'&&request.method()==='POST')return respond({credentialLink:{purpose:'reset',url:'https://control.example/reset-password#visual-audit-secret',expiresAt:'2026-09-29T12:00:00.000Z',emailSent:true,emailFailure:null},auditEventId:'audit-link'});
  if(url.pathname==='/api/v1/auth/password/forgot'&&request.method()==='POST')return respond({accepted:true},202);
  if(url.pathname==='/api/v1/auth/password/reset'&&request.method()==='POST')return request.postDataJSON().token==='dead-token'?respond({error:{code:'CREDENTIAL_LINK_INVALID',message:'This link is expired or has already been used',requestId:'visual-request',retryable:false}},422):respond({changed:true,purpose:'reset'});
  if(url.pathname==='/api/v1/admin/groups')return respond({items:[{...adminRecord,id:'group-1',name:'Operations'}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/roles')return respond({items:[{...adminRecord,id:'role-1',name:'Compliance reviewer'}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/projects')return respond({items:[{...adminRecord,id:'project-1',name:'Quarterly review'}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/admin/retention'){if(request.method()==='GET')retentionGetCount+=1;return respond({items:[{...adminRecord,id:'retention-1'}],nextCursor:null,total:1})}
  if(url.pathname==='/api/v1/admin/legal-holds'&&request.method()==='POST'){
    const body=request.postDataJSON();legalHoldPosts.push(body);return respond({item:{id:'hold-created',...body},id:'hold-created'},201);
  }
  const releaseMatch=url.pathname.match(/^\/api\/v1\/admin\/legal-holds\/([^/]+)\/release$/u);
  if(releaseMatch&&request.method()==='POST'){
    const id=decodeURIComponent(releaseMatch[1]),body=request.postDataJSON(),hold=legalHolds.find(item=>item.id===id);
    legalHoldReleasePosts.push({id,body});
    if(hold)Object.assign(hold,{status:'released',releasedBy:'Admin User',releasedAt:now,releaseReason:body.reason});
    return respond({item:hold??{id,...body,status:'released'}});
  }
  if(url.pathname==='/api/v1/admin/legal-holds'){
    const status=url.searchParams.get('status')??'active',cursor=url.searchParams.get('cursor');
    if(cursor==='page-2'){
      holdPage2GetCount+=1;
      if(failNextHoldPage){failNextHoldPage=false;return respond({error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'visual-audit',retryable:true}},500)}
      if(holdNextHoldPage){holdNextHoldPage=false;markHeldHoldPageStarted();await new Promise(resolve=>{releaseHeldHoldPage=resolve})}
      return respond({items:status==='released'?[]:[laterLegalHold],nextCursor:null});
    }
    if(failNextHoldFirstPage){failNextHoldFirstPage=false;return respond({error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'visual-audit',retryable:true}},500)}
    if(holdNextHoldFirstPage){holdNextHoldFirstPage=false;markHeldHoldFirstPageStarted();await new Promise(resolve=>{releaseHeldHoldFirstPage=resolve})}
    const items=status==='all'?legalHolds:legalHolds.filter(hold=>hold.status===status);
    return respond({items,nextCursor:status==='released'?null:'page-2'});
  }
  if(url.pathname==='/api/v1/admin/legal-hold-users')return respond({items:[{id:'user-2',displayName:'Morgan Lee',email:'morgan@example.test',status:'active'}],nextCursor:null});
  if(url.pathname==='/api/v1/budgets')return respond({items:[{...adminRecord,id:'budget-1'}],nextCursor:null,total:1});
  if(url.pathname==='/api/v1/projects/project-1'&&request.method()==='GET')return respond({id:'project-1',name:'Quarterly review',instructions:'Use approved sources.',fileCount:0,conversationCount:0,createdAt:now,updatedAt:now,version:1});
  if((url.pathname==='/api/v1/projects/project-1/files'||url.pathname==='/api/v1/projects/project-1/conversations')&&request.method()==='GET')return respond(pageOf([]));
  if(url.pathname==='/api/v1/auth/login'&&request.method()==='POST'&&requireMfaOnLogin){requireMfaOnLogin=false;return respond({mfaRequired:true,mfaTicket:'ticket-1'});}
  if(request.method()!=='GET'&&(/^\/api\/v1\/(admin|gate)\//.test(url.pathname)||url.pathname==='/api/v1/budgets'||url.pathname.startsWith('/api/v1/audit/exports')))return respond({item:adminRecord,id:'fixture-write',...request.postDataJSON?.()});
  shotErrors.api.push({method:request.method(),path:url.pathname});
  return respond({error:{code:'NOT_FOUND',message:'Visual-audit fixture missing',requestId:'visual-audit',retryable:false}},404);
};
await page.route('**/api/v1/**',routeApi);

async function settle(selector,timeout){
  await page.locator(selector).first().waitFor({state:'visible',...(timeout?{timeout}:{})});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
}

async function settleSidebar(targetPage=page){
  await targetPage.locator('.ui-sidebar').evaluate(element=>new Promise(resolve=>requestAnimationFrame(()=>{const animations=element.getAnimations().filter(animation=>animation.playState!=='finished');if(!animations.length){resolve();return}void Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>resolve())})));
}

async function configure(locale,mode,density){
  preference={locale,colorMode:mode,density,defaultModelId:model.id};
  await page.evaluate(({locale,mode,density})=>{
    localStorage.setItem('app.locale.v1',locale);
    localStorage.setItem('app.appearance.v2',JSON.stringify({mode,density,updatedAt:Date.now()}));
  },{locale,mode,density});
}

async function inspect({locale,mode,density,viewport,screen,drawer,adminKey=null,adminNavOpen=false}){
  return page.evaluate(({locale,mode,density,viewport,screen,drawer,adminKey,adminNavOpen})=>{
    const rendered=element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&box.width>0&&box.height>0};
    const visible=element=>{const box=element.getBoundingClientRect();return rendered(element)&&box.right>0&&box.bottom>0&&box.left<innerWidth&&box.top<innerHeight};
    const textLines=element=>{const range=document.createRange(),tops=[];for(const node of element.childNodes){if(node.nodeType!==Node.TEXT_NODE||!node.textContent?.trim())continue;range.selectNodeContents(node);for(const rect of range.getClientRects())tops.push(Math.round(rect.top*10)/10)}return new Set(tops).size};
    const visibleButtons=[...document.querySelectorAll('button,a.ui-button')].filter(visible).map(element=>{const box=element.getBoundingClientRect();return{label:element.getAttribute('aria-label')||element.textContent?.trim().replace(/\s+/g,' ').slice(0,80)||'',width:box.width,height:box.height,lines:textLines(element),inForm:Boolean(element.closest('[role="dialog"],form'))}});
    const openDialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible),primaryRoot=openDialogs.at(-1)??document;
    const primary=[...primaryRoot.querySelectorAll('.ui-primary,button[class*="primary"]')].filter(visible).map(element=>{const box=element.getBoundingClientRect();return{label:element.textContent?.trim()??'',width:box.width}});
    const register=document.querySelector('.ui-sidebar'),registerBox=register?.getBoundingClientRect(),registerStyle=register?getComputedStyle(register):null;
    const registerVisible=Boolean(register&&visible(register)),registerState=register&&registerBox&&registerStyle?{visible:registerVisible,box:{left:registerBox.left,right:registerBox.right,top:registerBox.top,bottom:registerBox.bottom,width:registerBox.width,height:registerBox.height},opacity:registerStyle.opacity,transform:registerStyle.transform,transitionDuration:registerStyle.transitionDuration,display:registerStyle.display,visibility:registerStyle.visibility}:null;
    const seals=[...document.querySelectorAll('.ui-seal')].filter(visible).length;
    const sealFill=document.querySelector('.ui-seal__fill'),sealFrame=document.querySelector('.ui-seal__frame');
    const sealProbe=document.createElement('span');sealProbe.style.color='var(--seal)';document.body.append(sealProbe);const resolvedSeal=getComputedStyle(sealProbe).color;sealProbe.remove();
    const responseParagraph=document.querySelector('.ui-response-row .ui-message-content p');
    const entryNumbers=[...document.querySelectorAll('.ui-entry-gutter>span,.ui-entry-meta>span')].filter(rendered).map(element=>element.textContent?.trim());
    const stamps=[...document.querySelectorAll('[data-stamp]')].filter(rendered).map(element=>({kind:element.getAttribute('data-stamp-kind'),text:element.textContent?.trim()??'',expanded:element.getAttribute('aria-expanded')}));
    const actions=[...document.querySelectorAll('.ui-message-actions')].map(element=>getComputedStyle(element).opacity);
    const gutter=document.querySelector('.ui-entry-gutter'),meta=document.querySelector('.ui-entry-meta');
    const composer=document.querySelector('.ui-composer');
    const optionsButton=composer?.querySelector('.ui-options-button');
    const canvas=document.createElement('canvas'),measure=canvas.getContext('2d');
    const selects=[...(composer?.querySelectorAll('select')??[])].filter(rendered).map(element=>{
      const style=getComputedStyle(element),selected=element.options[element.selectedIndex]?.text??'';
      if(measure)measure.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth=measure?.measureText(selected).width??0,selectBox=element.getBoundingClientRect(),chevron=element.parentElement?.querySelector(':scope > svg'),chevronBox=chevron?.getBoundingClientRect();
      const textEnd=selectBox.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)+textWidth,gap=chevronBox?chevronBox.left-textEnd:null;
      return{id:element.id,selected,textWidth,textEnd,chevronLeft:chevronBox?.left??null,gap,top:selectBox.top};
    });
    const composerOverflow=composer?[...composer.querySelectorAll('*')].filter(rendered).map(element=>{const box=element.getBoundingClientRect();return{tag:element.tagName,className:element.className,left:box.left,right:box.right,width:box.width}}).filter(box=>box.left<-.5||box.right>innerWidth+.5):[];
    const legacyFonts=[...document.querySelectorAll('*')].filter(visible).filter(element=>/Inter|Roboto/i.test(getComputedStyle(element).fontFamily)).map(element=>({tag:element.tagName,className:element.className,font:getComputedStyle(element).fontFamily})).slice(0,10);
    const adminRoot=document.querySelector('.ui-admin');
    const adminNav=adminRoot?.querySelector(':scope > aside');
    const adminSelects=[...(adminRoot?.querySelectorAll('select')??[])].filter(visible).map(element=>{
      const style=getComputedStyle(element),selected=element.options[element.selectedIndex]?.text??'',box=element.getBoundingClientRect();
      if(measure)measure.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth=measure?.measureText(selected).width??0,textEnd=box.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)+textWidth;
      const rootStyle=getComputedStyle(document.documentElement),inset=parseFloat(rootStyle.getPropertyValue('--space-2')),size=parseFloat(style.backgroundSize),borderRight=parseFloat(style.borderRightWidth),chevronLeft=box.right-borderRight-inset-size;
      return{selected,textEnd,chevronLeft,gap:chevronLeft-textEnd,backgroundPosition:style.backgroundPosition,inset,size,borderRight};
    });
    const adminDrawer=adminRoot?.querySelector('.ui-drawer');
    const drawerScrolls=Boolean(adminDrawer&&visible(adminDrawer)&&adminDrawer.scrollHeight>adminDrawer.clientHeight+1);
    const drawerFooters=drawerScrolls?[...adminDrawer.querySelectorAll('*')].filter(visible).filter(element=>{const style=getComputedStyle(element);return style.position==='sticky'&&style.bottom!=='auto'}).map(element=>{const box=element.getBoundingClientRect(),drawerBox=adminDrawer.getBoundingClientRect(),left=drawerBox.left+adminDrawer.clientLeft,right=left+adminDrawer.clientWidth,bottom=drawerBox.top+adminDrawer.clientTop+adminDrawer.clientHeight;return{footer:{left:box.left,right:box.right,bottom:box.bottom},drawer:{left,right,bottom}}}):[];
    const topbar=adminRoot?.querySelector('.ui-topbar'),topbarBox=topbar?.getBoundingClientRect();
    const topbarChildren=topbarBox?[...topbar.children].filter(rendered).map(element=>{const box=element.getBoundingClientRect();return{className:element.className,left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:box.height,inside:box.left>=topbarBox.left-1&&box.right<=topbarBox.right+1&&box.top>=topbarBox.top-1&&box.bottom<=topbarBox.bottom+1}}):[];
    const checkControls=[...(adminRoot?.querySelectorAll('input[type="checkbox"],input[type="radio"]')??[])].filter(visible).map(element=>{const box=element.getBoundingClientRect();return{type:element.type,width:box.width}});
    const tableCells=[...(adminRoot?.querySelectorAll('td,th')??[])].filter(visible).map(element=>({tag:element.tagName,text:element.textContent?.trim().replace(/\s+/g,' ').slice(0,80)??'',display:getComputedStyle(element).display}));
    const fieldLabels=[...(adminRoot?.querySelectorAll('label')??[])].filter(visible).filter(label=>!label.querySelector('input[type="checkbox"],input[type="radio"]')).flatMap(label=>{
      const controls=[...label.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),select,textarea')].filter(visible);
      if(controls.length!==1)return[];
      const control=controls[0],controlRect=control.getBoundingClientRect(),walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT),texts=[];
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        if(!node.textContent?.trim()||!(node.compareDocumentPosition(control)&Node.DOCUMENT_POSITION_FOLLOWING)||!node.parentElement||!visible(node.parentElement))continue;
        const parentBox=node.parentElement.getBoundingClientRect(),parentStyle=getComputedStyle(node.parentElement);
        if(parentBox.width<2||parentBox.height<2||parentStyle.clipPath!=='none')continue;
        const range=document.createRange();range.selectNodeContents(node);const box=range.getBoundingClientRect();
        if(box.width>=2&&box.height>=2)texts.push({text:node.textContent.trim(),box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}});
      }
      if(texts.length===0)return[];
      const textElement=texts.at(-1)??null,controlBox={left:controlRect.left,right:controlRect.right,top:controlRect.top,bottom:controlRect.bottom,width:controlRect.width,height:controlRect.height};
      return[{label:label.textContent?.trim().replace(/\s+/g,' ')??'',text:textElement?.text??'',textBox:textElement?.box??null,controlBox,stacked:Boolean(textElement&&controlRect.top>=textElement.box.bottom-1)}];
    });
    const drawerControls=adminDrawer&&visible(adminDrawer)?[...adminDrawer.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),select,textarea')].filter(visible).filter(element=>!element.closest('.ui-source-row')).map(element=>{const box=element.getBoundingClientRect(),drawerBox=adminDrawer.getBoundingClientRect(),padding=parseFloat(getComputedStyle(adminDrawer).paddingLeft),expectedLeft=drawerBox.left+padding;return{tag:element.tagName,label:element.getAttribute('aria-label')??'',left:box.left,expectedLeft,delta:Math.abs(box.left-expectedLeft)}}):[];
    const statusCenters=[...(adminRoot?.querySelectorAll('tbody tr .ui-status')??[])].filter(visible).flatMap(element=>{const row=element.closest('tr');if(!row)return[];const own=document.createRange(),node=[...element.childNodes].find(child=>child.nodeType===Node.TEXT_NODE&&child.textContent?.trim());if(!node)return[];own.selectNodeContents(node);const ownBox=own.getBoundingClientRect(),peer=[...row.querySelectorAll('td')].filter(cell=>!cell.contains(element)).flatMap(cell=>[...cell.childNodes]).find(child=>child.nodeType===Node.TEXT_NODE&&child.textContent?.trim());if(!peer)return[];const other=document.createRange();other.selectNodeContents(peer);const peerBox=other.getBoundingClientRect();return[{status:element.textContent?.trim(),statusCenter:ownBox.top+ownBox.height/2,peerCenter:peerBox.top+peerBox.height/2,delta:Math.abs(ownBox.top+ownBox.height/2-peerBox.top-peerBox.height/2)}]});
    const rawCodes=new Set(['secret','pii','tenant','system','built_in','active','monthly','usd','outbound','block','text','reasoning']);
    const rawText=[];const walker=document.createTreeWalker(adminRoot??document.body,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const value=node.textContent?.trim()??'',parent=node.parentElement;if(!value||!parent||parent.matches('option:not(:checked)')||!visible(parent))continue;if(rawCodes.has(value)||/^(admin|chat|common|language)\.[\w.-]+$/u.test(value))rawText.push(value)}
    const admin=adminRoot?{
      navVisible:Boolean(adminNav&&visible(adminNav)),navOpen:Boolean(adminNav?.classList.contains('open')),
      navItemSvgs:adminNav?.querySelectorAll('nav a svg').length??0,
      groupLabels:[...(adminNav?.querySelectorAll('nav section h2')??[])].map(element=>element.textContent?.trim()??''),
      h1:[...adminRoot.querySelectorAll('h1')].filter(rendered).map(element=>element.textContent?.trim()??''),
      stickyHeaders:[...adminRoot.querySelectorAll('table thead th')].filter(rendered).map(element=>getComputedStyle(element).position),
      numericCells:[...adminRoot.querySelectorAll('table .ui-numeric')].filter(rendered).map(element=>({tag:element.tagName,align:getComputedStyle(element).textAlign})),
      drawer:adminDrawer&&visible(adminDrawer)?{width:adminDrawer.getBoundingClientRect().width,scrolls:drawerScrolls,footers:drawerFooters,controls:drawerControls}:null,
      selects:adminSelects,topbar:{height:topbarBox?.height??0,children:topbarChildren},checkControls,tableCells,fieldLabels,statusCenters,rawText,
    }:null;
    return{
      expected:{locale,mode,density,viewport,screen,drawer,adminKey,adminNavOpen},
      actual:{lang:document.documentElement.lang,mode:document.documentElement.dataset.mode,density:document.documentElement.dataset.density},
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
      widths:{scroll:document.documentElement.scrollWidth,viewport:innerWidth},
      fontLoaded:document.fonts.check('13px "IBM Plex Sans Var"'),legacyFonts,seals,
      seal:{token:resolvedSeal,fill:sealFill?getComputedStyle(sealFill).fill:null,frame:sealFrame?getComputedStyle(sealFrame).fill:null},
      documentHeight:{scroll:document.documentElement.scrollHeight,viewport:innerHeight},
      serverTextSentinel:(document.body.textContent??'').includes('SERVER-TEXT-SENTINEL'),
      responseFont:responseParagraph?{size:getComputedStyle(responseParagraph).fontSize,lineHeight:getComputedStyle(responseParagraph).lineHeight}:null,
      ledger:{entryNumbers,dateRules:[...document.querySelectorAll('.ui-date-rule')].filter(rendered).length,stamps,openReceipts:[...document.querySelectorAll('.ui-receipt')].filter(rendered).map(element=>({kind:element.getAttribute('data-receipt-kind'),row:element.getAttribute('data-receipt-row')})),gutterVisible:Boolean(gutter&&rendered(gutter)),metaVisible:Boolean(meta&&rendered(meta)),responseHeaderSvgs:document.querySelectorAll('.ui-response-row>header svg').length,actions},
      composer:composer?{labels:[...composer.querySelectorAll('.ui-field-control>label')].filter(rendered).map(element=>element.textContent?.trim()??''),optionsVisible:Boolean(optionsButton&&rendered(optionsButton)),optionsExpanded:optionsButton?.getAttribute('aria-expanded')??null,sendText:composer.querySelector('.ui-send-button')?.textContent?.trim()??'',selects,overflow:composerOverflow}:null,
      registerVisible,registerState,visibleButtons,primary,admin,
    };
  },{locale,mode,density,viewport,screen,drawer,adminKey,adminNavOpen});
}

function assertions(detail,errors){
  const failures=[];
  const check=(condition,message,data)=>{if(!condition)failures.push({message,data})};
  const {expected,actual}=detail;
  check(!detail.horizontalOverflow,'horizontal overflow',detail.widths);
  check(!detail.serverTextSentinel,'server message text reached the document',null);
  check(errors.console.length===0,'console errors',errors.console);
  check(errors.page.length===0,'page errors',errors.page);
  check(errors.request.length===0,'request errors',errors.request);
  check(errors.api.length===0,'unmocked API calls',errors.api);
  check(actual.lang===expected.locale,'wrong html lang',actual);
  check(actual.mode===expected.mode,'wrong data-mode',actual);
  check(actual.density===expected.density,'wrong data-density',actual);
  check(detail.fontLoaded,'IBM Plex Sans Var did not load',null);
  check(detail.legacyFonts.length===0,'legacy computed font family',detail.legacyFonts);
  check(detail.seals===1,'expected exactly one visible seal',detail.seals);
  check(detail.seal.fill===detail.seal.token,'seal fill does not resolve to --seal',detail.seal);
  check(detail.seal.frame==='none','seal frame must have fill none',detail.seal);
  const chatScreen=['empty','conversation','composer-options-open','conversation-feedback','conversation-feedback-chat','conversation-feedback-settings','live-gating','settings','drawer','search','projects','skills','archived'].includes(expected.screen);
  if(chatScreen)check(detail.registerVisible===(expected.viewport.width>=1024||expected.drawer),'register visibility is wrong',detail.registerState);
  if(chatScreen)check(detail.documentHeight.scroll===detail.documentHeight.viewport,'fixed-height chat shell scrolls the document',detail.documentHeight);
  if(expected.screen==='conversation'){
    check(JSON.stringify(detail.ledger.entryNumbers)===JSON.stringify(['01','02','03','04','05','06']),'entry numbers are not exactly 01–06',detail.ledger.entryNumbers);
    check(detail.ledger.dateRules===2,'expected one date rule for each of two dates',detail.ledger.dateRules);
    check(detail.ledger.stamps.length>0&&detail.ledger.stamps.every(stamp=>stamp.text.length>0),'a checkpoint stamp has empty text',detail.ledger.stamps);
    check(detail.ledger.openReceipts.some(receipt=>receipt.kind==='block'&&receipt.row==='prompt'),'blocked prompt receipt is not open',detail.ledger.openReceipts);
    check(detail.ledger.openReceipts.some(receipt=>receipt.kind==='require_approval'&&receipt.row==='prompt'),'held approval receipt is not open',detail.ledger.openReceipts);
    check(detail.ledger.gutterVisible===(expected.viewport.width>=768),'ledger gutter visibility is wrong',detail.ledger);
    check(detail.ledger.metaVisible===(expected.viewport.width<768),'mobile ledger meta visibility is wrong',detail.ledger);
    check(detail.ledger.responseHeaderSvgs===0,'response header contains an svg vendor mark',detail.ledger.responseHeaderSvgs);
    if(expected.viewport.width>=768)check(detail.ledger.actions.every(opacity=>opacity==='0'),'non-touch row actions are visible before hover or focus',detail.ledger.actions);
    else check(detail.ledger.actions.every(opacity=>opacity==='1'),'row actions are hidden below 768px',detail.ledger.actions);
    const expectedSize=expected.locale==='en'?(expected.density==='compact'?'14px':'15px'):(expected.density==='compact'?'15px':'16px');
    check(detail.responseFont?.size===expectedSize,'response paragraph body size is wrong',{expected:expectedSize,actual:detail.responseFont});
    check(detail.conversationInteraction?.redactBefore==='false'&&detail.conversationInteraction?.redactAfter==='true'&&detail.conversationInteraction?.receiptVisible,'redacted prompt stamp did not expand its receipt',detail.conversationInteraction);
    check(detail.conversationInteraction?.focusOpacity==='1'&&detail.conversationInteraction?.hoverOpacity==='1','desktop row actions did not reveal on focus and hover',detail.conversationInteraction);
  }
  if(['empty','conversation','composer-options-open'].includes(expected.screen)){
    const optionsOpen=expected.screen==='composer-options-open';
    const expectedFieldCount=expected.viewport.width>=768||optionsOpen?4:1;
    check(detail.composer?.labels.length===expectedFieldCount,'composer field visibility is wrong before disclosure',detail.composer);
    check(detail.composer?.optionsVisible===(expected.viewport.width<768),'composer Options disclosure visibility is wrong',detail.composer);
    if(expected.viewport.width<768){
      check(detail.composer?.optionsExpanded===(optionsOpen?'true':'false'),`mobile composer Options is not ${optionsOpen?'open':'collapsed'}`,detail.composer);
      check(detail.composerInteraction?.labelsAfterOpen===4&&detail.composerInteraction?.hintAfterOpen,'mobile Options does not reveal all controls and the checkpoint hint',detail.composerInteraction);
    }
    check(detail.composer?.sendText===sendLabels[expected.locale],'composer send button lacks the required visible label',detail.composer);
    check(detail.composerInteraction?.twelveLineHeight>detail.composerInteraction?.initialHeight,'composer textarea did not grow for a 12-line draft',detail.composerInteraction);
    check(detail.composerInteraction?.cappedHeight<=expected.viewport.height*.4+.5&&detail.composerInteraction?.cappedScrollHeight>detail.composerInteraction?.cappedHeight,'composer textarea did not stop at 40vh and scroll',detail.composerInteraction);
    check((detail.composer?.selects.length??0)>0&&detail.composer.selects.every(select=>select.gap!==null&&select.gap>=4),'a composer select leaves less than 4px between its selected text and chevron',detail.composer?.selects);
    if(expected.screen==='empty'&&expected.locale==='en'&&expected.viewport.width===1440){
      const tops=detail.composer?.selects.map(select=>select.top)??[];
      check(tops.length===4&&Math.max(...tops)-Math.min(...tops)<=1,'the four English composer fields do not share one row',detail.composer?.selects);
    }
    check(detail.composerInteraction?.focusRing?.present,'the focused composer has no 2px focus outline',detail.composerInteraction?.focusRing);
    check(detail.composerInteraction?.focusRing?.collisions.length===0,'the textarea focus outline intersects a composer control',detail.composerInteraction?.focusRing);
    if(expected.viewport.width===390)check(detail.composer?.overflow.length===0,'a composer element is wider than the 390px viewport',detail.composer?.overflow);
  }
  if(expected.screen==='live-gating')check(detail.ledger.stamps.some(stamp=>stamp.kind==='checking'&&stamp.text.length>0),'live gating shot has no checking stamp',detail.ledger.stamps);
  if(detail.admin){
    const key=expected.adminKey??(expected.screen==='admin'?'overview':null),expectedTitle=key?adminNames[expected.locale][key]:null;
    check(detail.admin.navVisible===(expected.viewport.width>=1024||expected.adminNavOpen===true),'admin navigation visibility is wrong',detail.admin);
    if(expected.viewport.width<1024)check(detail.admin.navOpen===(expected.adminNavOpen===true),'admin navigation drawer open state is wrong',detail.admin);
    check(detail.admin.navItemSvgs===0,'admin navigation item contains an svg',detail.admin.navItemSvgs);
    check(JSON.stringify(detail.admin.groupLabels)===JSON.stringify(adminGroups[expected.locale]),'admin navigation groups are missing or out of order',detail.admin.groupLabels);
    check(detail.admin.h1.length===1,'admin screen does not have exactly one h1',detail.admin.h1);
    if(expectedTitle)check(detail.admin.h1[0]===expectedTitle,'admin h1 does not match the localized screen name',{expected:expectedTitle,actual:detail.admin.h1[0]});
    check(detail.primary.length<=1,'admin screen has more than one visible primary action',detail.primary);
    check(detail.admin.topbar.children.every(child=>child.inside&&child.height<=detail.admin.topbar.height+1),'an admin top-bar child overflows or wraps outside the bar',detail.admin.topbar);
    check(detail.admin.checkControls.every(control=>control.width<=24),'an admin checkbox or radio is wider than 24px',detail.admin.checkControls);
    check(detail.admin.statusCenters.every(status=>status.delta<=1),'a status label is not vertically centered with its row text',detail.admin.statusCenters);
    check(detail.admin.rawText.length===0,'an admin screen exposes a raw fixture code or missing translation key',detail.admin.rawText);
    check(detail.admin.stickyHeaders.every(position=>position==='sticky'),'admin table header is not sticky',detail.admin.stickyHeaders);
    check(detail.admin.numericCells.every(cell=>cell.align==='right'),'admin numeric cell or header is not right aligned',detail.admin.numericCells);
    check(detail.admin.tableCells.every(cell=>cell.display==='table-cell'),'an admin table cell is not laid out as a table cell',detail.admin.tableCells);
    check(detail.admin.fieldLabels.every(label=>label.stacked),'an admin field label is not above its control',detail.admin.fieldLabels);
    if(detail.admin.drawer)check(Math.abs(detail.admin.drawer.width-(expected.viewport.width===390?390:480))<=1,'admin record drawer width is wrong',detail.admin.drawer);
    if(detail.admin.drawer?.scrolls)check(detail.admin.drawer.footers.every(({footer,drawer})=>Math.abs(footer.bottom-drawer.bottom)<=1&&Math.abs(footer.left-drawer.left)<=1&&Math.abs(footer.right-drawer.right)<=1),'a sticky drawer footer does not sit flush with the drawer edges',detail.admin.drawer.footers);
    if(detail.admin.drawer&&expected.viewport.width===1440)check(detail.admin.drawer.controls.every(control=>control.delta<=1),'a drawer field does not start at the form content edge',detail.admin.drawer.controls);
    check(detail.admin.selects.every(select=>select.gap>=4),'an admin select leaves less than 4px between selected text and its rendered chevron',detail.admin.selects);
  }
  for(const button of detail.visibleButtons)check(button.height>=27.5,'visible button is shorter than 28px',button);
  for(const button of detail.visibleButtons)check(button.lines<=1,'visible button label wraps',button);
  if(expected.viewport.width>=768)for(const button of detail.visibleButtons.filter(button=>button.inForm))check(button.width<=320,'a drawer, dialog, or form button exceeds 320px',button);
  if(expected.viewport.width===1440)for(const button of detail.primary)check(button.width<=expected.viewport.width/2,'primary button exceeds half the viewport',button);
  return failures;
}

async function controlGeometryFailures(root=page.locator('body')){
  const geometry=await root.evaluate(element=>{
    const box=node=>{const rect=node.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}};
    const segments=[...element.querySelectorAll('.ui-segments input')].map(input=>{const label=input.closest('label'),inputBox=box(input),labelBox=label?box(label):null;return{type:input.type,name:input.name,input:inputBox,label:labelBox,inside:Boolean(labelBox&&inputBox.left>=labelBox.left-1&&inputBox.right<=labelBox.right+1&&inputBox.top>=labelBox.top-1&&inputBox.bottom<=labelBox.bottom+1)}});
    const visibleChecks=[...element.querySelectorAll('input[type="checkbox"],input[type="radio"]')].filter(input=>getComputedStyle(input).opacity!=='0').map(input=>({type:input.type,name:input.name,...box(input)}));
    return{segments,visibleChecks};
  });
  const failures=[];
  const spilled=geometry.segments.filter(input=>!input.inside);
  if(spilled.length)failures.push({message:'a segmented-control input extends outside its own label',data:spilled});
  const oversized=geometry.visibleChecks.filter(input=>input.width>24||input.height>24);
  if(oversized.length)failures.push({message:'a visible checkbox or radio is larger than 24px',data:oversized});
  return failures;
}

async function noticePlacementFailures(){
  const placement=await page.locator('.ui-notice-stack').evaluate(stack=>{
    const shown=element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&box.width>0&&box.height>0};
    const box=element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}};
    const overlaps=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
    const clippedBox=element=>{let {left,right,top,bottom}=element.getBoundingClientRect();for(let node=element.parentElement;node;node=node.parentElement){const style=getComputedStyle(node);if(!/auto|scroll|hidden|clip/.test(`${style.overflowX}${style.overflowY}`))continue;const parent=node.getBoundingClientRect();left=Math.max(left,parent.left);right=Math.min(right,parent.right);top=Math.max(top,parent.top);bottom=Math.min(bottom,parent.bottom);if(right-left<=.5||bottom-top<=.5)return null}return{left,right,top,bottom,width:right-left,height:bottom-top}};
    const positions=[{selector:'.ui-notice-stack',position:getComputedStyle(stack).position},...[...stack.querySelectorAll('.ui-conversation-feedback,.ui-offline')].map(element=>({selector:element.className,position:getComputedStyle(element).position}))];
    const stackBox=box(stack);
    const headings=[...document.querySelectorAll('h1,h2')].filter(shown).flatMap(element=>{const clipped=clippedBox(element);return clipped&&overlaps(stackBox,clipped)?[{tag:element.tagName,text:element.textContent?.trim().slice(0,80)??'',box:clipped}]:[]});
    const controls=[...document.querySelectorAll('button,a,input,select,textarea,[role="button"]')].filter(element=>!stack.contains(element)&&shown(element)).flatMap(element=>{const clipped=clippedBox(element);return clipped&&overlaps(stackBox,clipped)?[{tag:element.tagName,role:element.getAttribute('role'),label:element.getAttribute('aria-label')||element.textContent?.trim().replace(/\s+/g,' ').slice(0,80)||'',box:clipped}]:[]});
    const notices=[...stack.querySelectorAll('.ui-conversation-feedback,.ui-offline')].filter(shown);
    const noticeBottom=notices.reduce((bottom,element)=>Math.max(bottom,box(element).bottom),Number.NEGATIVE_INFINITY);
    const timeline=document.querySelector('.ui-timeline');
    const heading=document.querySelector('.ui-page h1');
    const region=timeline&&shown(timeline)?timeline:heading&&shown(heading)?heading:null;
    const regionBox=region?box(region):null;
    const gap=regionBox&&Number.isFinite(noticeBottom)?regionBox.top-noticeBottom:null;
    const regionName=region===timeline?'thread':region===heading?'heading':null;
    const contentEdges=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return{left:rect.left+element.clientLeft+(parseFloat(style.paddingLeft)||0),right:rect.left+element.clientLeft+element.clientWidth-(parseFloat(style.paddingRight)||0)}};
    const next=stack.nextElementSibling;
    const pageColumn=next&&next.matches('.ui-page')&&shown(next)?next:null;
    const threadColumn=next&&next.matches('.ui-timeline')&&shown(next)?next:null;
    const noticeEdges=notices.map(element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right}});
    const columnName=pageColumn?'page':threadColumn?'thread':null;
    const column=pageColumn?contentEdges(pageColumn):threadColumn?contentEdges(threadColumn):null;
    return{positions,stackBox,headings,controls,gap,region:regionName,noticeEdges,column,columnName};
  });
  const failures=[];
  const floating=placement.positions.filter(item=>item.position==='fixed'||item.position==='absolute');
  if(floating.length)failures.push({message:'chat notice is taken out of normal flow',data:floating});
  if(placement.headings.length)failures.push({message:'chat notice intersects a page heading',data:placement});
  if(placement.controls.length)failures.push({message:'chat notice intersects another visible control',data:placement});
  if(!(placement.gap>=8))failures.push({message:'chat notice leaves less than 8px before the region below it',data:{gap:placement.gap,region:placement.region}});
  const linesUp=Boolean(placement.column)&&placement.noticeEdges.length>0&&placement.noticeEdges.every(edge=>Math.abs(edge.left-placement.column.left)<=1&&Math.abs(edge.right-placement.column.right)<=1);
  if(!linesUp)failures.push({message:placement.columnName==='thread'?'chat notice does not line up with the thread column':'chat notice does not line up with the page column',data:{notice:placement.noticeEdges,column:placement.column,region:placement.columnName}});
  return{failures,column:{notice:placement.noticeEdges,column:placement.column,region:placement.columnName}};
}

async function waitForOpacity(locator,target='1',timeoutMs=1_000){
  return locator.evaluate((element,{target,timeoutMs})=>new Promise(resolve=>{const deadline=performance.now()+timeoutMs;const check=()=>{const opacity=getComputedStyle(element).opacity;if(opacity===target||performance.now()>=deadline){resolve(opacity);return}requestAnimationFrame(check)};check()}),{target,timeoutMs});
}

async function auditComposer(viewport,keepOptionsOpen=false){
  const composer=page.locator('.ui-composer');
  if(!await composer.count())return null;
  const area=composer.locator('textarea'),initialHeight=await area.evaluate(element=>element.getBoundingClientRect().height);
  let labelsAfterOpen=null,hintAfterOpen=null;
  if(viewport.width<768){
    const options=composer.locator('.ui-options-button');
    await options.click();
    labelsAfterOpen=await composer.locator('.ui-field-control>label').evaluateAll(elements=>elements.filter(element=>{const box=element.getBoundingClientRect(),style=getComputedStyle(element);return style.display!=='none'&&box.width>0&&box.height>0}).length);
    hintAfterOpen=await composer.locator('.ui-options-hint').isVisible();
    if(!keepOptionsOpen)await options.click();
  }
  await area.fill(Array.from({length:12},(_,index)=>`Draft line ${index+1}`).join('\n'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const twelveLineHeight=await area.evaluate(element=>element.getBoundingClientRect().height);
  await area.fill(Array.from({length:80},(_,index)=>`Long draft line ${index+1}`).join('\n'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const capped=await area.evaluate(element=>({height:element.getBoundingClientRect().height,scrollHeight:element.scrollHeight}));
  await area.fill('');
  await area.focus();
  const focusRing=await area.evaluate(element=>{
    const rendered=control=>{const style=getComputedStyle(control),box=control.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&box.width>0&&box.height>0};
    const box=element.getBoundingClientRect(),style=getComputedStyle(element),width=parseFloat(style.outlineWidth)||0,offset=parseFloat(style.outlineOffset)||0,grow=style.outlineStyle==='none'?0:width+offset;
    const outlineBox={left:box.left-grow,right:box.right+grow,top:box.top-grow,bottom:box.bottom+grow};
    const collisions=style.outlineStyle==='none'?[]:[...element.closest('.ui-composer').querySelectorAll('select,button')].filter(rendered).map(control=>{const rect=control.getBoundingClientRect();return{tag:control.tagName,label:control.getAttribute('aria-label')||control.textContent?.trim()||'',left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}}).filter(rect=>outlineBox.left<rect.right&&outlineBox.right>rect.left&&outlineBox.top<rect.bottom&&outlineBox.bottom>rect.top);
    const composer=element.closest('.ui-composer'),composerStyle=getComputedStyle(composer),textareaRing=style.outlineStyle!=='none'&&width===2,composerRing=composerStyle.outlineStyle!=='none'&&parseFloat(composerStyle.outlineWidth)===2;
    return{present:textareaRing||composerRing,textarea:{style:style.outlineStyle,width,offset},composer:{style:composerStyle.outlineStyle,width:parseFloat(composerStyle.outlineWidth)||0,offset:parseFloat(composerStyle.outlineOffset)||0},outlineBox,collisions};
  });
  return{initialHeight,twelveLineHeight,cappedHeight:capped.height,cappedScrollHeight:capped.scrollHeight,labelsAfterOpen,hintAfterOpen,focusRing};
}

const screens=[
  {name:'sign-in',path:'/login',ready:'.ui-login'},
  {name:'empty',path:'/chat',ready:'.ui-empty'},
  {name:'conversation',path:'/chat/conv-1',ready:'.ui-entry'},
  {name:'search',path:'/search',ready:'.ui-page'},
  {name:'projects',path:'/projects',ready:'.ui-page'},
  {name:'skills',path:'/skills',ready:'.ui-page'},
  {name:'archived',path:'/archived',ready:'.ui-page'},
  {name:'settings',path:'/settings/general',ready:'.ui-page'},
  {name:'404',path:'/route-that-does-not-exist',ready:'.ui-route-not-found'},
  {name:'admin',path:'/admin',ready:'.ui-admin'},
];
const adminScreens=[
  {key:'overview',path:'/admin'},
  {key:'policies',path:'/admin/policies'},
  {key:'custom-terms',path:'/admin/custom-terms'},
  {key:'compliance',path:'/admin/compliance'},
  {key:'detectors',path:'/admin/detectors'},
  {key:'violations',path:'/admin/violations'},
  {key:'audit',path:'/admin/audit'},
  {key:'analytics',path:'/admin/analytics'},
  {key:'assets',path:'/admin/assets'},
  {key:'users',path:'/admin/users'},
  {key:'groups',path:'/admin/groups'},
  {key:'roles',path:'/admin/roles'},
  {key:'models',path:'/admin/models'},
  {key:'assistants',path:'/admin/assistants'},
  {key:'providers',path:'/admin/providers'},
  {key:'budgets',path:'/admin/budgets'},
  {key:'retention',path:'/admin/retention'},
  {key:'settings',path:'/admin/settings'},
];

async function shot({locale,mode,density='comfortable',viewport,screen,drawer=false}){
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  await configure(locale,mode,density);
  shotErrors={console:[],page:[],request:[],api:[]};
  const supportStart=supportRequests.length;
  const meStart=meRequests.length;
  await page.goto(`${base}${screen.path}`,{waitUntil:'networkidle'});
  await settle(screen.ready);
  if(drawer){await page.locator('.ui-mobile-menu').click();await page.locator('.ui-sidebar.is-open').waitFor({state:'visible'});await settle('.ui-sidebar.is-open');await settleSidebar()}
  const composerInteraction=!drawer&&['empty','conversation','composer-options-open'].includes(screen.name)?await auditComposer(viewport,screen.name==='composer-options-open'):null;
  const detail=await inspect({locale,mode,density,viewport,screen:drawer?'drawer':screen.name,drawer});
  if(composerInteraction)detail.composerInteraction=composerInteraction;
  if(screen.name==='conversation'&&!drawer){
    const redact=page.locator('.ui-prompt-row [data-stamp-kind="redact"]').first(),before=await redact.getAttribute('aria-expanded');
    await redact.click();
    const after=await redact.getAttribute('aria-expanded'),receiptVisible=await page.locator(`#${await redact.getAttribute('aria-controls')}`).isVisible();
    const firstAction=page.locator('.ui-message-actions button').first();await firstAction.focus();const focusOpacity=await waitForOpacity(firstAction.locator('xpath=..'));await page.evaluate(()=>document.activeElement?.blur());
    const firstRow=page.locator('.ui-message-row').first();await firstRow.hover();const hoverOpacity=await waitForOpacity(firstRow.locator('.ui-message-actions'));await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());
    detail.conversationInteraction={redactBefore:before,redactAfter:after,receiptVisible,focusOpacity,hoverOpacity};
  }
  const errors=structuredClone(shotErrors);
  const failures=assertions(detail,errors);
  const shotSupportRequests=supportRequests.slice(supportStart);
  if(screen.name==='sign-in'&&shotSupportRequests.length)failures.push({message:'signed-out screen requested deployment support',data:shotSupportRequests});
  if(screen.name==='settings'&&(!shotSupportRequests.length||!await page.getByText('Visual Support',{exact:true}).count()))failures.push({message:'signed-in support contact was not requested and rendered',data:shotSupportRequests});
  if(screen.name==='404'&&meRequests.slice(meStart).length)failures.push({message:'signed-out not-found page requested an account route',data:meRequests.slice(meStart)});
  failures.push(...await controlGeometryFailures());
  const stem=[locale,mode,density,viewport.name,drawer?'drawer':screen.name].join('-');
  const fixedChat=['empty','conversation','composer-options-open','conversation-feedback','conversation-feedback-settings','settings','drawer','search','projects','skills','archived'].includes(drawer?'drawer':screen.name);
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:!fixedChat,animations:'disabled'});
  report.shots.push({name:stem,detail,errors,failures});
  for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function adminShot({locale,mode='light',viewport,screen,recordDrawer=false,createDrawer=false,releaseDialog=false,navigationDrawer=false}){
  const density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  await configure(locale,mode,density);
  shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}${screen.path}`,{waitUntil:'networkidle'});
  await settle('.ui-admin h1');
  if(recordDrawer){
    const trigger=page.locator('.ui-admin tbody tr').first();
    await trigger.waitFor({state:'visible'});
    await trigger.click();
    await page.locator('.ui-drawer').waitFor({state:'visible'});
    await settle('.ui-drawer');
  }
  if(createDrawer&&screen.key!=='custom-terms'){
    const trigger=page.locator(screen.key==='retention'?'.ui-holds header .ui-primary':'.ui-page-actions .ui-primary').first();
    await trigger.waitFor({state:'visible'});
    await trigger.click();
    await page.locator('[role="dialog"]').last().waitFor({state:'visible'});
    await settle('[role="dialog"]');
  }
  if(releaseDialog){
    const trigger=page.locator('.ui-holds tbody .ui-cell-actions button').first();
    await trigger.waitFor({state:'visible'});await trigger.click();await page.locator('[role="dialog"]').last().waitFor({state:'visible'});await settle('[role="dialog"]');
  }
  if(navigationDrawer){
    await page.locator('.ui-mobile-menu').click();
    await page.locator('#ui-admin-navigation.open').waitFor({state:'visible'});
    await settle('#ui-admin-navigation.open');
  }
  const detail=await inspect({locale,mode,density,viewport,screen:`admin-${screen.key}`,drawer:false,adminKey:screen.key,adminNavOpen:navigationDrawer});
  const errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  failures.push(...await controlGeometryFailures());
  const rows=await page.locator('.ui-admin tbody tr').allTextContents(),pair=rows[0]??null;
  if(screen.key==='violations'){
    const expected={en:['Alex Morgan','Blocked'],'zh-TW':['Alex Morgan','已阻擋'],ja:['Alex Morgan','ブロック済み']}[locale];
    if(!expected.every(value=>pair?.includes(value)))failures.push({message:'violation record is not paired with its blocked outcome',data:{pair,expected}});
  }
  if(screen.key==='audit'){
    const expected=auditLabels[locale];
    for(const [category,action] of expected)if(!rows.some(row=>row.includes(category)&&row.includes(action)))failures.push({message:'audit category and action are not paired with their localized labels',data:{locale,category,action,rows}});
    const cells=await page.locator('.ui-admin tbody tr').evaluateAll(tableRows=>tableRows.map(row=>{const values=[...row.querySelectorAll('td')].map(cell=>cell.textContent?.trim()??'');return{category:values[1]??'',action:values[2]??''}}));
    for(const raw of auditEvents.flatMap(event=>[event.category,event.action]))if(cells.some(cell=>cell.category===raw||cell.action===raw))failures.push({message:'audit table exposed a raw category or action',data:{locale,raw,cells}});
    if(rows.some(row=>row.includes(' · ')))failures.push({message:'audit table used the English action fallback',data:{locale,rows}});
  }
  if(screen.key==='compliance'){
    const expected={en:['Secret credentials','Block'],'zh-TW':['Secret credentials','阻擋'],ja:['Secret credentials','ブロック']}[locale];
    if(!expected.every(value=>pair?.includes(value)))failures.push({message:'rule-map detector is not paired with its block action',data:{pair,expected}});
  }
  const suffix=navigationDrawer?'navigation-open':releaseDialog?'release-open':createDrawer?'create-open':recordDrawer?'record-open':'screen';
  const stem=[locale,mode,density,viewport.name,`admin-${screen.key}`,suffix].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});
  report.shots.push({name:stem,detail:{...detail,recordPair:pair,recordRows:rows},errors,failures});
  for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function publicCredentialShot(locale,viewport,kind,state='form'){
  const mode='light',density='comfortable',path=kind==='setup'?`/setup${state==='tokenless'?'':'#visual-token'}`:kind==='reset-password'?`/reset-password${state==='tokenless'?'':state==='dead'?'#dead-token':'#visual-token'}`:'/forgot-password';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  const supportStart=supportRequests.length;await page.goto(`${base}/login`,{waitUntil:'domcontentloaded'});
  await page.goto(`${base}${path}`,{waitUntil:'networkidle'});await settle('.ui-login__form h1');
  if(state==='dead'){
    await page.locator('input[type="password"]').nth(0).fill('a sufficiently long password');await page.locator('input[type="password"]').nth(1).fill('a sufficiently long password');await page.locator('form .ui-primary').click();await page.locator('.ui-login__error').waitFor({state:'visible'});await settle('.ui-login__error');
    shotErrors.console=shotErrors.console.filter(message=>!message.includes('422 (Unprocessable Entity)'));
  }
  const detail=await inspect({locale,mode,density,viewport,screen:kind,drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  const shotSupportRequests=supportRequests.slice(supportStart);if(shotSupportRequests.length)failures.push({message:'signed-out recovery screen requested deployment support',data:{kind,state,requests:shotSupportRequests}});
  if(kind!=='forgot-password'&&await page.evaluate(()=>location.hash!==''))failures.push({message:'credential fragment remained in the address bar',data:await page.evaluate(()=>location.hash)});
  if(state!=='form'&&await page.locator('.ui-login__form form').count())failures.push({message:`${state} recovery state still rendered a password form`,data:kind});
  if(kind==='reset-password'&&state!=='form'&&!await page.locator('a[href="/forgot-password"]').isVisible())failures.push({message:`${state} reset state omitted the request-new-link action`,data:kind});
  if(kind==='setup'&&state==='tokenless'&&!await page.locator('.ui-login__next-step').isVisible())failures.push({message:'tokenless setup state omitted administrator guidance',data:kind});
  if(!await page.locator('a[href="/login"]').last().isVisible())failures.push({message:'recovery state omitted the sign-in link',data:{kind,state}});
  const stem=[locale,mode,density,viewport.name,kind,state].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:true,animations:'disabled'});
  report.shots.push({name:stem,detail,errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function credentialDialogShot(locale,viewport,flow){
  const mode='light',density='comfortable';adminPersona='owner';await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/admin/users`,{waitUntil:'networkidle'});await settle('.ui-admin h1');let opener;
  if(flow==='invite'){
    opener=page.locator('.ui-page-actions .ui-primary');await opener.click();const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible'});await drawer.locator('input[type="email"]').fill('visual-invite@example.test');await drawer.locator('input:not([type="email"])').first().fill('Visual Invite');await drawer.locator('form .ui-primary').click();
  }else{
    await page.locator('.ui-admin tbody tr').first().click();await page.locator('.ui-drawer').waitFor({state:'visible'});opener=page.locator('.ui-record-buttons button').filter({hasText:{en:'Create reset link','zh-TW':'建立重設連結',ja:'リセットリンクを作成'}[locale]});await opener.click();
  }
  await page.locator('.ui-credential-link').waitFor({state:'visible'});await settle('.ui-credential-link');
  const detail=await inspect({locale,mode,density,viewport,screen:`admin-users-${flow}-link-dialog`,drawer:false,adminKey:'users'}),errors=structuredClone(shotErrors),failures=assertions(detail,errors),input=page.locator('.ui-credential-link input'),expected=flow==='invite'?'https://control.example/setup#visual-audit-secret':'https://control.example/reset-password#visual-audit-secret';
  if(!await input.isVisible()||await input.isEditable()||await input.inputValue()!==expected)failures.push({message:'credential dialog did not expose one read-only link',data:await input.count()});
  const expectedCopy=flow==='invite'?{en:['One-time activation link','Share this one-time link with the invited teammate. It is shown only here.'],'zh-TW':['一次性啟用連結','請將此一次性連結交給受邀者。離開後不會再次顯示。'],ja:['1回限りの有効化リンク','この1回限りのリンクを招待相手に共有してください。この画面を離れると再表示できません。']}[locale]:{en:['Password reset link','Share this one-time link with the user. It is cleared when this dialog closes.'],'zh-TW':['密碼重設連結','請將此一次性連結安全地提供給使用者。關閉對話框後即會清除。'],ja:['パスワードリセットリンク','この1回限りのリンクをユーザーに安全に共有してください。ダイアログを閉じると消去されます。']}[locale];
  const actualCopy=[await page.locator('.ui-dialog h2').innerText(),await page.locator('.ui-credential-link>p').first().innerText()];if(JSON.stringify(actualCopy)!==JSON.stringify(expectedCopy))failures.push({message:'credential dialog title or intro does not match its flow',data:{flow,locale,actualCopy,expectedCopy}});
  if(!await input.evaluate(element=>document.activeElement===element))failures.push({message:'credential link field did not hold focus while its dialog was open',data:{flow,active:await page.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.className,text:document.activeElement?.textContent?.trim()}))}});
  const stem=[locale,mode,density,viewport.name,`admin-users-${flow}-link-dialog`].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});
  await page.locator('.ui-credential-link footer button').click();await page.locator('.ui-credential-link').waitFor({state:'detached'});if(!await opener.evaluate(element=>document.activeElement===element))failures.push({message:'credential dialog did not return focus to its opener',data:{flow,active:await page.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.className,text:document.activeElement?.textContent?.trim()}))}});
  report.shots.push({name:stem,detail,errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function adminUsersPersonaShot(locale,viewport,state){
  const mode='light',density='comfortable';adminPersona='admin';await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/admin/users`,{waitUntil:'networkidle'});await settle('.ui-admin h1');const failures=[];
  const rows=await page.locator('.ui-admin tbody tr').allTextContents();if(rows.length!==3||!rows.some(row=>row.includes('Workspace Owner'))||!rows.some(row=>row.includes('Compliance Reviewer'))||!rows.some(row=>row.includes('Workspace Member')))failures.push({message:'administrator persona did not show the protected owner, reviewer, and editable member rows',data:rows});
  if(!refusalText[locale].roles.every(role=>rows.some(row=>row.includes(role))))failures.push({message:'Users Roles column did not localize every server role',data:{locale,rows,expected:refusalText[locale].roles}});
  const complianceNote={en:'Only the workspace owner can assign the compliance reviewer role.','zh-TW':'只有工作空間擁有者可以指派法遵審核者角色。',ja:'コンプライアンス審査担当ロールを割り当てられるのはワークスペース所有者だけです。'}[locale];
  const checkComplianceNoteLayout=async(drawer,helpText=null)=>{
    const note=drawer.getByText(complianceNote,{exact:true});if(!await note.count())return;
    const anchor=helpText?drawer.locator('details').getByText(helpText,{exact:true}):drawer.locator('select').last();
    const boxes=await Promise.all([anchor.evaluate(element=>{const box=element.getBoundingClientRect();return{top:box.top,bottom:box.bottom}}),note.evaluate(element=>{const box=element.getBoundingClientRect();return{top:box.top,bottom:box.bottom}})]);
    if(boxes[1].top<boxes[0].bottom-.5)failures.push({message:'compliance owner-only note does not start on its own line',data:{locale,state,anchor:boxes[0],note:boxes[1]}});
  };
  if(state==='edit'){
    await page.locator('.ui-admin tbody tr').first().click();await page.locator('.ui-drawer').waitFor({state:'visible'});const buttons=await page.locator('.ui-record-buttons button').allTextContents();if(buttons.length!==1)failures.push({message:'protected account advertised an account action',data:buttons});await page.locator('.ui-record-buttons button').first().click();await page.locator('.ui-drawer').last().waitFor({state:'visible'});
    const note={en:'Only the workspace owner can change this account’s status, role, or access.','zh-TW':'只有工作空間擁有者可以變更此帳號的狀態、角色或存取權。',ja:'このアカウントのステータス、ロール、アクセスを変更できるのはワークスペース所有者だけです。'}[locale];if(!await page.locator('.ui-drawer').last().getByText(note,{exact:true}).count())failures.push({message:'protected-account edit drawer omitted the owner-only note',data:{locale,note}});
  }else if(state==='invite'){
    await page.locator('.ui-page-actions .ui-primary').click();const drawer=page.locator('.ui-drawer').last();await drawer.waitFor({state:'visible'});await drawer.locator('details').evaluate(element=>{element.open=true});const values=await drawer.locator('select option').evaluateAll(options=>options.map(option=>option.value));if(JSON.stringify(values)!==JSON.stringify(['admin','member']))failures.push({message:'administrator invite offered roles outside server capabilities',data:values});if(!await drawer.getByText(complianceNote,{exact:true}).count())failures.push({message:'administrator invite omitted the compliance owner-only note',data:{locale,note:complianceNote}});await checkComplianceNoteLayout(drawer,{en:'Can use chat, projects, skills, and allowed models.','zh-TW':'可使用對話、專案、技能及群組允許的模型。',ja:'チャット、プロジェクト、スキル、許可されたモデルを利用できます。'}[locale]);
  }else if(state==='edit-member'){
    await page.locator('.ui-admin tbody tr').filter({hasText:'Workspace Member'}).click();await page.locator('.ui-drawer').waitFor({state:'visible'});await page.locator('.ui-record-buttons button').filter({hasText:{en:'Edit user','zh-TW':'編輯使用者',ja:'ユーザーを編集'}[locale]}).click();const drawer=page.locator('.ui-drawer').last();await drawer.waitFor({state:'visible'});const values=await drawer.locator('select').last().locator('option').evaluateAll(options=>options.map(option=>option.value));if(JSON.stringify(values)!==JSON.stringify(['admin','member']))failures.push({message:'administrator member edit offered roles outside server capabilities',data:values});if(!await drawer.getByText(complianceNote,{exact:true}).count())failures.push({message:'administrator member edit omitted the compliance owner-only note',data:{locale,note:complianceNote}});await checkComplianceNoteLayout(drawer);
  }
  const detail=await inspect({locale,mode,density,viewport,screen:`admin-users-admin-${state}`,drawer:false,adminKey:'users'}),errors=structuredClone(shotErrors);failures.push(...assertions(detail,errors),...await controlGeometryFailures());const stem=[locale,mode,density,viewport.name,'admin-users-admin-persona',state].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{...detail,rows},errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});adminPersona='owner';
}

async function localizedRefusalShots(locale,viewport){
  const mode='light',density='comfortable',expected=refusalText[locale];
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);

  shotErrors={console:[],page:[],request:[],api:[]};failNextUsersLoad=true;
  await page.goto(`${base}/admin/users`,{waitUntil:'networkidle'});const loadAlert=page.locator('.ui-admin .ui-error[role="alert"]');await loadAlert.waitFor({state:'visible'});await settle('.ui-admin .ui-error');
  let text=await loadAlert.innerText(),failures=assertions(await inspect({locale,mode,density,viewport,screen:'admin-users-load-failure',drawer:false,adminKey:'users'}),{...structuredClone(shotErrors),console:[]});
  if(!text.includes(expected.load)||text.includes('SERVER-TEXT-SENTINEL'))failures.push({message:'admin load failure did not use localized safe text',data:{locale,text,expected:expected.load}});
  let stem=[locale,mode,density,viewport.name,'admin-load-failure'].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{text},errors:structuredClone(shotErrors),failures});for(const failure of failures)report.failures.push({shot:stem,...failure});

  shotErrors={console:[],page:[],request:[],api:[]};await page.goto(`${base}/admin/users`,{waitUntil:'networkidle'});await settle('.ui-admin h1');await page.locator('.ui-page-actions .ui-primary').click();const drawer=page.locator('.ui-drawer').last();await drawer.waitFor({state:'visible'});await drawer.locator('input[type="email"]').fill('taken@example.test');await drawer.locator('input:not([type="email"])').first().fill('Existing User');refuseNextInvitation=true;await drawer.locator('form .ui-primary').click();const inviteAlert=drawer.locator('.ui-inline-error[role="alert"]');await inviteAlert.waitFor({state:'visible'});await settle('.ui-inline-error');
  text=await inviteAlert.innerText();failures=assertions(await inspect({locale,mode,density,viewport,screen:'admin-invitation-conflict',drawer:false,adminKey:'users'}),{...structuredClone(shotErrors),console:[]});if(!text.includes(expected.invite)||text.includes('SERVER-TEXT-SENTINEL'))failures.push({message:'invitation conflict did not use localized safe text',data:{locale,text,expected:expected.invite}});
  stem=[locale,mode,density,viewport.name,'admin-invitation-conflict'].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{text},errors:structuredClone(shotErrors),failures});for(const failure of failures)report.failures.push({shot:stem,...failure});

  shotErrors={console:[],page:[],request:[],api:[]};await page.goto(`${base}/chat`,{waitUntil:'networkidle'});await settle('.ui-empty');await page.locator('.ui-composer textarea').fill('Test the budget refusal.');refuseNextChatBudget=true;await page.locator('.ui-send-button').click();const budgetAlert=page.locator('.ui-response-row .ui-receipt[role="alert"]');await budgetAlert.waitFor({state:'visible'});await settle('.ui-response-row .ui-receipt');text=await budgetAlert.innerText();failures=assertions(await inspect({locale,mode,density,viewport,screen:'chat-budget-refusal',drawer:false}),{...structuredClone(shotErrors),console:[]});if(!text.includes(expected.budget)||text.includes('SERVER-TEXT-SENTINEL'))failures.push({message:'chat budget refusal did not use localized safe text',data:{locale,text,expected:expected.budget}});if(await budgetAlert.locator('button').count())failures.push({message:'non-retryable budget refusal showed a Retry button',data:{locale,text}});
  stem=[locale,mode,density,viewport.name,'chat-budget-refusal'].join('-');await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{text},errors:structuredClone(shotErrors),failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function liveGatingShot(locale){
  const viewport=viewports[2],mode='light',density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await settle('.ui-entry');
  await page.locator('.ui-composer textarea').fill('Audit the live checking checkpoint.');holdChatRun=true;await page.locator('.ui-send-button').click();await page.locator('[data-stamp-kind="checking"]').waitFor({state:'visible'});await settle('[data-stamp-kind="checking"]');
  const detail=await inspect({locale,mode,density,viewport,screen:'live-gating',drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors),stem=[locale,mode,density,viewport.name,'live-gating'].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail,errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});holdChatRun=false;
}

const liveGateText={
  en:{block:'Message not sent',warn:'Review and revise the message, or send it only if you are authorized to proceed.',approval:'Review required',responseBlock:'Response withheld',providerRefusal:'The selected provider is not available to your account. Choose another provider or contact your administrator.',providerOutage:'The AI provider is unavailable. Try again later.',rateLimit:'Too many requests were made. Wait a moment and try again.',proxy:'The service is unavailable. Try again later.',retry:'Try again'},
  'zh-TW':{block:'訊息未傳送',warn:'請檢視並修改訊息；僅在您獲授權的情況下選擇仍要傳送。',approval:'需要審核',responseBlock:'回覆未顯示',providerRefusal:'您的帳號無法使用所選供應商。請選擇其他供應商或聯絡管理員。',providerOutage:'AI 供應商目前無法使用。請稍後再試。',rateLimit:'要求次數過多。請稍候再試。',proxy:'服務目前無法使用。請稍後再試。',retry:'再試一次'},
  ja:{block:'メッセージは送信されませんでした',warn:'内容を確認して修正してください。送信を続行できる権限をお持ちの場合に限り、そのまま送信してください。',approval:'レビューが必要です',responseBlock:'応答は表示されませんでした',providerRefusal:'選択したプロバイダーはこのアカウントで利用できません。別のプロバイダーを選択するか、管理者にお問い合わせください。',providerOutage:'AI プロバイダーを利用できません。しばらくしてから、もう一度お試しください。',rateLimit:'リクエストが多すぎます。少し待ってから、もう一度お試しください。',proxy:'サービスを利用できません。しばらくしてから、もう一度お試しください。',retry:'再試行'},
};
const forbiddenLiveGateText=['SERVER-TEXT-SENTINEL','Blocked by policy','Approval is required','Confirmation is required','The request was blocked by policy','The response was withheld by policy','The selected provider is unavailable'];

async function liveGateChecks(){
  const mode='light',density='comfortable';
  for(const locale of locales)for(const viewport of [viewports[2],viewports[0]])for(const kind of ['block','warn','approval','response-block','provider-refusal','provider-outage','rate-limit','proxy-502']){
    const shot=[locale,mode,density,viewport.name,'live-gate',kind].join('-'),failures=[],caseErrors={console:[],page:[],request:[],api:[]};
    const check=(condition,message,data)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}};
    const runId=`live-${kind}`,assistantId=`assistant-${kind}`;
    const run={id:runId,conversationId:'conv-1',userMessageId:`user-${kind}`,assistantMessageId:['response-block','provider-refusal','provider-outage'].includes(kind)?assistantId:null,status:kind==='approval'?'awaiting_approval':'queued',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:now};
    const gateNotice=(direction,action,extra={})=>({event:'gate.notice',data:{runId,direction,action,decisionId:`decision-${kind}`,protectedItemCount:0,message:'SERVER-TEXT-SENTINEL',...extra}});
    const failed=(code,retryable,partialMessageId=null,details)=>({event:'run.failed',data:{runId,error:{code,message:'SERVER-TEXT-SENTINEL',requestId:'visual-live-gate',retryable,...(details?{details}: {})},partialMessageId}});
    const events=[{event:'run.created',data:{run}},{event:'run.status',data:{runId,status:'gating'}}];
    let selector,expected;
    if(kind==='block'){events.push(gateNotice('outbound','block'),failed('GATE_BLOCKED',false));selector='section.ui-receipt[data-receipt-kind="block"]:not([hidden])';expected=liveGateText[locale].block;}
    else if(kind==='warn'){events.push(gateNotice('outbound','warn',{confirmationToken:'confirmation-token'}),{event:'run.status',data:{runId,status:'awaiting_confirmation'}});selector='.ui-modal[role="dialog"]';expected=liveGateText[locale].warn;}
    else if(kind==='approval'){events.push(gateNotice('outbound','require_approval',{approvalId:'approval-live'}),{event:'run.status',data:{runId,status:'awaiting_approval'}});selector='section.ui-receipt[data-receipt-kind="require_approval"]:not([hidden])';expected=liveGateText[locale].approval;}
    else if(kind==='response-block'){
      events.push({event:'run.status',data:{runId,status:'streaming'}},{event:'message.created',data:{runId,message:{id:assistantId,conversationId:'conv-1',parentMessageId:null,role:'assistant',content:'',modelId:model.id,provider:model.provider,createdAt:now,inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1}}},{event:'assistant.delta',data:{runId,messageId:assistantId,index:0,text:'text released before inbound refusal'}},gateNotice('inbound','block'),failed('GATE_BLOCKED',false,assistantId));selector='section.ui-receipt[data-receipt-kind="withheld"]';expected=liveGateText[locale].responseBlock;
    }else if(kind==='provider-refusal'){events.push(failed('PROVIDER_UNAVAILABLE',false,assistantId,{reason:'chat_provider_not_allowed'}));selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';expected=liveGateText[locale].providerRefusal;
    }else if(kind==='provider-outage'){events.push(failed('PROVIDER_UNAVAILABLE',true,assistantId));selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';expected=liveGateText[locale].providerOutage;
    }else if(kind==='rate-limit'){selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';expected=liveGateText[locale].rateLimit;
    }else{selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';expected=liveGateText[locale].proxy;}
    const body=events.map((event,index)=>`id: ${index+1}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join('');
    const liveContext=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},colorScheme:'light'}),livePage=await liveContext.newPage();
    livePage.on('console',message=>{if(message.type()==='error')caseErrors.console.push(message.text())});
    livePage.on('pageerror',error=>caseErrors.page.push(String(error)));
    livePage.on('requestfailed',request=>{const reason=request.failure()?.errorText??'unknown';if(!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason))caseErrors.request.push({url:request.url(),reason})});
    const chatRequests=[];await livePage.route('**/api/v1/**',async route=>{
      const request=route.request(),url=new URL(request.url()),respond=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/v1/auth/me')return respond({...me,preferences:{density,colorMode:mode,locale}});
      if(url.pathname==='/api/v1/me/preferences')return respond({...preference,density,colorMode:mode,locale});
      if(url.pathname.startsWith('/api/v1/chat/runs')&&request.method()==='POST'){
        chatRequests.push({path:url.pathname,body:request.postDataJSON(),key:request.headers()['idempotency-key']});
        if(chatRequests.length>1)return route.fulfill({status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8'},body:`id: 1\nevent: run.status\ndata: ${JSON.stringify({runId:'retry-run',status:'awaiting_confirmation'})}\n\n`});
        if(kind==='rate-limit')return route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:{code:'RATE_LIMITED',message:'SERVER-TEXT-SENTINEL',requestId:'visual-live-gate',retryable:true}})});
        if(kind==='proxy-502')return route.fulfill({status:502,contentType:'text/plain',body:'SERVER-TEXT-SENTINEL'});
        return route.fulfill({status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'},body});
      }
      if(kind==='approval'&&url.pathname===`/api/v1/chat/runs/${runId}`&&request.method()==='GET')return respond({run:{...run,status:'awaiting_approval'}});
      return routeApi(route);
    });
    try{
      await livePage.goto(base,{waitUntil:'domcontentloaded'});
      await livePage.evaluate(locale=>{localStorage.setItem('app.locale.v1',locale);localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))},locale);
      await livePage.goto(`${base}/chat`,{waitUntil:'networkidle'});
      await livePage.locator('.ui-composer textarea').fill(`Exercise live gate ${kind}.`);await livePage.locator('.ui-send-button').click();
      const target=livePage.locator(selector).first();await target.waitFor({state:'visible',timeout:4_000});await livePage.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
      const documentText=await livePage.locator('html').evaluate(element=>element.textContent??''),targetText=await target.innerText(),occurrences=documentText.split(expected).length-1;
      for(const forbidden of forbiddenLiveGateText)check(!documentText.includes(forbidden),'live gate exposed server or generic English text',{locale,kind,forbidden,documentText});
      check(targetText.includes(expected),'live gate omitted its localized catalogue text',{locale,kind,expected,targetText});
      check(occurrences===1,'live refusal text did not appear exactly once',{locale,kind,expected,occurrences});
      const retryable=['provider-outage','rate-limit','proxy-502'].includes(kind),retryButton=target.getByRole('button',{name:liveGateText[locale].retry,exact:true}),retryButtons=await retryButton.count();check(retryButtons===(retryable?1:0),'Retry presence did not match the failure rule',{locale,kind,retryButtons});
      if(kind!=='warn'){const boxes=await livePage.evaluate(selector=>{const card=document.querySelector(selector),composer=document.querySelector('.ui-composer-dock');if(!card||!composer)return null;return{cardBottom:card.getBoundingClientRect().bottom,composerTop:composer.getBoundingClientRect().top};},selector);check(boxes&&boxes.cardBottom<=boxes.composerTop,'the whole live card is not above the composer',{locale,kind,boxes});}
      await livePage.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});
      if(retryable){await retryButton.click();for(let attempt=0;attempt<40&&chatRequests.length<2;attempt++)await livePage.waitForTimeout(25);const [first,retried]=chatRequests;check(Boolean(retried),'Retry sent no request',{locale,kind,chatRequests});if(retried){const regenerate=kind==='provider-outage';check(retried.path===(regenerate?'/api/v1/chat/runs/regenerate':'/api/v1/chat/runs'),'Retry used the wrong path',{kind,retried});check((regenerate?retried.body.messageId===assistantId:!('messageId' in retried.body)),'Retry used the wrong messageId',{kind,retried});check(regenerate||kind==='rate-limit'?retried.key!==first.key:retried.key===first.key,'Retry used the wrong idempotency identity',{kind,first,retried});}}
      if(kind==='rate-limit')caseErrors.console=caseErrors.console.filter(message=>!message.includes('429 (Too Many Requests)'));
      if(kind==='proxy-502')caseErrors.console=caseErrors.console.filter(message=>!message.includes('502 (Bad Gateway)'));
      check(caseErrors.console.length===0,'console errors',caseErrors.console);check(caseErrors.page.length===0,'page errors',caseErrors.page);check(caseErrors.request.length===0,'request errors',caseErrors.request);
      report.shots.push({name:shot,detail:{locale,kind,selector,targetText,chatRequests},errors:caseErrors,failures});
    }catch(error){check(false,'live gate check failed',{locale,kind,error:String(error)});report.shots.push({name:shot,detail:{locale,kind,selector},errors:caseErrors,failures})}
    finally{await liveContext.close()}
  }
  await bottomPinChecks();
}

async function bottomPinChecks(){
  const locale='en',mode='light',density='comfortable',cases=['outbound-block','approval','generic-failure','interruption'];
  for(const viewport of [viewports[2],viewports[0]])for(const kind of cases){
    const runId=`pin-${viewport.name}-${kind}`,assistantId=`assistant-${runId}`,prompt=`Pin check ${viewport.name} ${kind}`,shot=[locale,mode,density,viewport.name,'bottom-pin',kind].join('-'),failures=[],caseErrors={console:[],page:[],request:[],api:[]};
    const check=(condition,message,data)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}};
    const run={id:runId,conversationId:'conv-1',userMessageId:`user-${runId}`,assistantMessageId:kind==='generic-failure'?assistantId:null,status:'queued',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:now};
    const opened=[{event:'run.created',data:{run}},{event:'run.status',data:{runId,status:'gating'}}],notice=(action,extra={})=>({event:'gate.notice',data:{runId,direction:'outbound',action,decisionId:`decision-${runId}`,protectedItemCount:0,message:'SERVER-TEXT-SENTINEL',...extra}}),failed={event:'run.failed',data:{runId,error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'bottom-pin',retryable:true},partialMessageId:assistantId}};
    let events,selector;
    if(kind==='outbound-block'){events=[...opened,notice('block'),{event:'run.failed',data:{runId,error:{code:'GATE_BLOCKED',message:'SERVER-TEXT-SENTINEL',requestId:'bottom-pin',retryable:false},partialMessageId:null}}];selector='section.ui-receipt[data-receipt-kind="block"]:not([hidden])';}
    else if(kind==='approval'){events=[...opened,notice('require_approval',{approvalId:`approval-${runId}`}),{event:'run.status',data:{runId,status:'awaiting_approval'}}];selector='section.ui-receipt[data-receipt-kind="require_approval"]:not([hidden])';}
    else if(kind==='generic-failure'){events=[...opened,failed];selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';}
    else{events=opened;selector='.ui-response-row section.ui-receipt[data-receipt-kind="failure"]';}
    const body=events.map((event,index)=>`id: ${index+1}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''),liveContext=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},colorScheme:'light'}),livePage=await liveContext.newPage();
    livePage.on('console',message=>{if(message.type()==='error')caseErrors.console.push(message.text())});livePage.on('pageerror',error=>caseErrors.page.push(String(error)));livePage.on('requestfailed',request=>{const reason=request.failure()?.errorText??'unknown';if(!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason))caseErrors.request.push({url:request.url(),reason})});
    let releaseResponse=()=>{},responseGate=new Promise(resolve=>{releaseResponse=resolve});
    await livePage.route('**/api/v1/**',async route=>{
      const request=route.request(),url=new URL(request.url()),respond=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
      if(url.pathname==='/api/v1/auth/me')return respond({...me,preferences:{density,colorMode:mode,locale}});
      if(url.pathname==='/api/v1/me/preferences')return respond({...preference,density,colorMode:mode,locale});
      if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'){await responseGate;return route.fulfill({status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'},body});}
      if(kind==='approval'&&url.pathname===`/api/v1/chat/runs/${runId}`&&request.method()==='GET')return respond({run:{...run,status:'awaiting_approval'}});
      return routeApi(route);
    });
    try{
      await livePage.goto(base,{waitUntil:'domcontentloaded'});await livePage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))});await livePage.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await livePage.locator('.ui-entry').first().waitFor({state:'visible'});
      const list=livePage.locator('.ui-timeline');await list.evaluate(element=>{element.scrollTop=element.scrollHeight;element.dispatchEvent(new Event('scroll'))});await livePage.waitForTimeout(50);await livePage.locator('.ui-composer textarea').fill(prompt);await livePage.locator('.ui-send-button').click();await livePage.getByText(prompt,{exact:true}).waitFor({state:'visible'});await list.evaluate(element=>{element.scrollTop=element.scrollHeight;element.dispatchEvent(new Event('scroll'))});await livePage.waitForTimeout(50);releaseResponse();
      const target=livePage.locator(selector).last();await target.waitFor({state:'visible',timeout:4_000});await livePage.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
      const geometry=await livePage.evaluate(selector=>{const cards=[...document.querySelectorAll(selector)],card=cards.at(-1),composer=document.querySelector('.ui-composer'),list=document.querySelector('.ui-timeline'),box=element=>{if(!element)return null;const rect=element.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom}};return{card:box(card),composer:box(composer),list:box(list),scrollTop:list?.scrollTop??null,maxScroll:list?list.scrollHeight-list.clientHeight:null};},selector);
      check(geometry.scrollTop!==null&&geometry.maxScroll!==null&&Math.abs(geometry.maxScroll-geometry.scrollTop)<=2,'live card did not keep the long conversation pinned to the bottom',{viewport:viewport.name,kind,geometry});check(Boolean(geometry.card&&geometry.composer&&geometry.card.bottom<=geometry.composer.top+.5),'live card landed below the composer',{viewport:viewport.name,kind,geometry});
      await livePage.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});check(caseErrors.console.length===0,'console errors',caseErrors.console);check(caseErrors.page.length===0,'page errors',caseErrors.page);check(caseErrors.request.length===0,'request errors',caseErrors.request);report.shots.push({name:shot,detail:{viewport:viewport.name,kind,geometry},errors:caseErrors,failures});
    }catch(error){check(false,'bottom pin check failed',{viewport:viewport.name,kind,error:String(error)});report.shots.push({name:shot,detail:{viewport:viewport.name,kind},errors:caseErrors,failures})}finally{releaseResponse();await liveContext.close()}
  }

  const viewport=viewports[2],kind='generic-failure-scrolled-up',runId='pin-scrolled-up',assistantId='assistant-pin-scrolled-up',prompt='Pin check scrolled up',shot=[locale,mode,density,viewport.name,'bottom-pin',kind].join('-'),failures=[],caseErrors={console:[],page:[],request:[],api:[]},check=(condition,message,data)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}},run={id:runId,conversationId:'conv-1',userMessageId:`user-${runId}`,assistantMessageId:assistantId,status:'queued',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:now},events=[{event:'run.created',data:{run}},{event:'run.status',data:{runId,status:'gating'}},{event:'run.failed',data:{runId,error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'bottom-pin',retryable:true},partialMessageId:assistantId}}],body=events.map((event,index)=>`id: ${index+1}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''),liveContext=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},colorScheme:'light'}),livePage=await liveContext.newPage();
  livePage.on('console',message=>{if(message.type()==='error')caseErrors.console.push(message.text())});livePage.on('pageerror',error=>caseErrors.page.push(String(error)));livePage.on('requestfailed',request=>{const reason=request.failure()?.errorText??'unknown';if(!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason))caseErrors.request.push({url:request.url(),reason})});let releaseResponse=()=>{},responseGate=new Promise(resolve=>{releaseResponse=resolve});
  await livePage.route('**/api/v1/**',async route=>{const request=route.request(),url=new URL(request.url()),respond=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});if(url.pathname==='/api/v1/auth/me')return respond({...me,preferences:{density,colorMode:mode,locale}});if(url.pathname==='/api/v1/me/preferences')return respond({...preference,density,colorMode:mode,locale});if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'){await responseGate;return route.fulfill({status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8'},body});}return routeApi(route);});
  try{
    await livePage.goto(base,{waitUntil:'domcontentloaded'});await livePage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))});await livePage.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await livePage.locator('.ui-entry').first().waitFor({state:'visible'});const list=livePage.locator('.ui-timeline');await list.evaluate(element=>{element.scrollTop=element.scrollHeight;element.dispatchEvent(new Event('scroll'))});await livePage.locator('.ui-composer textarea').fill(prompt);await livePage.locator('.ui-send-button').click();await livePage.getByText(prompt,{exact:true}).waitFor({state:'visible'});await list.evaluate(element=>{const max=element.scrollHeight-element.clientHeight;element.scrollTop=Math.max(0,max-240);element.dispatchEvent(new Event('scroll'))});await livePage.waitForTimeout(50);const before=await list.evaluate(element=>({scrollTop:element.scrollTop,maxScroll:element.scrollHeight-element.clientHeight}));check(before.maxScroll-before.scrollTop>=200,'scrolled-up case did not move at least 200px from the bottom',before);releaseResponse();const target=livePage.locator('.ui-response-row section.ui-receipt[data-receipt-kind="failure"]').last();await target.waitFor({state:'visible',timeout:4_000});await livePage.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});const after=await list.evaluate(element=>({scrollTop:element.scrollTop,maxScroll:element.scrollHeight-element.clientHeight}));check(Math.abs(after.scrollTop-before.scrollTop)<=2,'a live card moved a reader who was scrolled up',{before,after});await livePage.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:shot,detail:{before,after},errors:caseErrors,failures});
  }catch(error){check(false,'scrolled-up bottom pin check failed',{error:String(error)});report.shots.push({name:shot,detail:null,errors:caseErrors,failures})}finally{releaseResponse();await liveContext.close()}
}

async function attachmentComposerShot(locale,viewport){
  const mode='light',density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/chat`,{waitUntil:'networkidle'});await settle('.ui-empty');
  await page.locator('.ui-composer input[type="file"]').setInputFiles([
    {name:'approved-evidence.pdf',mimeType:'application/pdf',buffer:Buffer.from('approved evidence')},
    {name:'restricted-evidence.pdf',mimeType:'application/pdf',buffer:Buffer.from('restricted evidence')},
  ]);
  await page.locator('.ui-upload-row.is-ready').filter({hasText:'approved-evidence.pdf'}).waitFor({state:'visible'});
  await page.locator('.ui-upload-row.is-rejected').filter({hasText:'restricted-evidence.pdf'}).waitFor({state:'visible'});
  await settle('.ui-upload-row');
  const detail=await inspect({locale,mode,density,viewport,screen:'composer-attachments',drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  const uploadState=await page.locator('.ui-upload-row').evaluateAll(rows=>rows.map(row=>({className:row.className,status:row.querySelector('.ui-upload-status')?.textContent?.trim(),name:row.querySelector('.ui-upload-name')?.textContent?.trim(),size:row.querySelector('.ui-upload-size')?.textContent?.trim(),reason:row.querySelector('.ui-upload-error')?.textContent?.trim()??''})));
  const approved=uploadState.find(row=>row.name==='approved-evidence.pdf'),restricted=uploadState.find(row=>row.name==='restricted-evidence.pdf');
  if(uploadState.length!==2||!approved?.className.includes('is-ready')||!restricted?.className.includes('is-rejected'))failures.push({message:'attachment outcomes are not paired with the requested files',data:uploadState});
  if(!restricted?.reason)failures.push({message:'rejected attachment has no reason line',data:uploadState});
  const conversationFeedbackVisible=await page.locator('.ui-conversation-feedback').isVisible();
  if(conversationFeedbackVisible)failures.push({message:'attachment outcome leaked into the global conversation notice',data:null});
  if(viewport.width===390&&detail.composer?.overflow.length)failures.push({message:'attachment composer exceeds the 390px viewport',data:detail.composer.overflow});
  const stem=[locale,mode,density,viewport.name,'composer-attachments'].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{...detail,uploadState,conversationFeedbackVisible},errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function conversationFeedbackShot(viewport){
  const locale='en',mode='light',density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await settle('.ui-entry');
  if(viewport.width<1024){await page.locator('.ui-mobile-menu').click();await page.locator('.ui-sidebar.is-open').waitFor({state:'visible'});}
  await page.getByRole('button',{name:`Actions for ${conversation.title}`}).click();
  await page.getByRole('menuitem',{name:'Archive'}).click();
  await page.locator('.ui-conversation-feedback').waitFor({state:'visible'});await page.locator('.ui-archive-page').waitFor({state:'visible'});await settle('.ui-conversation-feedback');
  const detail=await inspect({locale,mode,density,viewport,screen:'conversation-feedback',drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  const noticePlacement=await page.locator('.ui-conversation-feedback').evaluate(notice=>{const topbar=document.querySelector('.ui-topbar'),noticeRect=notice.getBoundingClientRect(),topbarRect=topbar.getBoundingClientRect();return{notice:{left:noticeRect.left,right:noticeRect.right,top:noticeRect.top,bottom:noticeRect.bottom},topbar:{left:topbarRect.left,right:topbarRect.right,top:topbarRect.top,bottom:topbarRect.bottom},intersects:noticeRect.left<topbarRect.right&&noticeRect.right>topbarRect.left&&noticeRect.top<topbarRect.bottom&&noticeRect.bottom>topbarRect.top}});
  if(noticePlacement.intersects)failures.push({message:'conversation feedback overlaps the top bar',data:noticePlacement});
  const noticeCheck=await noticePlacementFailures();
  failures.push(...noticeCheck.failures,...await controlGeometryFailures());
  const stem=[locale,mode,density,viewport.name,'conversation-feedback'].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{...detail,noticePlacement,noticeColumn:noticeCheck.column},errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function conversationFeedbackChatShot(viewport){
  const locale='en',mode='light',density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await settle('.ui-entry');
  if(viewport.width<1024){await page.locator('.ui-mobile-menu').click();await page.locator('.ui-sidebar.is-open').waitFor({state:'visible'});}
  await page.getByRole('button',{name:`Actions for ${conversation.title}`}).click();
  await page.getByRole('menuitem',{name:'Unpin'}).click();
  await page.getByText('Conversation unpinned.',{exact:true}).waitFor({state:'visible'});
  if(viewport.width<1024){await page.keyboard.press('Escape');await page.locator('.ui-sidebar').waitFor({state:'hidden'});}
  await settle('.ui-conversation-feedback');
  const detail=await inspect({locale,mode,density,viewport,screen:'conversation-feedback-chat',drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  const noticeCheck=await noticePlacementFailures();
  failures.push(...noticeCheck.failures,...await controlGeometryFailures());
  const composerBox=await page.locator('.ui-composer').evaluate(element=>{const box=element.getBoundingClientRect();return{top:box.top,bottom:box.bottom,viewport:innerHeight}});
  if(composerBox.top<-.5||composerBox.bottom>composerBox.viewport+.5)failures.push({message:'conversation feedback pushed the composer outside the viewport',data:composerBox});
  const stem=[locale,mode,density,viewport.name,'conversation-feedback-chat'].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{...detail,composerBox,noticeColumn:noticeCheck.column},errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function conversationFeedbackSettingsShot(viewport){
  const locale='en',mode='light',density='comfortable';
  await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,density);shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/settings/general`,{waitUntil:'networkidle'});await settle('.ui-page');
  if(viewport.width<1024){await page.locator('.ui-mobile-menu').click();await page.locator('.ui-sidebar.is-open').waitFor({state:'visible'});}
  await page.getByRole('button',{name:`Actions for ${conversation.title}`}).click();
  await page.getByRole('menuitem',{name:'Unpin'}).click();
  await page.getByText('Conversation unpinned.',{exact:true}).waitFor({state:'visible'});
  if(viewport.width<1024){await page.keyboard.press('Escape');await page.locator('.ui-sidebar').waitFor({state:'hidden'});}
  await settle('.ui-conversation-feedback');
  const detail=await inspect({locale,mode,density,viewport,screen:'conversation-feedback-settings',drawer:false}),errors=structuredClone(shotErrors),failures=assertions(detail,errors);
  const noticeCheck=await noticePlacementFailures();
  failures.push(...noticeCheck.failures,...await controlGeometryFailures());
  const stem=[locale,mode,density,viewport.name,'conversation-feedback-settings'].join('-');
  await page.screenshot({path:`${out}/${stem}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:stem,detail:{...detail,noticeColumn:noticeCheck.column},errors,failures});for(const failure of failures)report.failures.push({shot:stem,...failure});
}

async function focusInteractionCheck(){
  const shot='focus-interactions',failures=[],timeout=4_000;
  let tests=0,passes=0;
  const check=(condition,message,data)=>{tests+=1;if(condition){passes+=1;return}const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})};
  const focusContext=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light'}),focusPage=await focusContext.newPage();
  let failUsers=false,usersPaged=false,failDashboard=false,failRetention=false,failViolations=false,violationsPaged=false,failChatStart=false,failChatStream=false,holdChat=false,holdTriage=false,markTriageStarted=()=>{},releaseTriage=()=>{},triageStarted=Promise.resolve(),triageVersion=4,providerEnabled=false,memberIds=['user-2'];
  let terms=[{term:'confidential roadmap',action:'block'},{term:'acquisition target',action:'warn'}],focusProject={id:'project-1',name:'Quarterly review',instructions:'Use approved sources.',fileCount:0,conversationCount:0,createdAt:now,updatedAt:now,version:1};
  let focusViolation={...violation};
  const termState=()=>({terms,counts:{flag:terms.filter(item=>item.action==='flag').length,warn:terms.filter(item=>item.action==='warn').length,redact:terms.filter(item=>item.action==='redact').length,block:terms.filter(item=>item.action==='block').length}});
  await focusPage.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}),fail=()=>respond({error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'focus-audit',retryable:true}},500);
    if(url.pathname==='/api/v1/admin/users'&&request.method()==='GET'){
      if(url.searchParams.has('group'))return respond({items:memberIds.map(userId=>userId==='user-3'?{...adminRecord,id:'user-3',displayName:'Jordan Park',email:'jordan@example.test',roles:['member'],actions:ownerActions}:{...adminRecord,id:'user-2',displayName:'Morgan Lee',email:'morgan@example.test',roles:['member'],actions:ownerActions}),nextCursor:null,total:memberIds.length});
      if(url.searchParams.has('search'))return respond({items:[{...adminRecord,id:'user-3',displayName:'Jordan Park',email:'jordan@example.test',roles:['member'],actions:ownerActions}],nextCursor:null,total:1});
      if(failUsers){failUsers=false;return fail()}
      if(usersPaged){const cursor=url.searchParams.get('cursor');if(cursor==='users-3')return respond({items:[{...adminRecord,id:'user-4',displayName:'Taylor Kim',email:'taylor@example.test',roles:['member'],actions:ownerActions}],nextCursor:null,total:3});if(cursor==='users-2')return respond({items:[{...adminRecord,id:'user-3',displayName:'Jordan Park',email:'jordan@example.test',roles:['member'],actions:ownerActions}],nextCursor:'users-3',total:3});return respond({items:[{...adminRecord,id:'user-2',displayName:'Morgan Lee',email:'morgan@example.test',roles:['member'],actions:ownerActions}],nextCursor:'users-2',total:3})}
      return respond({items:[{...adminRecord,id:'user-2',displayName:'Morgan Lee',email:'morgan@example.test',roles:['member'],actions:ownerActions}],nextCursor:null,total:1});
    }
    const membership=url.pathname.match(/^\/api\/v1\/admin\/groups\/group-1\/members\/(user-[23])$/u);
    if(membership){const userId=membership[1];if(request.method()==='PUT'&&!memberIds.includes(userId))memberIds.push(userId);if(request.method()==='DELETE')memberIds=memberIds.filter(id=>id!==userId);return respond({item:{id:userId}})}
    if(url.pathname==='/api/v1/admin/dashboard'&&failDashboard){failDashboard=false;return fail()}
    if(url.pathname==='/api/v1/admin/retention'&&request.method()==='GET'&&failRetention){failRetention=false;return fail()}
    if(url.pathname==='/api/v1/admin/violations/assignees')return respond({items:[{id:'user-2',name:'Morgan Lee',email:'morgan@example.test'}]});
    if(url.pathname==='/api/v1/admin/violations/violation-1'&&request.method()==='GET')return respond({item:focusViolation});
    if(url.pathname==='/api/v1/admin/violations'&&request.method()==='GET'){
      if(failViolations){failViolations=false;return fail()}
      if(violationsPaged){const cursor=url.searchParams.get('cursor');if(cursor==='violations-3')return respond({items:[{...focusViolation,id:'violation-3',name:'Third violation',displayName:'Third violation'}],nextCursor:null,total:3});if(cursor==='violations-2')return respond({items:[{...focusViolation,id:'violation-2',name:'Second violation',displayName:'Second violation'}],nextCursor:'violations-3',total:3});return respond({items:[focusViolation],nextCursor:'violations-2',total:3})}
      return respond({items:[focusViolation],nextCursor:null,total:1});
    }
    const triage=url.pathname.match(/^\/api\/v1\/admin\/violations\/violation-1\/(assign|status|notes|due)$/u);
    if(triage&&request.method()==='POST'){const body=request.postDataJSON(),kind=triage[1];if(holdTriage&&kind==='notes'){markTriageStarted();await new Promise(resolve=>{releaseTriage=resolve})}triageVersion+=1;focusViolation={...focusViolation,version:triageVersion,...(kind==='status'?{status:body.status,allowedTransitions:['in_review','resolved','dismissed']}:{}),...(kind==='assign'?{assigneeId:body.assigneeUserId}:{}),...(kind==='due'?{dueAt:body.dueAt}:{}),...(kind==='notes'?{comments:[{id:`comment-${triageVersion}`,author:'Admin User',createdAt:now,body:body.note}]}:{})};return respond({item:focusViolation})}
    if(url.pathname==='/api/v1/gate/approvals/approval-1/decision'&&request.method()==='POST'){const body=request.postDataJSON();return respond({id:'approval-1',status:body.decision==='approve'?'approved':'denied',releaseStatus:body.decision==='approve'?'queued':undefined,reason:body.reason})}
    if(url.pathname==='/api/v1/admin/custom-terms'){
      if(request.method()==='POST'){const body=request.postDataJSON();for(const term of body.terms)terms=[...terms.filter(item=>item.term!==term),{term,action:body.action}];return respond(termState())}
      if(request.method()==='DELETE'){terms=terms.filter(item=>item.term!==request.postDataJSON().term);return respond(termState())}
      return respond(termState());
    }
    if(url.pathname==='/api/v1/gate/rules/test'&&request.method()==='POST')return respond({action:'block',disposition:'block',matches:[],timings:{totalUs:1200}});
    if(url.pathname==='/api/v1/gate/rules/rule-1'&&request.method()==='PATCH')return respond({item:{id:'rule-1',updated_at:Date.parse(now)+1}});
    if(url.pathname==='/api/v1/assistants/draft-from-url'&&request.method()==='POST')return respond({name:'Generated assistant',description:'Generated safely.',systemPrompt:'Use approved sources.'});
    if(url.pathname==='/api/v1/budgets/budget-1'&&request.method()==='PATCH')return respond({item:{...adminRecord,id:'budget-1',...request.postDataJSON()}});
    if(url.pathname==='/api/v1/admin/providers'&&request.method()==='GET')return respond({items:[{...adminRecord,id:'openai',provider:'openai',groupAccess:[{groupId:'group-1',enabled:providerEnabled,version:1}]}],nextCursor:null,total:1});
    if(url.pathname==='/api/v1/admin/groups/group-1/providers/openai'&&request.method()==='PUT'){providerEnabled=Boolean(request.postDataJSON().enabled);return respond({item:{enabled:providerEnabled}})}
    if(url.pathname==='/api/v1/projects/project-1'&&request.method()==='GET')return respond(focusProject);
    if(url.pathname==='/api/v1/projects/project-1'&&request.method()==='PATCH'){focusProject={...focusProject,...request.postDataJSON(),version:focusProject.version+1};return respond(focusProject)}
    if((url.pathname==='/api/v1/projects/project-1/files'||url.pathname==='/api/v1/projects/project-1/conversations')&&request.method()==='GET')return respond(pageOf([]));
    if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'&&failChatStart){failChatStart=false;return respond({error:{code:'PROVIDER_UNAVAILABLE',message:'SERVER-TEXT-SENTINEL',requestId:'focus-audit',retryable:true}},503)}
    if(url.pathname==='/api/v1/chat/runs'&&request.method()==='POST'&&failChatStream){failChatStream=false;const runId='run-focus-failed',run={id:runId,conversationId:'conv-1',userMessageId:'user-focus',assistantMessageId:'assistant-focus',status:'queued',streamUrl:`/api/v1/chat/runs/${runId}/events`,createdAt:now},events=[{event:'run.created',data:{run}},{event:'run.status',data:{runId,status:'gating'}},{event:'run.failed',data:{runId,error:{code:'INTERNAL_ERROR',message:'SERVER-TEXT-SENTINEL',requestId:'focus-audit',retryable:true},partialMessageId:'assistant-focus'}}];return route.fulfill({status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'},body:events.map((event,index)=>`id: ${index+1}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join('')})}
    if((url.pathname==='/api/v1/chat/runs'||url.pathname==='/api/v1/chat/runs/regenerate')&&request.method()==='POST'&&holdChat)return new Promise(()=>{});
    return routeApi(route);
  });
  const frames=()=>focusPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const active=()=>focusPage.evaluate(()=>{const element=document.activeElement;return{body:element===document.body,tag:element?.tagName??null,className:typeof element?.className==='string'?element.className:null,text:(element?.getAttribute?.('aria-label')||element?.textContent||'').trim().replace(/\s+/gu,' ').slice(0,80)}});
  const assertLocator=async(name,locator)=>{await frames();const detail=await active();const matches=await locator.evaluate(element=>document.activeElement===element).catch(()=>false);check(matches&&!detail.body,name,detail)};
  const assertHandle=async(name,handle)=>{await frames();const detail=await active(),state=await handle.evaluate(element=>({connected:element.isConnected,active:document.activeElement===element})).catch(()=>({connected:false,active:false}));check(state.connected&&state.active&&!detail.body,name,{...detail,...state})};
  const press=async locator=>{await locator.focus({timeout});const handle=await locator.elementHandle();await focusPage.keyboard.press('Enter');return handle};
  const openAdmin=async path=>{await focusPage.goto(`${base}${path}`,{waitUntil:'networkidle',timeout});await focusPage.locator('.ui-admin h1').waitFor({state:'visible',timeout});await focusPage.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})};
  const rows=()=>focusPage.locator('.ui-admin main tbody tr');
  const run=async(name,action)=>{try{await action()}catch(error){check(false,name,{error:String(error)})}};
  const region=()=>focusPage.locator('.ui-admin main [role="region"][tabindex="0"]').first();

  await focusPage.goto(base,{waitUntil:'domcontentloaded',timeout});await focusPage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))});
  await run('focus: Users retry moves focus to its region',async()=>{failUsers=true;await openAdmin('/admin/users');const retry=focusPage.locator('.ui-error button');await retry.waitFor({state:'visible',timeout});await press(retry);await rows().first().waitFor({state:'visible',timeout});await assertLocator('focus: Users retry moves focus to its region',region())});
  await run('focus: GenericScreen sort keeps the same header button',async()=>{await openAdmin('/admin/audit');const sort=focusPage.locator('.ui-admin main thead button').first();const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/audit/events'&&new URL(item.url()).searchParams.has('sort'),{timeout}),handle=await press(sort);await response;await assertHandle('focus: GenericScreen sort keeps the same header button',handle)});
  await run('focus: Users Next stays focused while another page exists',async()=>{usersPaged=true;await openAdmin('/admin/users');const next=focusPage.locator('.ui-admin main .ui-pagination button');const handle=await press(next);await focusPage.getByText('Jordan Park',{exact:true}).waitFor({state:'visible',timeout});await assertHandle('focus: Users Next stays focused while another page exists',handle);await press(next);await focusPage.getByText('Taylor Kim',{exact:true}).waitFor({state:'visible',timeout});await assertLocator('focus: Users final page moves focus to its region',region());usersPaged=false});
  await run('focus: closeAfterMutation returns to the retained Users row',async()=>{await openAdmin('/admin/users');const row=rows().filter({hasText:'Morgan Lee'}),handle=await press(row);const drawer=focusPage.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});await press(drawer.getByRole('button',{name:'Force logout',exact:true}));const dialog=focusPage.locator('.ui-dialog');await dialog.waitFor({state:'visible',timeout});const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/users/user-2/force-logout',{timeout});await press(dialog.locator('button').last());await response;await drawer.waitFor({state:'detached',timeout});await assertHandle('focus: closeAfterMutation returns to the retained Users row',handle)});
  await run('focus: Workspace settings Save stays focused',async()=>{await openAdmin('/admin/settings');const form=focusPage.locator('.ui-settings-form form');await form.locator('input[type="number"]').first().fill('121');const save=form.locator('button.ui-primary'),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/settings'&&item.request().method()==='PATCH',{timeout}),handle=await press(save);await response;await assertHandle('focus: Workspace settings Save stays focused',handle)});
  await run('focus: Overview retry moves focus to its region',async()=>{failDashboard=true;await openAdmin('/admin');const retry=focusPage.locator('.ui-error button');await retry.waitFor({state:'visible',timeout});await press(retry);await focusPage.locator('.ui-kpis').waitFor({state:'visible',timeout});await assertLocator('focus: Overview retry moves focus to its region',region())});
  await run('focus: Retention periods retry moves focus to its region',async()=>{failRetention=true;await openAdmin('/admin/retention');const retry=focusPage.locator('.ui-error button').first();await retry.waitFor({state:'visible',timeout});await press(retry);await focusPage.locator('.ui-admin main .ui-table-wrap').first().waitFor({state:'visible',timeout});await assertLocator('focus: Retention periods retry moves focus to its region',region())});
  await run('focus: Violations sort keeps the same header button',async()=>{focusViolation={...violation};await openAdmin('/admin/violations');const sort=focusPage.locator('.ui-admin main thead button').first(),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/violations'&&new URL(item.url()).searchParams.has('sort'),{timeout}),handle=await press(sort);await response;await assertHandle('focus: Violations sort keeps the same header button',handle)});
  await run('focus: Violations Next stays focused while another page exists',async()=>{violationsPaged=true;await openAdmin('/admin/violations');const next=focusPage.locator('.ui-admin main .ui-pagination button'),second=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/violations'&&new URL(item.url()).searchParams.get('cursor')==='violations-2',{timeout});let handle=await press(next);await second;await assertHandle('focus: Violations Next stays focused while another page exists',handle);const third=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/violations'&&new URL(item.url()).searchParams.get('cursor')==='violations-3',{timeout});await press(next);await third;await assertLocator('focus: Violations final page moves focus to its region',region());violationsPaged=false});
  await run('focus: Violations retry moves focus to its region',async()=>{failViolations=true;await openAdmin('/admin/violations');const retry=focusPage.locator('.ui-error button');await retry.waitFor({state:'visible',timeout});await press(retry);await rows().first().waitFor({state:'visible',timeout});await assertLocator('focus: Violations retry moves focus to its region',region())});
  const openViolation=async()=>{focusViolation={...violation,version:++triageVersion};await openAdmin('/admin/violations');const row=rows().first(),rowHandle=await press(row),drawer=focusPage.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});await drawer.locator('.ui-decision').waitFor({state:'visible',timeout});return{row,rowHandle,drawer}};
  await run('focus: Approve moves focus to release state',async()=>{const {drawer}=await openViolation();await press(drawer.getByRole('button',{name:'Approve and release',exact:true}));const dialog=focusPage.locator('form.ui-dialog');await dialog.locator('textarea').fill('Reviewed the evidence and approved release.');const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/gate/approvals/approval-1/decision',{timeout});await press(dialog.locator('footer button').last());await response;await dialog.waitFor({state:'detached',timeout});await assertLocator('focus: Approve moves focus to release state',drawer.locator('.ui-release-state'))});
  await run('focus: Deny returns focus to the retained violation row',async()=>{const {drawer,rowHandle}=await openViolation();await press(drawer.getByRole('button',{name:'Deny',exact:true}));const dialog=focusPage.locator('form.ui-dialog');await dialog.locator('textarea').fill('The evidence does not support releasing this.');const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/gate/approvals/approval-1/decision',{timeout});await press(dialog.locator('footer button').last());await response;await drawer.waitFor({state:'detached',timeout});await assertHandle('focus: Deny returns focus to the retained violation row',rowHandle)});
  const triage=async(name,prepare,buttonTarget,target)=>run(name,async()=>{const {drawer}=await openViolation();await prepare(drawer);const button=typeof buttonTarget==='function'?buttonTarget(drawer):drawer.getByRole('button',{name:buttonTarget,exact:true}),response=focusPage.waitForResponse(item=>/^\/api\/v1\/admin\/violations\/violation-1\/(assign|status|notes)$/u.test(new URL(item.url()).pathname),{timeout});void response.catch(()=>{});const handle=await press(button);await response;if(target==='same')await assertHandle(name,handle);else await assertLocator(name,drawer.locator(target))});
  await run('focus: Add note remains focused while busy and then moves to the note field',async()=>{const {drawer}=await openViolation();await drawer.locator('textarea[aria-labelledby="ui-violation-notes"]').fill('Checked with the data owner.');const button=drawer.getByRole('button',{name:'Add note',exact:true});triageStarted=new Promise(resolve=>{markTriageStarted=resolve});holdTriage=true;const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/notes'),{timeout}),handle=await press(button);await triageStarted;await assertHandle('focus: Add note remains focused while busy',handle);releaseTriage();holdTriage=false;await response;await assertLocator('focus: Add note moves focus to the note field',drawer.locator('textarea[aria-labelledby="ui-violation-notes"]'))});
  await triage('focus: Update status moves focus to the status select',drawer=>drawer.locator('select[aria-labelledby="ui-violation-workflow"]').selectOption('in_review'),'Update status','select[aria-labelledby="ui-violation-workflow"]');
  await triage('focus: Assignment Save stays on its button',drawer=>drawer.locator('.ui-triage-controls select').first().selectOption('user-2'),drawer=>drawer.locator('.ui-triage-controls section').first().getByRole('button'),'same');
  await run('focus: refused-send retry moves focus to the composer',async()=>{await focusPage.goto(`${base}/chat`,{waitUntil:'networkidle',timeout});await focusPage.locator('.ui-composer textarea').fill('Retry focus');failChatStart=true;await focusPage.locator('.ui-send-button').click();const retry=focusPage.locator('section.ui-receipt[role="alert"] button');await retry.waitFor({state:'visible',timeout});holdChat=true;const request=focusPage.waitForRequest(item=>new URL(item.url()).pathname==='/api/v1/chat/runs'&&item.method()==='POST',{timeout});await press(retry);await request;await assertLocator('focus: refused-send retry moves focus to the composer',focusPage.locator('.ui-composer textarea'));holdChat=false});
  await run('focus: run.failed retry moves focus to the composer',async()=>{await focusPage.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle',timeout});await focusPage.locator('.ui-composer textarea').fill('Regenerate focus');failChatStream=true;await focusPage.locator('.ui-send-button').click();const retry=focusPage.locator('section.ui-receipt[data-receipt-kind="failure"] button');await retry.waitFor({state:'visible',timeout});holdChat=true;const request=focusPage.waitForRequest(item=>new URL(item.url()).pathname==='/api/v1/chat/runs/regenerate'&&item.method()==='POST',{timeout});await press(retry);await request;await assertLocator('focus: run.failed retry moves focus to the composer',focusPage.locator('.ui-composer textarea'));holdChat=false});

  await run('focus: group member Add moves focus to the new member Remove button',async()=>{memberIds=['user-2'];await openAdmin('/admin/groups');await press(rows().first());const members=focusPage.locator('.ui-members');await members.waitFor({state:'visible',timeout});await members.locator('input[type="search"]').fill('Jordan');await press(members.getByRole('button',{name:'Find users',exact:true}));const add=members.locator('.ui-member-results').getByRole('button',{name:'Add',exact:true}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/members/user-3')&&item.request().method()==='PUT',{timeout});void response.catch(()=>{});await press(add);await response;const remove=members.locator('[data-member-id="user-3"] button');await remove.waitFor({state:'visible',timeout});await assertLocator('focus: group member Add moves focus to the new member Remove button',remove)});
  await run('focus: group member Remove moves focus to the members section',async()=>{const members=focusPage.locator('.ui-members'),remove=members.locator('[data-member-id="user-3"] button');await press(remove);const dialog=focusPage.locator('.ui-dialog'),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/members/user-3')&&item.request().method()==='DELETE',{timeout});await press(dialog.locator('button').last());await response;await dialog.waitFor({state:'detached',timeout});await assertLocator('focus: group member Remove moves focus to the members section',members)});
  await run('focus: protected-term Add moves focus to its term field',async()=>{await openAdmin('/admin/custom-terms');const field=focusPage.locator('.ui-term-card input').first();await field.fill('board plan');const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/custom-terms'&&item.request().method()==='POST',{timeout});void response.catch(()=>{});await press(focusPage.getByRole('button',{name:'Add protected term',exact:true}));await response;await assertLocator('focus: protected-term Add moves focus to its term field',field)});
  await run('focus: protected-term delete moves focus to its region',async()=>{const button=focusPage.getByRole('button',{name:/Delete .*board plan/iu});const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/admin/custom-terms'&&item.request().method()==='DELETE',{timeout});void response.catch(()=>{});await press(button);await response;await assertLocator('focus: protected-term delete moves focus to its region',focusPage.locator('.ui-custom-terms'))});
  await run('focus: policy Test draft stays focused',async()=>{await openAdmin('/admin/policies');await press(rows().first());const drawer=focusPage.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});await drawer.locator('.ui-test textarea').fill('test secret');const button=drawer.getByRole('button',{name:'Run test',exact:true}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/gate/rules/test',{timeout});void response.catch(()=>{});const handle=await press(button);await response;await assertHandle('focus: policy Test draft stays focused',handle)});
  await run('focus: policy Save draft stays focused',async()=>{const drawer=focusPage.locator('.ui-drawer'),button=drawer.getByRole('button',{name:'Save rule',exact:true}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/gate/rules/rule-1'&&item.request().method()==='PATCH',{timeout});void response.catch(()=>{});const handle=await press(button);await response;await assertHandle('focus: policy Save draft stays focused',handle)});
  await run('focus: model Save returns focus to its row',async()=>{await openAdmin('/admin/models');const row=rows().first(),handle=await press(row),drawer=focusPage.locator('.ui-drawer');await drawer.locator('input').first().fill('Updated governed model');const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.includes('/admin/models/')&&item.request().method()==='PATCH',{timeout});await press(drawer.getByRole('button',{name:'Save',exact:true}));await response;await drawer.waitFor({state:'detached',timeout});await assertHandle('focus: model Save returns focus to its row',handle)});
  await run('focus: assistant Generate stays focused',async()=>{await openAdmin('/admin/assistants');await press(focusPage.locator('.ui-page-actions .ui-primary'));const drawer=focusPage.locator('.ui-drawer');await drawer.locator('select').selectOption(model.id);await drawer.locator('input[type="url"]').fill('https://example.test/guide');const button=drawer.getByRole('button',{name:'Generate draft',exact:true}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/assistants/draft-from-url',{timeout});void response.catch(()=>{});const handle=await press(button);await response;await assertHandle('focus: assistant Generate stays focused',handle);await focusPage.keyboard.press('Escape')});
  await run('focus: provider Enable access stays focused when it becomes unavailable',async()=>{providerEnabled=false;await openAdmin('/admin/providers');await press(rows().first());const drawer=focusPage.locator('.ui-drawer'),button=drawer.getByRole('button',{name:'Enable',exact:true}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/providers/openai')&&item.request().method()==='PUT',{timeout});void response.catch(()=>{});const handle=await press(button);await response;await drawer.locator('.ui-provider-success').waitFor({state:'visible',timeout});await assertHandle('focus: provider Enable access stays focused when it becomes unavailable',handle)});
  await run('focus: budget Save returns focus to its row',async()=>{await openAdmin('/admin/budgets');const row=rows().first(),handle=await press(row),drawer=focusPage.locator('.ui-drawer');await drawer.locator('input').nth(1).fill('55');const response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/budgets/budget-1'&&item.request().method()==='PATCH',{timeout});await press(drawer.getByRole('button',{name:'Save',exact:true}));await response;await drawer.waitFor({state:'detached',timeout});await assertHandle('focus: budget Save returns focus to its row',handle)});
  await run('focus: due-date Save stays focused',async()=>{const {drawer}=await openViolation();const input=drawer.locator('input[type="datetime-local"]');await input.fill('2026-10-03T15:45');const button=drawer.locator('#ui-violation-due + p + div button').first(),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/due'),{timeout}),handle=await press(button);await response;await assertHandle('focus: due-date Save stays focused',handle)});
  await run('focus: due-date Clear moves focus to the due-date field',async()=>{const drawer=focusPage.locator('.ui-drawer'),button=drawer.getByRole('button',{name:/Clear/iu}),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname.endsWith('/due'),{timeout});await press(button);await response;await assertLocator('focus: due-date Clear moves focus to the due-date field',drawer.locator('input[type="datetime-local"]'))});
  await run('focus: audit export submit moves focus to its status',async()=>{await openAdmin('/admin/audit');await press(focusPage.locator('.ui-page-actions .ui-secondary'));const dialog=focusPage.locator('.ui-dialog'),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/audit/exports'&&item.request().method()==='POST',{timeout});await press(dialog.locator('button.ui-primary'));await response;await assertLocator('focus: audit export submit moves focus to its status',dialog.locator('section[aria-live="polite"]'))});
  await run('focus: project Save stays focused',async()=>{await focusPage.goto(`${base}/projects/project-1`,{waitUntil:'networkidle',timeout});const form=focusPage.locator('main form'),button=form.locator('button'),response=focusPage.waitForResponse(item=>new URL(item.url()).pathname==='/api/v1/projects/project-1'&&item.request().method()==='PATCH',{timeout});await form.locator('input').fill('Quarterly review updated');const handle=await press(button);await response;await assertHandle('focus: project Save stays focused',handle)});
  report.focusChecks={tests,pass:passes,fail:tests-passes,skipped:0};
  console.log(`Focus audit: ${tests} tests, ${passes} pass, ${tests-passes} fail, 0 skipped.`);
  await focusContext.close();
}

async function dialogFocusReturnCheck(){
  const shot='en-light-comfortable-1440x900-admin-dialog-focus-return',failures=[],timeout=4_000;
  const check=(condition,message,data,failureShot=shot)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot:failureShot,...failure})}};
  const openAndEscape=async({path,triggerSelector,fieldSelector,label})=>{
    await page.goto(`${base}${path}`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
    const trigger=page.locator(triggerSelector).first();await trigger.waitFor({state:'visible',timeout});await trigger.focus({timeout});await page.keyboard.press('Enter');
    const dialog=page.locator('[role="dialog"]').last();await dialog.waitFor({state:'visible',timeout});
    const expected=fieldSelector?dialog.locator(fieldSelector).first():dialog;
    check(await expected.evaluate(element=>document.activeElement===element),`${label} did not put focus on ${fieldSelector?'its autofocused field':'the dialog'}`,null);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached',timeout});
    check(await trigger.evaluate(element=>document.activeElement===element),`${label} Escape did not return focus to its trigger`,null);
  };
  await page.setViewportSize({width:1440,height:900});await configure('en','light','comfortable');shotErrors={console:[],page:[],request:[],api:[]};
  try{
    await openAndEscape({path:'/admin/users',triggerSelector:'.ui-page-actions .ui-primary',fieldSelector:'input[type="email"]',label:'Invite user'});
    await openAndEscape({path:'/admin/groups',triggerSelector:'.ui-page-actions .ui-primary',fieldSelector:'input',label:'Create group'});

    await page.goto(`${base}/admin/violations`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
    const record=page.locator('.ui-admin tbody tr').first();await record.waitFor({state:'visible',timeout});await record.click({timeout});
    const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
    const deny=drawer.getByRole('button',{name:'Deny',exact:true});await deny.focus({timeout});await page.keyboard.press('Enter');
    let reasonDialog=page.getByRole('dialog',{name:'Deny held request',exact:true});await reasonDialog.waitFor({state:'visible',timeout});
    check(await reasonDialog.locator('textarea').evaluate(element=>document.activeElement===element),'Deny did not autofocus the reason textarea',null);
    await page.keyboard.press('Escape');await reasonDialog.waitFor({state:'detached',timeout});
    check(await deny.evaluate(element=>document.activeElement===element),'Deny Escape did not return focus to Deny',null);check(await drawer.isVisible(),'Deny Escape closed the record drawer',null);
    await deny.focus({timeout});await page.keyboard.press('Enter');reasonDialog=page.getByRole('dialog',{name:'Deny held request',exact:true});await reasonDialog.waitFor({state:'visible',timeout});
    const cancel=reasonDialog.getByRole('button',{name:'Cancel',exact:true});await cancel.focus({timeout});await page.keyboard.press('Enter');await reasonDialog.waitFor({state:'detached',timeout});
    check(await deny.evaluate(element=>document.activeElement===element),'Deny Cancel did not return focus to Deny',null);check(await drawer.isVisible(),'Deny Cancel closed the record drawer',null);

    await openAndEscape({path:'/admin/audit',triggerSelector:'.ui-page-actions .ui-secondary',fieldSelector:null,label:'Export CSV'});
  }catch(error){
    check(false,'dialog focus-return check timed out',{error:String(error)});
  }
  await page.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});
  report.shots.push({name:shot,detail:{cases:['Invite user','Create group','Deny Escape','Deny Cancel','Export CSV']},errors:structuredClone(shotErrors),failures});
}

async function holdPagingInteractionCheck(){
  const shot='en-light-comfortable-1440x900-admin-retention-hold-paging-error',failures=[];
  const check=(condition,message,data,failureShot=shot)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot:failureShot,...failure})}};
  const timeout=4_000;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error(`Timeout ${timeout}ms exceeded`);error.name='TimeoutError';reject(error)},timeout)})])}finally{clearTimeout(timer)}};
  const step=async(number,waitedFor,action,failureShot=shot)=>{try{await action();return true}catch(error){if(!/timeout/iu.test(`${error?.name??''} ${error?.message??error}`))throw error;check(false,`hold interaction step ${number} timed out waiting for ${waitedFor}`,{error:String(error)},failureShot);return false}};
  const addFailures=items=>{for(const failure of items){failures.push(failure);report.failures.push({shot,...failure})}};
  await page.setViewportSize({width:1440,height:900});await configure('en','light','comfortable');shotErrors={console:[],page:[],request:[],api:[]};
  await page.goto(`${base}/admin/retention`,{waitUntil:'networkidle'});

  const rangeRow=page.locator('.ui-holds tbody tr').filter({hasText:'Q1 supplier dispute'});
  let rangeTarget='';
  if(!await step(1,'the legal-holds section and initial date-range row',async()=>{await settle('.ui-holds',timeout);await rangeRow.waitFor({state:'visible',timeout});rangeTarget=(await rangeRow.locator('td').nth(1).innerText({timeout})).trim();check(rangeTarget==='Feb 1, 2026 – Feb 28, 2026','date-range hold target does not use the workspace-zone inclusive dates',{rangeTarget})}))return;

  const loadMore=page.getByRole('button',{name:'Load more',exact:true}),inlineError=page.locator('.ui-holds .ui-inline-error');
  let failedRows=[],retryEnabled=false;
  if(!await step(2,'the inline Load more error',async()=>{const failedResponse=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===500&&url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('cursor')==='page-2'},{timeout});failNextHoldPage=true;await loadMore.focus({timeout});await page.keyboard.press('Enter');await failedResponse;await inlineError.waitFor({state:'visible',timeout});failedRows=await page.locator('.ui-holds tbody tr').allTextContents();retryEnabled=await loadMore.isEnabled({timeout});const inlineText=await inlineError.innerText();check(failedRows.length===2&&failedRows.some(row=>row.includes('Morgan Lee'))&&failedRows.some(row=>row.includes('Q1 supplier dispute')),'failed Load more did not preserve both first-page rows',{failedRows});check(inlineText.includes('The service is unavailable. Try again later.')&&!inlineText.includes('SERVER-TEXT-SENTINEL'),'failed Load more did not show localized safe text',{inlineText});check(retryEnabled,'failed Load more did not leave its button enabled',null);check(await loadMore.evaluate(button=>document.activeElement===button),'failed Load more did not keep focus on its button',null);await page.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:shot,detail:{rangeTarget,failedRows,retryEnabled,inlineError:inlineText},errors:structuredClone(shotErrors),failures})}))return;

  const jordan=page.locator('.ui-holds tbody tr').filter({hasText:'Jordan Park'});
  if(!await step(3,'Jordan Park from the successful held Load more page',async()=>{
    const page2Before=holdPage2GetCount;heldHoldPageStarted=new Promise(resolve=>{markHeldHoldPageStarted=resolve});holdNextHoldPage=true;
    const pageResponse=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===200&&url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='active'&&url.searchParams.get('cursor')==='page-2'},{timeout});void pageResponse.catch(()=>{});
    try{
      await loadMore.focus({timeout});await page.keyboard.press('Enter');await bounded(heldHoldPageStarted);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      check(await loadMore.evaluate(button=>document.activeElement===button),'held Load more did not keep focus on its button',null);
      check(await loadMore.getAttribute('aria-disabled')==='true','held Load more did not expose aria-disabled="true"',null);
      const page2WhileHeld=holdPage2GetCount;await page.keyboard.press('Enter');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      check(page2WhileHeld===page2Before+1&&holdPage2GetCount===page2WhileHeld,'pressing Enter on aria-disabled Load more sent another page-2 request',{page2Before,page2WhileHeld,page2AfterSecondEnter:holdPage2GetCount});
      releaseHeldHoldPage();await pageResponse;await jordan.waitFor({state:'visible',timeout});
      check(await jordan.evaluate(row=>document.activeElement===row),'accepted Load more page did not focus the Jordan Park row',null);
      check((await page.locator('.ui-holds tbody tr').count())===3,'successful Load more did not append Jordan Park to the first page',await page.locator('.ui-holds tbody tr').allTextContents());
      check(await loadMore.isDisabled({timeout}),'Load more stayed enabled after the final page',null);
    }finally{holdNextHoldPage=false;releaseHeldHoldPage();await pageResponse.catch(()=>{});markHeldHoldPageStarted=()=>{};releaseHeldHoldPage=()=>{}}
  }))return;

  const all=page.getByRole('radio',{name:'All',exact:true}),releasedRadio=page.getByRole('radio',{name:'Released',exact:true}),active=page.getByRole('radio',{name:'Active',exact:true});
  const released=page.locator('.ui-holds tbody tr').filter({hasText:'Completed investigation'}),morgan=page.locator('.ui-holds tbody tr').filter({hasText:'Morgan Lee'}),tableWrap=page.locator('.ui-holds .ui-table-wrap');
  let heldResponse;
  const filterStep=await step(4,'the Released and Active filter results',async()=>{
    await all.check({timeout});await released.waitFor({state:'visible',timeout});
    heldHoldPageStarted=new Promise(resolve=>{markHeldHoldPageStarted=resolve});holdNextHoldPage=true;
    heldResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='all'&&url.searchParams.get('cursor')==='page-2'},{timeout});
    void heldResponse.catch(()=>{});
    try{
      await loadMore.click({timeout});await bounded(heldHoldPageStarted);
      const releasedFirstResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});
      await releasedRadio.check({timeout});await releasedFirstResponse;await page.locator('.ui-holds .ui-table-wrap:not([aria-busy="true"])').waitFor({state:'visible',timeout});await morgan.waitFor({state:'hidden',timeout});await released.waitFor({state:'visible',timeout});
      releaseHeldHoldPage();await heldResponse;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const releasedRows=await page.locator('.ui-holds tbody tr').allTextContents();
      check(releasedRows.length===1&&releasedRows[0]?.includes('Completed investigation'),'Released filter did not show only the released hold',{releasedRows});
      check(!releasedRows.some(row=>row.includes('Jordan Park')),'stale Load more page contaminated the Released filter',{releasedRows});
      check(await releasedRadio.evaluate(input=>document.activeElement===input),'dropped Load more page moved focus from the Released filter',null);
      const activeResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='active'&&!url.searchParams.has('cursor')},{timeout});await active.check({timeout});await activeResponse;await rangeRow.waitFor({state:'visible',timeout});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      check(await active.evaluate(input=>document.activeElement===input),'the Active filter change moved focus from the Active filter',null);
      const activeRows=await page.locator('.ui-holds tbody tr').allTextContents();check(activeRows.length===2&&activeRows.some(row=>row.includes('Morgan Lee'))&&activeRows.some(row=>row.includes('Q1 supplier dispute')),'Active filter did not restore its two first-page rows',{activeRows});
    }finally{holdNextHoldPage=false;releaseHeldHoldPage();if(heldResponse)await heldResponse.catch(()=>{});markHeldHoldPageStarted=()=>{};releaseHeldHoldPage=()=>{}}
  });
  if(!filterStep)return;

  const retentionBeforeFilters=retentionGetCount;
  if(!await step('4a','keyboard filter results without replacing the holds section',async()=>{
    await page.evaluate(()=>{window.__holdsSection=document.querySelector('.ui-holds')});await active.focus();
    const transitions=[
      {radio:releasedRadio,status:'released',rows:['Completed investigation'],absent:['Morgan Lee','Q1 supplier dispute']},
      {radio:all,status:'all',rows:['Morgan Lee','Q1 supplier dispute','Completed investigation'],absent:[]},
      {radio:active,status:'active',rows:['Morgan Lee','Q1 supplier dispute'],absent:['Completed investigation']},
    ];
    for(const transition of transitions){
      const response=page.waitForResponse(item=>{const url=new URL(item.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')===transition.status&&!url.searchParams.has('cursor')},{timeout});
      await page.keyboard.press('ArrowRight');await response;await page.locator('.ui-holds .ui-table-wrap:not([aria-busy="true"])').waitFor({state:'visible',timeout});
      for(const value of transition.rows)await page.locator('.ui-holds tbody tr').filter({hasText:value}).waitFor({state:'visible',timeout});
      const rows=await page.locator('.ui-holds tbody tr').allTextContents();
      check(await transition.radio.isChecked({timeout}),`ArrowRight did not check the ${transition.status} hold filter`,{rows});
      check(await transition.radio.evaluate(input=>document.activeElement===input),`ArrowRight did not keep focus on the ${transition.status} hold filter`,null);
      check(await page.evaluate(()=>document.querySelector('.ui-holds')===window.__holdsSection),`the ${transition.status} filter change replaced the Legal holds section`,null);
      check(transition.rows.every(value=>rows.some(row=>row.includes(value)))&&transition.absent.every(value=>rows.every(row=>!row.includes(value))),`the ${transition.status} keyboard filter showed the wrong holds`,{rows});
    }
  }))return;

  if(!await step('4b','the held first-page loading state',async()=>{
    heldHoldFirstPageStarted=new Promise(resolve=>{markHeldHoldFirstPageStarted=resolve});holdNextHoldFirstPage=true;
    const releasedFirstResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});
    void releasedFirstResponse.catch(()=>{});
    try{
      await page.keyboard.press('ArrowRight');await bounded(heldHoldFirstPageStarted);await page.locator('.ui-holds .ui-table-wrap[aria-busy="true"]').waitFor({state:'visible',timeout});
      const loadingRows=await page.locator('.ui-holds tbody tr').allTextContents();
      check(loadingRows.length===1&&loadingRows[0]?.includes('Loading current data…'),'held first-page load did not show exactly one loading row',{loadingRows});
      check(await loadMore.isDisabled({timeout}),'Load more was enabled during a first-page load',null);
      check(await releasedRadio.evaluate(input=>document.activeElement===input),'focus left the chosen filter during a first-page load',null);
      check(await page.getByRole('radio',{name:'Active',exact:true}).count()===1&&await page.locator('.ui-holds>header .ui-primary').count()===1,'the filter or Place hold button disappeared during a first-page load',null);
      releaseHeldHoldFirstPage();await releasedFirstResponse;await page.locator('.ui-holds .ui-table-wrap:not([aria-busy="true"])').waitFor({state:'visible',timeout});await released.waitFor({state:'visible',timeout});
      check((await tableWrap.getAttribute('aria-busy'))!=='true','the holds table stayed busy after the first page loaded',null);
    }finally{holdNextHoldFirstPage=false;releaseHeldHoldFirstPage();await releasedFirstResponse.catch(()=>{});markHeldHoldFirstPageStarted=()=>{};releaseHeldHoldFirstPage=()=>{}}
    check(retentionGetCount===retentionBeforeFilters,'status-filter reload requested retention periods',{before:retentionBeforeFilters,after:retentionGetCount});
  }))return;

  if(!await step('4c','successful hold release and heading focus',async()=>{
    const activeResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='active'&&!url.searchParams.has('cursor')},{timeout});await active.check({timeout});await activeResponse;await morgan.waitFor({state:'visible',timeout});
    const hold=legalHolds.find(item=>item.id==='hold-active'),original={...hold},retentionBeforeRelease=retentionGetCount,postIndex=legalHoldReleasePosts.length;
    try{
      const releaseButton=morgan.getByRole('button',{name:'Release',exact:true});await releaseButton.focus();await page.keyboard.press('Enter');
      const dialog=page.getByRole('dialog',{name:'Release',exact:true});await dialog.waitFor({state:'visible',timeout});await dialog.locator('textarea').fill('  Matter resolved  ',{timeout});await dialog.getByRole('button',{name:'Release',exact:true}).click({timeout});await dialog.waitFor({state:'hidden',timeout});await morgan.waitFor({state:'hidden',timeout});
      const submitted=legalHoldReleasePosts[postIndex];
      check(!await dialog.isVisible(),'release dialog stayed open after a successful release',null);
      check(!await morgan.isVisible(),'released Morgan Lee hold stayed in the Active list',null);
      check(submitted?.id==='hold-active'&&submitted?.body?.reason==='Matter resolved','release POST did not carry the trimmed reason',{submitted});
      check(retentionGetCount===retentionBeforeRelease+1,'successful release did not refresh retention periods exactly once',{before:retentionBeforeRelease,after:retentionGetCount});
      const heading=page.locator('.ui-holds h2');check(await heading.evaluate(element=>document.activeElement===element),'successful release did not focus the Legal holds heading',null);
    }finally{if(hold)Object.assign(hold,original)}
  }))return;

  if(!await step('4d','release-dialog Escape focus restoration',async()=>{
    const releasedResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});await releasedRadio.check({timeout});await releasedResponse;
    const activeResponse=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='active'&&!url.searchParams.has('cursor')},{timeout});await active.check({timeout});await activeResponse;await morgan.waitFor({state:'visible',timeout});
    const releaseButton=morgan.getByRole('button',{name:'Release',exact:true});await releaseButton.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Release',exact:true});await dialog.waitFor({state:'visible',timeout});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden',timeout});check(await releaseButton.evaluate(button=>document.activeElement===button),'Escape did not return focus to the Release button',null);
  }))return;

  const firstPageShot='en-light-comfortable-1440x900-admin-retention-hold-first-page-error',firstPageFailures=[];
  const firstPageCheck=(condition,message,data)=>{if(!condition){const failure={message,data};firstPageFailures.push(failure);failures.push(failure);report.failures.push({shot:firstPageShot,...failure})}};
  if(!await step('4e','the failed first page and successful holds-only retry',async()=>{
    await page.evaluate(()=>{window.__holdsSection=document.querySelector('.ui-holds')});await active.focus({timeout});
    const retentionBeforeFirstPageFailure=retentionGetCount;
    const failedResponse=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===500&&url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});
    failNextHoldFirstPage=true;await page.keyboard.press('ArrowRight');await failedResponse;
    const errorRow=page.locator('.ui-holds tbody tr').filter({has:page.locator('.ui-hold-load-error[role="alert"]')});await errorRow.waitFor({state:'visible',timeout});
    const errorAlert=errorRow.locator('.ui-hold-load-error[role="alert"]'),tryAgain=errorRow.getByRole('button',{name:'Try again',exact:true}),tableText=await tableWrap.innerText({timeout});
    firstPageCheck((await page.locator('.ui-holds tbody tr').count())===1,'failed first page did not replace the table body with exactly one row',await page.locator('.ui-holds tbody tr').allTextContents());
    firstPageCheck((await errorAlert.innerText({timeout})).includes('The service is unavailable. Try again later.')&&!(await errorAlert.innerText({timeout})).includes('SERVER-TEXT-SENTINEL')&&await tryAgain.count()===1,'failed first-page row did not contain localized safe text and Try again',await errorAlert.innerText({timeout}));
    firstPageCheck(!tableText.includes('Morgan Lee')&&!tableText.includes('Q1 supplier dispute')&&await tableWrap.getByRole('button',{name:'Release',exact:true}).count()===0,'failed first page retained stale active holds or Release actions',{tableText});
    firstPageCheck(await page.locator('.ui-holds .ui-pagination span').count()===0,'failed first page still showed the shown count',null);firstPageCheck(await loadMore.isDisabled({timeout}),'failed first page did not disable Load more',null);
    firstPageCheck(await releasedRadio.evaluate(input=>document.activeElement===input),'failed first page moved focus from the Released filter',null);firstPageCheck(await page.evaluate(()=>document.querySelector('.ui-holds')===window.__holdsSection),'failed first page replaced the Legal holds section',null);
    await page.screenshot({path:`${out}/${firstPageShot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:firstPageShot,detail:{rows:await page.locator('.ui-holds tbody tr').allTextContents(),alert:await errorAlert.innerText({timeout})},errors:structuredClone(shotErrors),failures:firstPageFailures});

    const retryResponse=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===200&&url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});
    await tryAgain.focus({timeout});await page.keyboard.press('Enter');await retryResponse;await released.waitFor({state:'visible',timeout});await page.locator('.ui-holds .ui-table-wrap:not([aria-busy="true"])').waitFor({state:'visible',timeout});
    firstPageCheck(await tableWrap.evaluate(element=>document.activeElement===element),'first-page Try again did not move focus to the table wrapper',null);
    const namedRegion=page.getByRole('region',{name:'Legal holds',exact:true});firstPageCheck(await namedRegion.count()===1&&await namedRegion.evaluate(element=>element===document.querySelector('.ui-holds .ui-table-wrap')),'holds table wrapper is not a region named Legal holds',null);
    firstPageCheck(retentionGetCount===retentionBeforeFirstPageFailure,'failed first-page flow requested retention periods',{before:retentionBeforeFirstPageFailure,after:retentionGetCount});
  },firstPageShot))return;

  const drawer=page.locator('.ui-drawer');
  const placeButton=page.locator('.ui-holds>header .ui-primary'),retentionBeforePlace=retentionGetCount;
  let submit;
  if(!await step(5,'the user result and date-range validation controls',async()=>{
    await placeButton.focus();await page.keyboard.press('Enter');await drawer.waitFor({state:'visible',timeout});
    const scope=drawer.locator('select[name="hold-scope"]');await scope.selectOption('user',{timeout});
    await drawer.getByLabel('Target',{exact:true}).fill('Morgan',{timeout});await drawer.getByRole('button',{name:'Find users',exact:true}).click({timeout});
    const result=drawer.locator('.ui-hold-user-results>label').filter({hasText:'Morgan Lee'});await result.waitFor({state:'visible',timeout});
    addFailures(await controlGeometryFailures(drawer));
    const target=result.locator('input[type="radio"]');await target.check({timeout});
    await scope.selectOption('date_range',{timeout});await scope.selectOption('user',{timeout});check(!await target.isChecked({timeout}),'choosing Date range did not clear the selected user target',null);await scope.selectOption('date_range',{timeout});
    check((await drawer.locator('.ui-field-error').count())===0,'date-range form showed a field error before the user entered a value',null);
    const rangeHint=drawer.locator('.ui-field-hint').filter({hasText:'Keeps conversations active during these dates'});await rangeHint.waitFor({state:'visible',timeout});
    const startDate=drawer.getByLabel('Start date',{exact:true}),endDate=drawer.getByLabel('End date',{exact:true}),reason=drawer.getByLabel('Reason',{exact:true});
    await startDate.fill('2026-02-01',{timeout});await endDate.fill('2026-01-15',{timeout});
    const endError=drawer.locator('.ui-field-error').filter({hasText:"The end date can't be before the start date."});await endError.waitFor({state:'visible',timeout});
    submit=drawer.getByRole('button',{name:'Place hold',exact:true});check(await submit.isDisabled({timeout}),'invalid date range did not disable hold submission',null);
    await endDate.fill('2026-02-28',{timeout});await reason.fill('Q1 supplier dispute',{timeout});check(await submit.isEnabled({timeout}),'valid date range and reason did not enable hold submission',null)
  }))return;

  if(!await step(6,'the hold submission and drawer close',async()=>{await submit.click({timeout});await drawer.waitFor({state:'hidden',timeout});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const submitted=legalHoldPosts.at(-1);check(submitted?.startsAt==='2026-01-31T16:00:00.000Z'&&submitted?.endsAt==='2026-02-28T16:00:00.000Z','date-range hold POST did not use workspace-zone day boundaries',{submitted});check(await placeButton.evaluate(button=>document.activeElement===button),'successful placement did not return focus to the Place hold button',null);check(retentionGetCount===retentionBeforePlace+1,'successful placement did not refresh retention periods exactly once',{before:retentionBeforePlace,after:retentionGetCount})}))return;

  const mobileFirstPageShot='en-light-comfortable-390x844-admin-retention-hold-first-page-error',mobileFirstPageFailures=[];
  const mobileFirstPageCheck=(condition,message,data)=>{if(!condition){const failure={message,data};mobileFirstPageFailures.push(failure);failures.push(failure);report.failures.push({shot:mobileFirstPageShot,...failure})}};
  await step(7,'the failed first page on a phone',async()=>{
    await page.setViewportSize({width:390,height:844});
    try{
      await page.goto(`${base}/admin/retention`,{waitUntil:'networkidle',timeout});await settle('.ui-holds',timeout);await morgan.waitFor({state:'visible',timeout});
      await active.focus({timeout});
      const failedResponse=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===500&&url.pathname==='/api/v1/admin/legal-holds'&&url.searchParams.get('status')==='released'&&!url.searchParams.has('cursor')},{timeout});
      failNextHoldFirstPage=true;await page.keyboard.press('ArrowRight');await failedResponse;
      const errorRow=page.locator('.ui-holds tbody tr').filter({has:page.locator('.ui-hold-load-error[role="alert"]')});await errorRow.waitFor({state:'visible',timeout});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const geometry=await page.evaluate(()=>{
        const wrapper=document.querySelector('.ui-holds .ui-table-wrap'),error=document.querySelector('.ui-holds .ui-hold-load-error'),button=error?.querySelector('.ui-button');
        if(!wrapper||!error||!button)throw new Error('Missing failed-page geometry target');
        const rectangle=element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}};
        const wrapperRect=wrapper.getBoundingClientRect(),visibleBox={left:wrapperRect.left+wrapper.clientLeft,right:wrapperRect.left+wrapper.clientLeft+wrapper.clientWidth},errorRect=rectangle(error),tryAgainRect=rectangle(button);
        const centre={x:(tryAgainRect.left+tryAgainRect.right)/2,y:(tryAgainRect.top+tryAgainRect.bottom)/2},hit=document.elementFromPoint(centre.x,centre.y);
        return{visibleBox,error:errorRect,tryAgain:tryAgainRect,tryAgainCentre:centre,tryAgainHit:Boolean(hit&&(hit===button||button.contains(hit))),documentScrollWidth:document.documentElement.scrollWidth,innerWidth};
      });
      mobileFirstPageCheck(geometry.error.left>=geometry.visibleBox.left&&geometry.error.right<=geometry.visibleBox.right,'mobile failed-page error block extended outside the visible table wrapper',geometry);
      mobileFirstPageCheck(geometry.tryAgain.left>=geometry.visibleBox.left&&geometry.tryAgain.right<=geometry.visibleBox.right,'mobile failed-page Try again extended outside the visible table wrapper',geometry);
      mobileFirstPageCheck(geometry.tryAgainHit,'mobile failed-page Try again was not hit-testable at its centre',geometry);
      mobileFirstPageCheck(geometry.documentScrollWidth<=geometry.innerWidth,'mobile failed-page caused horizontal page overflow',geometry);
      await page.screenshot({path:`${out}/${mobileFirstPageShot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:mobileFirstPageShot,detail:{rectangles:{visibleBox:geometry.visibleBox,error:geometry.error,tryAgain:geometry.tryAgain},tryAgainCentre:geometry.tryAgainCentre,tryAgainHit:geometry.tryAgainHit,documentScrollWidth:geometry.documentScrollWidth,innerWidth:geometry.innerWidth},errors:structuredClone(shotErrors),failures:mobileFirstPageFailures});
    }finally{await page.setViewportSize({width:1440,height:900})}
  },mobileFirstPageShot);
}

async function checkTouchActions(){
  const touchContext=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true,colorScheme:'light'}),touchPage=await touchContext.newPage();await touchPage.route('**/api/v1/**',routeApi);await touchPage.goto(base,{waitUntil:'domcontentloaded'});await touchPage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}));});await touchPage.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await touchPage.locator('.ui-entry').first().waitFor({state:'visible'});const opacities=await touchPage.locator('.ui-message-actions').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).opacity));if(!opacities.length||opacities.some(value=>value!=='1'))report.failures.push({shot:'touch-1024x768-conversation',message:'touch row actions are not always visible',data:opacities});await touchContext.close();
}

async function violationDueDateInteractionCheck(){
  const shot='en-light-comfortable-1440x900-admin-violation-due-date',failures=[],timeout=4_000;
  const check=(condition,message,data)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}};
  const dueBodies=[],bulkBodies=[],localViolation={...violation,dueAt:'2026-10-01T01:00:00.000Z'};
  const dueContext=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light',timezoneId:'America/New_York'}),duePage=await dueContext.newPage();
  await duePage.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/v1/admin/violations/violation-1/due'&&['PATCH','POST'].includes(request.method())){
      const body=request.postDataJSON();dueBodies.push(body);return respond({item:{...localViolation,...body,version:localViolation.version+1}});
    }
    if(url.pathname==='/api/v1/admin/violations/bulk'&&request.method()==='POST'){
      const body=request.postDataJSON();bulkBodies.push(body);return respond({affected:1,skipped:0,errors:[],snapshot:[{id:'violation-1',version:localViolation.version}]});
    }
    if(url.pathname==='/api/v1/admin/violations/violation-1')return respond({item:localViolation});
    if(url.pathname==='/api/v1/admin/violations')return respond({items:[localViolation],nextCursor:null,total:1});
    return routeApi(route);
  });
  try{
    await duePage.goto(base,{waitUntil:'domcontentloaded',timeout});
    await duePage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}));});
    await duePage.goto(`${base}/admin/violations`,{waitUntil:'networkidle',timeout});
    const row=duePage.locator('.ui-admin tbody tr').first();await row.waitFor({state:'visible',timeout});await row.click({timeout});
    const drawer=duePage.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
    const dueSection=drawer.locator('#ui-violation-due').locator('..'),dueInput=dueSection.locator('input[type="datetime-local"]');
    await dueInput.waitFor({state:'visible',timeout});await dueInput.scrollIntoViewIfNeeded({timeout});
    const displayedDue=await dueInput.inputValue();check(displayedDue==='2026-10-01T09:00','single violation due date was not displayed in the workspace time zone',{displayedDue});
    await duePage.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:shot,detail:{displayedDue},errors:{console:[],page:[],request:[],api:[]},failures});
    await dueInput.fill('2026-10-02T08:30',{timeout});
    const dueRequest=duePage.waitForRequest(request=>new URL(request.url()).pathname==='/api/v1/admin/violations/violation-1/due',{timeout});
    await dueSection.getByRole('button',{name:'Save',exact:true}).click({timeout});await dueRequest;
    const savedDue=dueBodies.at(-1);check(savedDue?.dueAt==='2026-10-02T00:30:00.000Z','single violation due request did not use the workspace time zone',{savedDue});

    await drawer.getByRole('button',{name:'Close',exact:true}).click({timeout});await drawer.waitFor({state:'hidden',timeout});
    await duePage.locator('.ui-admin tbody tr').first().locator('input[type="checkbox"]').check({timeout});
    const bulk=duePage.getByRole('region',{name:'Bulk triage',exact:true});await bulk.waitFor({state:'visible',timeout});
    await bulk.locator('label').filter({hasText:'Bulk action'}).locator('select').selectOption('set_due',{timeout});
    await bulk.getByLabel('Due date',{exact:true}).fill('2026-10-03T23:45',{timeout});
    const bulkRequest=duePage.waitForRequest(request=>new URL(request.url()).pathname==='/api/v1/admin/violations/bulk'&&request.method()==='POST',{timeout});
    await bulk.getByRole('button',{name:'Review changes',exact:true}).click({timeout});await bulkRequest;
    await bulk.getByText('1 ready · 0 skipped',{exact:true}).waitFor({state:'visible',timeout});
    const dryRun=bulkBodies.find(body=>body?.dryRun===true);check(dryRun?.parameters?.dueAt==='2026-10-03T15:45:00.000Z','bulk due-date preview did not use the workspace time zone',{dryRun});
  }catch(error){check(false,'violation due-date interaction check failed',{error:String(error),dueBodies,bulkBodies})}
  finally{await dueContext.close()}
}

async function overviewAxisLabelCheck(){
  const timeout=4_000,workspaceTimeZone='Asia/Taipei',hourStart=Date.parse('2026-09-27T12:00:00.000Z'),dayStart=Date.parse('2026-08-30T16:00:00.000Z');
  const mobileHourlyLabelCounts={};
  const fixtures={
    '24h':{granularity:'hour',items:Array.from({length:24},(_,index)=>({label:`Hour ${index+1}`,bucketStartMs:hourStart+index*60*60*1_000,value:80+(index*17)%91}))},
    '30d':{granularity:'day',items:Array.from({length:30},(_,index)=>({label:`Day ${index+1}`,bucketStartMs:dayStart+index*24*60*60*1_000,value:80+(index*17)%91}))},
  };
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])for(const [range,fixture] of Object.entries(fixtures)){
    const shot=`${locale}-light-comfortable-${viewport.name}-admin-overview-axis-${range}`,caseFailures=[];
    const check=(condition,message,data)=>{if(!condition){const failure={message,data};caseFailures.push(failure);report.failures.push({shot,...failure})}};
    const axisContext=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},colorScheme:'light',timezoneId:'America/New_York'}),axisPage=await axisContext.newPage();
    await axisPage.route('**/api/v1/**',async route=>{
      const url=new URL(route.request().url()),respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/v1/auth/me')return respond({...me,preferences:{density:'comfortable',colorMode:'light',locale}});
      if(url.pathname==='/api/v1/me/preferences')return respond({...preference,density:'comfortable',colorMode:'light',locale});
      if(url.pathname==='/api/v1/admin/me/capabilities')return respond({...capabilities,tenantTimezone:workspaceTimeZone});
      if(url.pathname==='/api/v1/admin/analytics/timeseries')return respond(fixture);
      return routeApi(route);
    });
    try{
      await axisPage.goto(base,{waitUntil:'domcontentloaded',timeout});
      await axisPage.evaluate(locale=>{localStorage.setItem('app.locale.v1',locale);localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))},locale);
      await axisPage.goto(`${base}/admin?range=${range}`,{waitUntil:'networkidle',timeout});
      const chart=axisPage.locator('.ui-svg'),visibleLabels=chart.locator('text:visible');await visibleLabels.first().waitFor({state:'visible',timeout});await chart.scrollIntoViewIfNeeded({timeout});
      await axisPage.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
      const geometry=await chart.evaluate(root=>{
        const svg=root.querySelector('svg');if(!svg)throw new Error('Missing Overview chart SVG');
        const rectangle=element=>{const box=element.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}};
        const labels=[...svg.querySelectorAll('text')].filter(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&Number(style.opacity)!==0&&box.width>0&&box.height>0}).map(element=>({text:element.textContent??'',index:element.getAttribute('data-axis-index'),box:rectangle(element)})).sort((a,b)=>a.box.left-b.box.left);
        return{svg:rectangle(svg),labels};
      });
      const longTexts=fixture.items.map(item=>new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',...(fixture.granularity==='hour'?(locale==='zh-TW'?{hour:'numeric',hourCycle:'h23'}:{hour:'numeric'}):{}),timeZone:workspaceTimeZone}).format(item.bucketStartMs));
      const dayKeys=fixture.items.map(item=>new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:workspaceTimeZone}).format(item.bucketStartMs));
      const labels=geometry.labels.map(label=>{const index=label.index===null?longTexts.indexOf(label.text):Number(label.index);return{...label,index}});
      const gaps=labels.slice(1).map((label,index)=>({leftIndex:labels[index].index,rightIndex:label.index,gap:label.box.left-labels[index].box.right}));
      const strides=labels.slice(1).map((label,index)=>label.index-labels[index].index);
      check(gaps.every(item=>item.gap>=8),'Overview axis labels came within 8 px of each other',{locale,viewport:viewport.name,range,gaps});
      check(labels.every(item=>item.box.left>=geometry.svg.left&&item.box.right<=geometry.svg.right),'Overview axis label left the SVG',{locale,viewport:viewport.name,range,svg:geometry.svg,labels});
      check(labels.every(item=>item.box.height>=12),'Overview axis label rendered below the 12 px text floor',{locale,viewport:viewport.name,range,heights:labels.map(item=>({index:item.index,height:item.box.height}))});
      check(new Set(strides).size<=1,'Overview axis labels were not an equal number of points apart',{locale,viewport:viewport.name,range,strides});
      check(labels.length<=8,'Overview axis drew more than 8 labels',{locale,viewport:viewport.name,range,labelCount:labels.length});
      if(range==='24h'){
        if(viewport.width===390)mobileHourlyLabelCounts[locale]=labels.length;
        const stride=strides[0];
        const firstHour=labels.length?Number(new Intl.DateTimeFormat('en',{hour:'numeric',hourCycle:'h23',timeZone:workspaceTimeZone}).format(fixture.items[labels[0].index].bucketStartMs)):null;
        check(stride!==undefined&&firstHour!==null&&firstHour%stride===0,'first hourly Overview axis label was not aligned to its stride',{locale,viewport:viewport.name,stride,firstHour,label:labels[0]});
        const firstLabel=labels[0];
        check(firstLabel?.text===longTexts[firstLabel?.index],'first hourly Overview axis label did not carry its date',{locale,viewport:viewport.name,label:firstLabel,expected:firstLabel?longTexts[firstLabel.index]:undefined});
        const undatedDayStarts=labels.filter((label,index)=>index>0&&label.index>=0&&dayKeys[label.index]!==dayKeys[labels[index-1].index]&&label.text!==longTexts[label.index]);
        check(undatedDayStarts.length===0,'hourly Overview axis label on a new day did not carry its date',{locale,viewport:viewport.name,labels:undatedDayStarts,expected:undatedDayStarts.map(label=>longTexts[label.index])});
      }
      await axisPage.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});
      report.shots.push({name:shot,detail:{range,locale,viewport:viewport.name,geometry},errors:{console:[],page:[],request:[],api:[]},failures:caseFailures});
    }catch(error){check(false,'Overview axis-label check failed',{locale,viewport:viewport.name,range,error:String(error)})}
    finally{await axisContext.close()}
  }
  if((mobileHourlyLabelCounts['zh-TW']??0)<(mobileHourlyLabelCounts.ja??0))report.failures.push({shot:'zh-TW-light-comfortable-390x844-admin-overview-axis-24h',message:'Traditional Chinese 24-hour axis shows fewer labels than Japanese',data:mobileHourlyLabelCounts});
}

async function segmentedControlCheck(){
  const failures=[],check=(condition,message,data,shot)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}},desktopShot='en-light-comfortable-1440x900-admin-retention-segments',touchShot='en-light-comfortable-390x844-admin-retention-segments-touch';
  await page.setViewportSize({width:1440,height:900});await configure('en','light','comfortable');shotErrors={console:[],page:[],request:[],api:[]};await page.goto(`${base}/admin/retention`,{waitUntil:'networkidle'});await settle('.ui-holds>.ui-segments');
  const segment=page.locator('.ui-holds>.ui-segments label').nth(1),input=segment.locator('input'),span=segment.locator('span'),before=await span.evaluate(element=>getComputedStyle(element).backgroundColor),cursor=await input.evaluate(element=>getComputedStyle(element).cursor);await input.hover({force:true});await span.evaluate(element=>Promise.allSettled(element.getAnimations().map(animation=>animation.finished)));
  const hover=await span.evaluate(element=>getComputedStyle(element).backgroundColor),panel2=await span.evaluate(element=>{const probe=document.createElement('span');probe.style.background='var(--panel-2)';element.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value});
  check(cursor==='pointer','segmented control does not use the pointer cursor',{cursor},desktopShot);check(hover!==before&&hover===panel2,'hovering an unchecked segment did not apply --panel-2',{before,hover,panel2},desktopShot);await page.screenshot({path:`${out}/${desktopShot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:desktopShot,detail:{cursor,before,hover,panel2},errors:structuredClone(shotErrors),failures:[...failures]});
  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,colorScheme:'light'}),touchPage=await touchContext.newPage();await touchPage.route('**/api/v1/**',routeApi);
  try{
    await touchPage.goto(base,{waitUntil:'domcontentloaded'});await touchPage.evaluate(()=>{localStorage.setItem('app.locale.v1','en');localStorage.setItem('app.appearance.v2',JSON.stringify({mode:'light',density:'comfortable',updatedAt:Date.now()}))});await touchPage.goto(`${base}/admin/retention`,{waitUntil:'networkidle'});const touchSegment=touchPage.locator('.ui-holds>.ui-segments label').nth(1);await touchSegment.scrollIntoViewIfNeeded();
    const geometry=await touchSegment.evaluate(label=>{const input=label.querySelector('input'),span=label.querySelector('span'),box=element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}},hitOwnControl=(element,rect)=>[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].some(([x,y])=>{const hit=document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y);return hit===element||element.contains(hit)||Boolean(hit?.closest('label')?.contains(element))});if(!input||!span)throw new Error('Missing segment input or visible span');const visibleBox=box(span),inputBox=box(input),point={x:(visibleBox.left+visibleBox.right)/2,y:visibleBox.top-6},hit=document.elementFromPoint(point.x,point.y),spills=[...document.querySelectorAll('button,select,input')].filter(element=>{const style=getComputedStyle(element),rect=box(element);return element!==input&&!label.contains(element)&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&style.pointerEvents!=='none'&&hitOwnControl(element,rect)}).map(element=>({element,box:box(element)})).filter(item=>inputBox.left<item.box.right&&inputBox.right>item.box.left&&inputBox.top<item.box.bottom&&inputBox.bottom>item.box.top).map(item=>({tag:item.element.tagName,type:item.element.getAttribute('type'),className:item.element.className,name:item.element.getAttribute('name'),ariaLabel:item.element.getAttribute('aria-label'),parentClass:item.element.parentElement?.className??null,box:item.box}));return{visibleBox,inputBox,point,hitTag:hit?.tagName??null,hitType:hit?.getAttribute('type')??null,hitOwnInput:hit===input,spills}});
    check(geometry.hitOwnInput,'coarse-pointer segment input is not hit 6px above its visible box',geometry,touchShot);check(Math.abs(geometry.visibleBox.height-32)<=.5,'coarse-pointer rule changed the segment visible height',geometry,touchShot);check(Math.abs(geometry.inputBox.height-44)<=.5,'coarse-pointer segment hit area is not 44px high',geometry,touchShot);check(geometry.spills.length===0,'coarse-pointer segment hit area overlaps a neighbouring control',geometry,touchShot);await touchPage.screenshot({path:`${out}/${touchShot}.png`,fullPage:true,animations:'disabled'});report.shots.push({name:touchShot,detail:geometry,errors:{console:[],page:[],request:[],api:[]},failures:failures.filter(failure=>report.failures.some(item=>item.shot===touchShot&&item.message===failure.message))});
  }catch(error){check(false,'coarse-pointer segment check failed',{error:String(error)},touchShot)}finally{await touchContext.close()}
}

async function japanesePhraseBreakCheck(){
  const shot='ja-light-comfortable-1440x900-phrase-break',failures=[],check=(condition,message,data)=>{if(!condition){const failure={message,data};failures.push(failure);report.failures.push({shot,...failure})}};
  await page.setViewportSize({width:1440,height:900});await configure('ja','light','comfortable');shotErrors={console:[],page:[],request:[],api:[]};await page.goto(`${base}/admin/retention`,{waitUntil:'networkidle'});await settle('.ui-field-hint');const hint=await page.locator('.ui-field-hint').first().evaluate(element=>({text:element.textContent?.trim(),wordBreak:getComputedStyle(element).wordBreak}));
  adminPersona='owner';await page.goto(`${base}/admin/detectors`,{waitUntil:'networkidle'});await settle('.ui-notice');const notice=await page.locator('.ui-notice').evaluate(element=>({text:element.textContent?.trim(),wordBreak:getComputedStyle(element).wordBreak}));
  await page.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await settle('.ui-entry');const gateReceipt=await page.locator('section.ui-receipt[data-receipt-kind="block"] p').first().evaluate(element=>({text:element.textContent?.trim(),wordBreak:getComputedStyle(element).wordBreak}));
  await page.goto(`${base}/chat`,{waitUntil:'networkidle'});await settle('.ui-empty');await page.locator('.ui-composer textarea').fill('Test Japanese receipt wrapping.');refuseNextChatBudget=true;await page.locator('.ui-send-button').click();const failureLocator=page.locator('section.ui-receipt[data-receipt-kind="failure"] p').first();await failureLocator.waitFor({state:'visible'});const failureReceipt=await failureLocator.evaluate(element=>({text:element.textContent?.trim(),wordBreak:getComputedStyle(element).wordBreak}));
  check(hint.wordBreak==='auto-phrase','Japanese field hint is not phrase-aware',hint);check(notice.wordBreak==='auto-phrase','Japanese notice is not phrase-aware',notice);check(gateReceipt.wordBreak==='auto-phrase','Japanese gate receipt is not phrase-aware',gateReceipt);check(failureReceipt.wordBreak==='auto-phrase','Japanese failure receipt is not phrase-aware',failureReceipt);await page.screenshot({path:`${out}/${shot}.png`,fullPage:false,animations:'disabled'});report.shots.push({name:shot,detail:{hint,notice,gateReceipt,failureReceipt},errors:structuredClone(shotErrors),failures});
}

async function chatVisibilityLoop(){
  const chatScreens=screens.filter(screen=>['empty','conversation','search','projects','skills','archived','settings'].includes(screen.name));
  for(let iteration=1;iteration<=chatVisibilityLoops;iteration++)for(const locale of locales)for(const mode of modes)for(const viewport of viewports){
    for(const screen of chatScreens)await shot({locale,mode,viewport,screen});
    if(viewport.width<1024)await shot({locale,mode,viewport,screen:screens[1],drawer:true});
  }
  report.chatVisibilityLoop={iterations:chatVisibilityLoops,checks:report.shots.length,failures:report.failures.length};
  console.log(`Chat visibility loop ${chatVisibilityLoops}: ${report.shots.length} shots, ${report.failures.length} failures.`);
}

async function chatTransitionLoop(){
  let checks=0,transitioning=0,minRight=Infinity,minState=null;
  for(const locale of locales)for(const mode of modes)for(const viewport of viewports){
    await page.setViewportSize({width:viewport.width,height:viewport.height});await configure(locale,mode,'comfortable');await page.goto(`${base}/chat/conv-1`,{waitUntil:'networkidle'});await settle('.ui-entry');
    for(let iteration=1;iteration<=chatTransitionLoops;iteration++){
      if(viewport.width<1024){await page.locator('.ui-mobile-menu').click();await page.locator('.ui-sidebar.is-open').waitFor({state:'visible'});await settleSidebar()}
      const detail=await inspect({locale,mode,density:'comfortable',viewport,screen:viewport.width<1024?'drawer':'conversation',drawer:viewport.width<1024}),expected=viewport.width>=1024||viewport.width<1024;checks+=1;
      if(viewport.width<1024&&detail.registerState?.transform!=='none'){transitioning+=1;if(detail.registerState.box.right<minRight){minRight=detail.registerState.box.right;minState={locale,mode,viewport:viewport.name,iteration,state:detail.registerState}}}
      if(detail.registerVisible!==expected)report.failures.push({shot:`chat-transition-${iteration}-${locale}-${mode}-${viewport.name}-conversation`,message:'register visibility is wrong',data:detail.registerState});
      if(viewport.width<1024){await page.keyboard.press('Escape');await page.locator('.ui-sidebar').waitFor({state:'hidden'});await page.locator('.ui-sidebar').evaluate(element=>Promise.allSettled(element.getAnimations().map(animation=>animation.finished)))}
    }
  }
  report.chatTransitionLoop={iterations:chatTransitionLoops,checks,failures:report.failures.length,transitioning,minState};console.log(`Chat transition loop ${chatTransitionLoops}: ${checks} checks, ${report.failures.length} failures; ${transitioning} reads during transition; closest=${JSON.stringify(minState)}.`);
}

const fieldNameCopy={
  en:{scope:'Scope',target:'Target',start:'Start date',end:'End date',reason:'Reason',release:'Reason for release',due:'Due date',written:'Written reason',ticket:'Ticket URL',notes:'Case notes',terms:'Protected terms',zone:'Time zone',apiKey:'New API key',baseUrl:'Base URL (optional)',source:'Source URL',workspaceRole:'Workspace role',role:'Role',code:'Verification or recovery code',password:'New password',instructions:'Custom instructions',email:'Work email',signInPassword:'Password',signIn:'Sign in',deny:'Deny',update:'Update status',cancel:'Cancel',editUser:'Edit user',bulk:'Bulk triage'},
  'zh-TW':{scope:'範圍',target:'目標',start:'開始日期',end:'結束日期',reason:'原因',release:'解除原因',due:'處理期限',written:'書面理由',ticket:'工單網址',notes:'案件備註',terms:'受保護詞彙',zone:'時區',apiKey:'新的 API 金鑰',baseUrl:'Base URL（選填）',source:'來源網址',workspaceRole:'工作空間角色',role:'角色',code:'驗證碼或恢復碼',password:'新密碼',instructions:'自訂指示',email:'公司電子郵件',signInPassword:'密碼',signIn:'登入',deny:'拒絕',update:'更新狀態',cancel:'取消',editUser:'編輯使用者',bulk:'批次分流'},
  ja:{scope:'範囲',target:'対象',start:'開始日',end:'終了日',reason:'理由',release:'解除の理由',due:'対応期限',written:'判断理由',ticket:'チケット URL',notes:'ケースノート',terms:'保護対象語',zone:'タイムゾーン',apiKey:'新しい API キー',baseUrl:'ベース URL（任意）',source:'参照元 URL',workspaceRole:'ワークスペースロール',role:'ロール',code:'確認コードまたはリカバリーコード',password:'新しいパスワード',instructions:'カスタム指示',email:'会社メール',signInPassword:'パスワード',signIn:'サインイン',deny:'却下',update:'ステータスを更新',cancel:'キャンセル',editUser:'ユーザーを編集',bulk:'一括トリアージ'},
};

async function fieldAccessibleNameCheck(){
  const timeout=4_000;
  await page.setViewportSize({width:1440,height:900});
  const fail=(shot,message,data)=>{report.failures.push({shot,message,data})};
  const expectExactLabel=async(root,name,shot)=>{
    const locator=root.getByLabel(name,{exact:true});
    try{await locator.first().waitFor({state:'visible',timeout})}catch(error){fail(shot,`getByLabel(${name}, {exact: true}) found no visible field`,{error:String(error)});return}
    const count=await locator.count();
    if(count!==1)fail(shot,`getByLabel(${name}, {exact: true}) matched ${count} fields`,{count});
  };
  const run=async(shot,action)=>{try{await action()}catch(error){fail(shot,`${shot} failed`,{error:String(error)})}};
  for(const locale of locales){
    const names=fieldNameCopy[locale],shot=`field-accessible-names-${locale}`;
    await configure(locale,'light','comfortable');
    await run(shot,async()=>{
      await page.goto(`${base}/admin/retention`,{waitUntil:'networkidle',timeout});await settle('.ui-holds',timeout);
      await page.locator('.ui-holds>header .ui-primary').click({timeout});
      const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
      const scope=drawer.locator('select[name="hold-scope"]');
      await expectExactLabel(drawer,names.scope,shot);
      await expectExactLabel(drawer,names.reason,shot);
      for(const value of ['user','conversation','project']){await scope.selectOption(value,{timeout});await expectExactLabel(drawer,names.target,shot)}
      await scope.selectOption('date_range',{timeout});
      await expectExactLabel(drawer,names.start,shot);
      await expectExactLabel(drawer,names.end,shot);
      await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden',timeout});
      await page.locator('.ui-holds tbody .ui-cell-actions button').first().click({timeout});
      const release=page.getByRole('dialog').last();await release.waitFor({state:'visible',timeout});
      await expectExactLabel(release,names.release,shot);
      await release.getByRole('button',{name:names.cancel,exact:true}).click({timeout});
    });
    await run(shot,async()=>{
      await page.goto(`${base}/admin/violations`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
      await page.locator('.ui-admin tbody tr').first().click({timeout});
      const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
      await expectExactLabel(drawer,names.due,shot);
      await drawer.getByRole('button',{name:names.deny,exact:true}).click({timeout});
      const deny=page.locator('form.ui-dialog').last();await deny.waitFor({state:'visible',timeout});
      await expectExactLabel(deny,names.written,shot);
      await expectExactLabel(deny,names.ticket,shot);
      await deny.getByRole('button',{name:names.cancel,exact:true}).click({timeout});await deny.waitFor({state:'hidden',timeout});
      await drawer.locator('select[aria-labelledby="ui-violation-workflow"]').selectOption('resolved',{timeout});
      await drawer.getByRole('button',{name:names.update,exact:true}).click({timeout});
      const closure=page.locator('form.ui-dialog').last();await closure.waitFor({state:'visible',timeout});
      await expectExactLabel(closure,names.written,shot);
      await closure.getByRole('button',{name:names.cancel,exact:true}).click({timeout});await closure.waitFor({state:'hidden',timeout});
      await drawer.locator('header .ui-icon-button').click({timeout});await drawer.waitFor({state:'hidden',timeout});
      await page.locator('.ui-admin tbody tr').first().locator('input[type="checkbox"]').check({timeout});
      const bulk=page.getByRole('region',{name:names.bulk,exact:true});await bulk.waitFor({state:'visible',timeout});
      const action=bulk.locator('select').first();
      await action.selectOption('set_due',{timeout});await expectExactLabel(bulk,names.due,shot);
      await action.selectOption('resolve',{timeout});await expectExactLabel(bulk,names.written,shot);
      await action.selectOption('note',{timeout});await expectExactLabel(bulk,names.notes,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/admin/custom-terms`,{waitUntil:'networkidle',timeout});await settle('.ui-term-card',timeout);
      await expectExactLabel(page.locator('form.ui-term-card').nth(1),names.terms,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/admin/settings`,{waitUntil:'networkidle',timeout});await settle('.ui-settings-form',timeout);
      await expectExactLabel(page.locator('.ui-settings-form'),names.zone,shot);
    });
    await run(shot,async()=>{
      adminPersona='admin';
      try{
        await page.goto(`${base}/admin/users`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
        await page.locator('.ui-page-actions .ui-primary').click({timeout});
        const invite=page.locator('.ui-drawer').last();await invite.waitFor({state:'visible',timeout});
        await invite.locator('details').evaluate(element=>{element.open=true});
        await expectExactLabel(invite,names.workspaceRole,shot);
        await page.keyboard.press('Escape');await invite.waitFor({state:'hidden',timeout});
        await page.locator('.ui-admin tbody tr').filter({hasText:'Workspace Member'}).click({timeout});
        await page.locator('.ui-drawer').first().waitFor({state:'visible',timeout});
        await page.locator('.ui-record-buttons button').filter({hasText:names.editUser}).click({timeout});
        const edit=page.locator('.ui-drawer').last();await edit.waitFor({state:'visible',timeout});
        await expectExactLabel(edit,names.role,shot);
      }finally{adminPersona='owner'}
    });
    await run(shot,async()=>{
      await page.goto(`${base}/admin/providers`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
      await page.locator('.ui-page-actions .ui-primary').click({timeout});
      const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
      await expectExactLabel(drawer,names.apiKey,shot);
      await expectExactLabel(drawer,names.baseUrl,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/admin/assistants`,{waitUntil:'networkidle',timeout});await settle('.ui-admin h1',timeout);
      await page.locator('.ui-page-actions .ui-primary').click({timeout});
      const drawer=page.locator('.ui-drawer');await drawer.waitFor({state:'visible',timeout});
      await expectExactLabel(drawer,names.source,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/projects`,{waitUntil:'networkidle',timeout});await settle('.ui-page',timeout);
      await expectExactLabel(page.locator('main'),names.instructions,shot);
      await page.goto(`${base}/projects/project-1`,{waitUntil:'networkidle',timeout});await settle('main form',timeout);
      await expectExactLabel(page.locator('main'),names.instructions,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/reset-password#visual-token`,{waitUntil:'networkidle',timeout});await settle('.ui-login__form',timeout);
      await expectExactLabel(page.locator('.ui-login__form'),names.password,shot);
    });
    await run(shot,async()=>{
      await page.goto(`${base}/login`,{waitUntil:'networkidle',timeout});await settle('.ui-login__form',timeout);
      await page.getByLabel(names.email,{exact:true}).fill('admin@example.test',{timeout});
      await page.getByLabel(names.signInPassword,{exact:true}).fill('visual-audit-password',{timeout});
      requireMfaOnLogin=true;
      try{
        await page.getByRole('button',{name:names.signIn,exact:true}).click({timeout});
        await expectExactLabel(page.locator('.ui-login__form'),names.code,shot);
      }finally{requireMfaOnLogin=false}
    });
  }
}

try{
  await page.goto(base,{waitUntil:'domcontentloaded'});
  if(focusOnly)await focusInteractionCheck();
  else if(chatTransitionLoops>0)await chatTransitionLoop();
  else if(chatVisibilityLoops>0)await chatVisibilityLoop();
  else if(phraseOnly)await japanesePhraseBreakCheck();
  else if(liveGateOnly)await liveGateChecks();
  else{
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])for(const kind of ['setup','reset-password','forgot-password'])await publicCredentialShot(locale,viewport,kind);
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])for(const kind of ['setup','reset-password'])await publicCredentialShot(locale,viewport,kind,'tokenless');
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])await publicCredentialShot(locale,viewport,'reset-password','dead');
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])for(const flow of ['invite','reset'])await credentialDialogShot(locale,viewport,flow);
  for(const locale of locales)for(const mode of modes)for(const viewport of viewports){
    for(const screen of screens)await shot({locale,mode,viewport,screen});
    if(viewport.width===390)await shot({locale,mode,viewport,screen:screens[1],drawer:true});
  }
  for(const locale of locales)for(const mode of modes)await shot({locale,mode,density:'compact',viewport:viewports[2],screen:screens[2]});
  for(const mode of modes)await shot({locale:'en',mode,density:'compact',viewport:viewports[2],screen:screens[1]});
  for(const locale of locales)await shot({locale,mode:'light',viewport:viewports[0],screen:{name:'composer-options-open',path:'/chat',ready:'.ui-empty'}});
  for(const locale of locales)await liveGatingShot(locale);
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])await attachmentComposerShot(locale,viewport);
  for(const viewport of [viewports[0],viewports[1],viewports[2]])await conversationFeedbackShot(viewport);
  for(const viewport of [viewports[0],viewports[1],viewports[2]])await conversationFeedbackChatShot(viewport);
  for(const viewport of [viewports[0],viewports[1],viewports[2]])await conversationFeedbackSettingsShot(viewport);
  for(const viewport of [viewports[2],viewports[0]])for(const screen of adminScreens)await adminShot({locale:'en',mode:'light',viewport,screen});
  const adminDetailScreens=adminScreens.filter(screen=>['overview','policies','compliance','violations','audit'].includes(screen.key));
  for(const locale of locales)for(const mode of modes)for(const viewport of viewports)for(const screen of adminDetailScreens)await adminShot({locale,mode,viewport,screen,recordDrawer:['violations','audit'].includes(screen.key)});
  for(const locale of locales)await adminShot({locale,mode:'light',viewport:viewports[1],screen:adminScreens[0],navigationDrawer:true});
  const createScreens=adminScreens.filter(screen=>['policies','custom-terms','users','groups','models','assistants','providers','budgets','retention'].includes(screen.key));
  const recordScreens=adminScreens.filter(screen=>['policies','users','groups','roles','models','detectors','compliance','budgets','violations','audit'].includes(screen.key));
  for(const [locale,viewport] of [['en',viewports[2]],['ja',viewports[0]]]){
    for(const screen of createScreens)await adminShot({locale,mode:'light',viewport,screen,createDrawer:true});
    for(const screen of recordScreens)await adminShot({locale,mode:'light',viewport,screen,recordDrawer:true});
    await adminShot({locale,mode:'light',viewport,screen:adminScreens.find(screen=>screen.key==='retention'),releaseDialog:true});
  }
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])for(const state of ['screen','edit','invite','edit-member'])await adminUsersPersonaShot(locale,viewport,state);
  for(const locale of locales)for(const viewport of [viewports[0],viewports[2]])await localizedRefusalShots(locale,viewport);
  await dialogFocusReturnCheck();
  await holdPagingInteractionCheck();
  await violationDueDateInteractionCheck();
  await focusInteractionCheck();
  await segmentedControlCheck();
  await japanesePhraseBreakCheck();
  await overviewAxisLabelCheck();
  await checkTouchActions();
  await liveGateChecks();
  await fieldAccessibleNameCheck();
  }
}finally{
  report.finishedAt=new Date().toISOString();
  writeFileSync(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
  await browser.close();
}

if(report.failures.length){
  console.error(JSON.stringify(report.failures,null,2));
  console.error(`Visual audit failed with ${report.failures.length} assertion failure(s). See ${out}/report.json.`);
  process.exit(1);
}
console.log(`Visual audit passed ${report.shots.length} screenshots. Report: ${out}/report.json`);
