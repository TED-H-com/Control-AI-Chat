import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';
import test from 'node:test';
import type { TenantId } from '../../shared/types.js';
import { openApprovalEnvelope, openApprovalResult, sealApprovalEnvelope, type ApprovalEnvelopePayloadV1, type SealedApprovalEnvelope } from './approval-envelope.js';

const KEY=Buffer.alloc(32,4);
function payload():ApprovalEnvelopePayloadV1 {const tenantId=randomUUID() as TenantId;return {schemaVersion:1,tenantId,approvalId:randomUUID(),violationId:randomUUID(),evaluationId:randomUUID(),runId:randomUUID(),requestingUserId:randomUUID(),conversationId:randomUUID(),sourceMessageId:randomUUID(),assistantMessageId:randomUUID(),pass:'preflight',messages:[{role:'user',content:[{type:'text',text:'Review'}]}],attachments:[],model:{catalogId:randomUUID(),provider:'openai',modelKey:'test',maxOutputTokens:100,reasoningEffort:'none'},policy:{snapshotId:randomUUID(),fingerprint:'a'.repeat(64),revision:1},createdAtMs:1};}
function encryptedInput(value:ApprovalEnvelopePayloadV1,sealed:SealedApprovalEnvelope){return{tenantId:value.tenantId,approvalId:value.approvalId,violationId:value.violationId,ciphertext:sealed.ciphertext,nonce:sealed.nonce,keyVersion:sealed.keyVersion,cryptoScheme:sealed.cryptoScheme,wrappedDek:sealed.wrappedDek,wrapNonce:sealed.wrapNonce,kekVersion:sealed.kekVersion} as const;}
function open(value:ApprovalEnvelopePayloadV1){const sealed=sealApprovalEnvelope(KEY,value);return openApprovalEnvelope(KEY,encryptedInput(value,sealed));}

function legacySeal(value:ApprovalEnvelopePayloadV1){
  const key=Buffer.from(hkdfSync('sha256',KEY,Buffer.from(value.tenantId),`${CRYPTO_NAMESPACE}:approval-payload:v1`,32)),nonce=randomBytes(12);
  try{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(`${CRYPTO_NAMESPACE}:approval-envelope:v1\n${value.tenantId}\n${value.approvalId}\n${value.violationId}\n1`));const plaintext=Buffer.from(JSON.stringify(value));return{ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]),nonce};}
  finally{key.fill(0);}
}

test('approval envelopes validate structured attachment provenance after decryption',()=>{
  const base=payload(),attachment={fileId:randomUUID(),projectId:randomUUID(),name:'evidence.txt',mimeType:'text/plain',byteSize:12,sha256:'b'.repeat(64),extractedText:'governed evidence',createdAtMs:1};
  assert.deepEqual(open({...base,attachments:[attachment]}).attachments,[attachment]);
  assert.throws(()=>open({...base,attachments:[{...attachment,byteSize:0}]}));
  assert.throws(()=>open({...base,attachments:[attachment,{...attachment,name:'duplicate'}]}));
  assert.throws(()=>open({...base,attachments:[{...attachment,sha256:'not-a-digest'}]}));
});

test('payload schema v1 envelopes with no attachment field remain readable as attachment-free',()=>{
  const {attachments:_attachments,...legacy}=payload();assert.equal(open(legacy).attachments,undefined);
});

test('DEKs are random, wrapped with the active KEK version, and remain open across KEK rotation',()=>{
  const value=payload(),keys=new Map([[1,Buffer.alloc(32,1)],[2,Buffer.alloc(32,2)]]),ring={activeVersion:2,keyForVersion:(version:number)=>keys.get(version)};
  const first=sealApprovalEnvelope(ring,value),second=sealApprovalEnvelope(ring,value);
  assert.equal(first.keyVersion,2);assert.equal(first.kekVersion,2);assert.equal(first.wrappedDek.length,48);assert.equal(first.wrapNonce.length,12);
  assert.notDeepEqual(first.wrappedDek,second.wrappedDek);assert.notDeepEqual(first.ciphertext,second.ciphertext);
  ring.activeVersion=1;
  assert.deepEqual(openApprovalEnvelope(ring,encryptedInput(value,first)),value,'old KEKs remain readable after the active version rotates');
  assert.throws(()=>openApprovalEnvelope({activeVersion:1,keyForVersion:version=>version===1?keys.get(1):undefined},encryptedInput(value,first)),/KEK is unavailable/);
  assert.throws(()=>sealApprovalEnvelope({activeVersion:3,keyForVersion:()=>Buffer.alloc(31)},value),/32 bytes/);
});

test('wrapped-key authentication binds tenant, approval and KEK version and rejects tampering',()=>{
  const value=payload(),sealed=sealApprovalEnvelope(KEY,value),input=encryptedInput(value,sealed);
  const tampered=Buffer.from(sealed.wrappedDek);tampered[0]=tampered[0]!^1;
  assert.throws(()=>openApprovalEnvelope(KEY,{...input,wrappedDek:tampered}),/Corrupt approval wrapped key/);
  assert.throws(()=>openApprovalEnvelope(KEY,{...input,tenantId:randomUUID() as TenantId}),/Corrupt approval wrapped key/);
  assert.throws(()=>openApprovalEnvelope(KEY,{...input,approvalId:randomUUID()}),/Corrupt approval wrapped key/);
  assert.throws(()=>openApprovalEnvelope(KEY,{...input,kekVersion:2}),/KEK is unavailable/);
  assert.throws(()=>openApprovalEnvelope(KEY,{...input,violationId:randomUUID()}),/Corrupt approval payload|authenticate/);
});

test('legacy stable-key envelopes remain readable but legacy result version confusion is rejected',()=>{
  const value=payload(),sealed=legacySeal(value);
  assert.deepEqual(openApprovalEnvelope(KEY,{tenantId:value.tenantId,approvalId:value.approvalId,violationId:value.violationId,ciphertext:sealed.ciphertext,nonce:sealed.nonce,keyVersion:1,cryptoScheme:'legacy_v1'}),value);
  assert.throws(()=>openApprovalResult(KEY,{tenantId:value.tenantId,approvalId:value.approvalId,ciphertext:Buffer.alloc(17),nonce:Buffer.alloc(12),cryptoScheme:'legacy_v1',keyVersion:2}),/Corrupt approval result/);
});
