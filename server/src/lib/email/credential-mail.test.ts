import assert from 'node:assert/strict';
import test from 'node:test';
import {credentialMail} from './credential-mail.js';

const at=Date.parse('2026-10-06T14:16:56.573Z'),workspace='Northstar Systems',url='https://app.example/reset-password#secret';

for(const locale of ['en','zh-TW','ja'] as const)for(const purpose of ['setup','reset'] as const)test(`${locale} ${purpose} credential mail localizes punctuation, subject, and workspace-zone expiry`,()=>{
  const message=credentialMail({to:'person@example.test',locale,workspaceName:workspace,purpose,url,expiresAt:at,timeZone:'Asia/Taipei'});
  assert.ok(message.text.includes(url));
  assert.doesNotMatch(message.text,/2026-10-06T14:16:56\.573Z/u);
  assert.match(message.text,/GMT\+8/u);
  const expiryLine=message.text.split('\n').find(line=>line.includes(locale==='en'?'This link expires at':locale==='zh-TW'?'此連結到期時間':'リンクの有効期限'));
  assert.equal(expiryLine,locale==='en'?'This link expires at Oct 6, 2026, 10:16 PM GMT+8.':locale==='zh-TW'?'此連結到期時間：2026年10月6日 下午10:16 [GMT+8]。':'リンクの有効期限：2026年10月6日 22:16 GMT+8。');
  if(locale==='en'){
    assert.match(message.subject,/^Control AI Chat: /u);
    assert.ok(message.text.includes(purpose==='setup'?`You were invited to join ${workspace}.`:`A password reset link was created for your account in ${workspace}.`));
  }else{
    assert.match(message.subject,/^【Control AI Chat】/u);
    assert.ok(message.text.includes(`「${workspace}」`));
    assert.doesNotMatch(message.text,/：[ \t]/u);
    assert.match(message.text,/GMT\+8\]?。/u);
  }
});
