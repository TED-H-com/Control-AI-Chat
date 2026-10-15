import type {Locale} from '../../shared/api.js';
import {PRODUCT_NAME} from '../../shared/brand.js';
import type {CredentialLinkPurpose} from '../identity/credential-links.js';
import type {MailMessage} from './mailer.js';

const copy={
  en:{setupSubject:'Set up your account',resetSubject:'Reset your password',action:'Open this one-time link:',expires:'This link expires at',ignore:'If you did not expect this message, you can ignore it.'},
  'zh-TW':{setupSubject:'設定您的帳號',resetSubject:'重設您的密碼',action:'開啟此一次性連結：',expires:'此連結到期時間：',ignore:'如果您沒有預期收到這封郵件，可以忽略它。'},
  ja:{setupSubject:'アカウントを設定してください',resetSubject:'パスワードをリセットしてください',action:'この1回限りのリンクを開いてください：',expires:'リンクの有効期限：',ignore:'このメールに心当たりがない場合は、無視してください。'},
} as const;

function expiry(value:number,locale:Locale,timeZone:string):string {
  return new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short',timeZone}).format(value);
}
function lead(locale:Locale,purpose:CredentialLinkPurpose,workspaceName:string):string {
  if(locale==='zh-TW')return purpose==='setup'?`您已受邀加入「${workspaceName}」。`:`已為您在「${workspaceName}」工作空間的帳號建立密碼重設連結。`;
  if(locale==='ja')return purpose==='setup'?`「${workspaceName}」ワークスペースに招待されました。`:`「${workspaceName}」ワークスペースのアカウントにパスワードリセットリンクが発行されました。`;
  return purpose==='setup'?`You were invited to join ${workspaceName}.`:`A password reset link was created for your account in ${workspaceName}.`;
}

export function credentialMail(input:{to:string;locale:Locale;workspaceName:string;purpose:CredentialLinkPurpose;url:string;expiresAt:number;timeZone:string}):MailMessage {
  const t=copy[input.locale],subjectText=input.purpose==='setup'?t.setupSubject:t.resetSubject;
  const subject=input.locale==='en'?`${PRODUCT_NAME}: ${subjectText}`:`【${PRODUCT_NAME}】${subjectText}`;
  const separator=input.locale==='en'?' ':'',expires=`${t.expires}${separator}${expiry(input.expiresAt,input.locale,input.timeZone)}${input.locale==='en'?'.':'。'}`;
  return{to:input.to,subject,text:[subject,'',lead(input.locale,input.purpose,input.workspaceName),t.action,input.url,'',expires,t.ignore,'',PRODUCT_NAME].join('\n')};
}
