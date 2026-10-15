import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { ChatMessage, ProviderId, ReasoningEffort } from '../../lib/providers/types.js';
import type { GateAction } from '../../shared/api.js';
import type { RoleKey, ToneKey } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';

const LEGACY_KEY_VERSION=1;
const DEK_KEY_VERSION=2;
const DEFAULT_KEK_VERSION=1;
const NONCE_BYTES=12;
const TAG_BYTES=16;
const MAX_ATTACHMENTS=10;
const MAX_ATTACHMENT_BYTES=25*1024*1024;
const MAX_ATTACHMENT_CODE_POINTS=1_000_000;

export interface ApprovalEnvelopeAttachmentV1 {
  readonly fileId:string;
  readonly projectId:string;
  readonly name:string;
  readonly mimeType:string;
  readonly byteSize:number;
  readonly sha256:string;
  readonly extractedText:string;
  readonly createdAtMs:number;
}

export type ApprovalAttachmentV1 = ApprovalEnvelopeAttachmentV1;

export interface ApprovalConfirmedWarningV1 {
  readonly direction:'outbound'|'file';
  readonly policyFingerprint:string;
  readonly ruleIds:readonly string[];
}

export interface ApprovalEnvelopePayloadV1 {
  readonly schemaVersion:1;
  readonly tenantId:TenantId;
  readonly approvalId:string;
  readonly violationId:string;
  readonly evaluationId:string;
  readonly runId:string;
  readonly requestingUserId:string;
  readonly conversationId:string;
  readonly sourceMessageId:string;
  readonly assistantMessageId:string;
  readonly pass:'preflight';
  readonly tone?:ToneKey;
  readonly role?:RoleKey;
  readonly assistantId?:string;
  readonly assistantPrompt?:string;
  /** Pre-tokenization context. A release must re-run the current gate before using it. */
  readonly messages:readonly ChatMessage[];
  /** Absent only on legacy envelopes created before chat attachments were supported. */
  readonly attachments?:readonly ApprovalEnvelopeAttachmentV1[];
  /** Encrypted evidence of warnings the requester already confirmed under this exact policy. */
  readonly confirmedWarnings?:readonly ApprovalConfirmedWarningV1[];
  readonly model:{
    readonly catalogId:string;
    readonly provider:ProviderId;
    readonly modelKey:string;
    readonly maxOutputTokens:number;
    /** Absent only on envelopes created before allowance-aware routing. */
    readonly estimatedOutputTokens?:number;
    readonly reasoningEffort:ReasoningEffort;
  };
  readonly policy:{readonly snapshotId:string;readonly fingerprint:string;readonly revision:number};
  readonly createdAtMs:number;
}

export interface SealedApprovalEnvelope {
  readonly ciphertext:Buffer;
  readonly nonce:Buffer;
  readonly keyVersion:number;
  readonly digest:string;
  readonly cryptoScheme:'dek_v2';
  readonly wrappedDek:Buffer;
  readonly wrapNonce:Buffer;
  readonly kekVersion:number;
}

export interface ApprovalKekKeyring {
  readonly activeVersion:number;
  readonly keyForVersion:(version:number)=>Uint8Array|undefined;
}

export interface ApprovalDekReference {
  readonly cryptoScheme?:'legacy_v1'|'dek_v2';
  readonly wrappedDek?:Uint8Array|null|undefined;
  readonly wrapNonce?:Uint8Array|null|undefined;
  readonly kekVersion?:number|null|undefined;
  readonly keyVersion?:number;
}

function isBoundedString(value:unknown,max:number):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=max;
}

function validateAttachments(value:unknown):void {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>MAX_ATTACHMENTS)throw new TypeError('Corrupt approval payload');
  let codePoints=0;
  const ids=new Set<string>();
  for(const candidate of value as unknown[]){
    if(!candidate||typeof candidate!=='object')throw new TypeError('Corrupt approval payload');
    const file=candidate as Partial<ApprovalEnvelopeAttachmentV1>;
    if(!isBoundedString(file.fileId,256)||ids.has(file.fileId)
      ||!isBoundedString(file.projectId,256)||!isBoundedString(file.name,1024)||!isBoundedString(file.mimeType,256)
      ||!Number.isSafeInteger(file.byteSize)||file.byteSize!<1||file.byteSize!>MAX_ATTACHMENT_BYTES
      ||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(file.sha256)
      ||typeof file.extractedText!=='string'
      ||!Number.isSafeInteger(file.createdAtMs)||file.createdAtMs!<0)
      throw new TypeError('Corrupt approval payload');
    ids.add(file.fileId);
    codePoints+=Array.from(file.extractedText).length;
    if(codePoints>MAX_ATTACHMENT_CODE_POINTS)throw new TypeError('Corrupt approval payload');
  }
}

function validateConfirmedWarnings(value:unknown):void {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>2)throw new TypeError('Corrupt approval payload');
  const directions=new Set<string>();
  for(const candidate of value as unknown[]){
    if(!candidate||typeof candidate!=='object')throw new TypeError('Corrupt approval payload');
    const warning=candidate as Partial<ApprovalConfirmedWarningV1>;
    if((warning.direction!=='file'&&warning.direction!=='outbound')||directions.has(warning.direction)
      ||typeof warning.policyFingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(warning.policyFingerprint)
      ||!Array.isArray(warning.ruleIds)||warning.ruleIds.length===0||warning.ruleIds.length>100
      ||warning.ruleIds.some(id=>typeof id!=='string'||id.length===0||id.length>256)
      ||new Set(warning.ruleIds).size!==warning.ruleIds.length)throw new TypeError('Corrupt approval payload');
    directions.add(warning.direction);
  }
}

export interface ApprovalReleaseResultV1 {
  readonly schemaVersion:1;
  readonly tenantId:TenantId;
  readonly approvalId:string;
  readonly outputText:string;
  readonly providerRequestId:string|null;
  readonly finishReason:string|null;
  readonly usage:{readonly inputTokens:number;readonly outputTokens:number;readonly cachedInputTokens:number;readonly estimated:boolean};
  readonly files:readonly ({
    readonly fileId:string;
    readonly projectId:string;
    readonly evaluationId:string;
    readonly action:GateAction;
    readonly ruleIds:readonly string[];
    readonly detectorKeys:readonly string[];
    readonly protectedItemCount:number;
    readonly contentDigest:string;
    readonly latencyMs:number;
    readonly currentRevision:number;
  })[];
  readonly preflight:{
    readonly evaluationId:string;
    readonly action:GateAction;
    readonly ruleIds:readonly string[];
    readonly detectorKeys:readonly string[];
    readonly protectedItemCount:number;
    readonly contentDigest:string;
    readonly latencyMs:number;
    readonly currentRevision:number;
  };
  readonly postflight:{
    readonly evaluationId:string;
    readonly action:GateAction;
    readonly ruleIds:readonly string[];
    readonly detectorKeys:readonly string[];
    readonly protectedItemCount:number;
    readonly contentDigest:string;
    readonly latencyMs:number;
    readonly withheld:boolean;
    /** The worker's local authorization snapshot, not values echoed by a gate implementation. */
    readonly policyFingerprint:string;
    readonly groupIds:readonly string[];
    readonly roles:readonly ('owner'|'admin'|'compliance'|'member')[];
  };
}

function purposeKey(rootKey:Uint8Array,tenantId:TenantId,purpose:string):Buffer {
  if(rootKey.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256',rootKey,Buffer.from(tenantId),`${CRYPTO_NAMESPACE}:${purpose}:v1`,32));
}

function legacyAad(tenantId:TenantId,approvalId:string,violationId:string,keyVersion:number):Buffer {
  return Buffer.from(`${CRYPTO_NAMESPACE}:approval-envelope:v1\n${tenantId}\n${approvalId}\n${violationId}\n${keyVersion}`);
}

function legacyResultAad(tenantId:TenantId,approvalId:string,keyVersion:number):Buffer {
  return Buffer.from(`${CRYPTO_NAMESPACE}:approval-result:v1\n${tenantId}\n${approvalId}\n${keyVersion}`);
}

function envelopeAad(tenantId:TenantId,approvalId:string,violationId:string):Buffer {
  return Buffer.from(`${CRYPTO_NAMESPACE}:approval-envelope:v2\n${tenantId}\n${approvalId}\n${violationId}\n${DEK_KEY_VERSION}`);
}

function resultAad(tenantId:TenantId,approvalId:string):Buffer {
  return Buffer.from(`${CRYPTO_NAMESPACE}:approval-result:v2\n${tenantId}\n${approvalId}\n${DEK_KEY_VERSION}`);
}

function wrapAad(tenantId:TenantId,approvalId:string,kekVersion:number):Buffer {
  return Buffer.from(`${CRYPTO_NAMESPACE}:approval-dek-wrap:v1\n${tenantId}\n${approvalId}\n${kekVersion}`);
}

export type ApprovalKeySource=Uint8Array|ApprovalKekKeyring;

function activeRoot(source:ApprovalKeySource):{root:Uint8Array;version:number}{
  if(source instanceof Uint8Array){if(source.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');return{root:source,version:DEFAULT_KEK_VERSION};}
  if(!Number.isSafeInteger(source.activeVersion)||source.activeVersion<1)throw new TypeError('Invalid approval KEK version');
  const root=source.keyForVersion(source.activeVersion);
  if(!root)throw new TypeError('Approval KEK is unavailable');
  if(root.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');
  return{root,version:source.activeVersion};
}

function rootForVersion(source:ApprovalKeySource,version:number):Uint8Array {
  if(!Number.isSafeInteger(version)||version<1)throw new TypeError('Corrupt approval wrapped key');
  if(source instanceof Uint8Array){if(source.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');if(version!==DEFAULT_KEK_VERSION)throw new TypeError('Approval KEK is unavailable');return source;}
  const root=source.keyForVersion(version);
  if(!root)throw new TypeError('Approval KEK is unavailable');
  if(root.byteLength!==32)throw new TypeError('Approval payload key must be 32 bytes');
  return root;
}

function encrypt(key:Uint8Array,nonce:Uint8Array,aadValue:Uint8Array,plaintext:Uint8Array):Buffer {
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aadValue);
  return Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
}

function decrypt(key:Uint8Array,nonce:Uint8Array,aadValue:Uint8Array,ciphertextValue:Uint8Array,error:string):Buffer {
  if(nonce.byteLength!==NONCE_BYTES||ciphertextValue.byteLength<=TAG_BYTES)throw new TypeError(error);
  const ciphertext=Buffer.from(ciphertextValue),body=ciphertext.subarray(0,ciphertext.length-TAG_BYTES),tag=ciphertext.subarray(ciphertext.length-TAG_BYTES);
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce));decipher.setAAD(aadValue);decipher.setAuthTag(tag);
  let updated:Buffer|undefined,final:Buffer|undefined;
  try{updated=decipher.update(body);final=decipher.final();return Buffer.concat([updated,final]);}
  finally{updated?.fill(0);final?.fill(0);}
}

function unwrapDek(source:ApprovalKeySource,tenantId:TenantId,approvalId:string,reference:ApprovalDekReference):Buffer {
  if(reference.cryptoScheme!=='dek_v2'||reference.keyVersion!==DEK_KEY_VERSION||!reference.wrappedDek||!reference.wrapNonce||reference.kekVersion==null
    ||reference.wrappedDek.byteLength!==32+TAG_BYTES||reference.wrapNonce.byteLength!==NONCE_BYTES)
    throw new TypeError('Corrupt approval wrapped key');
  const root=rootForVersion(source,reference.kekVersion),kek=purposeKey(root,tenantId,'approval-dek-wrap');
  try{
    const dek=decrypt(kek,reference.wrapNonce,wrapAad(tenantId,approvalId,reference.kekVersion),reference.wrappedDek,'Corrupt approval wrapped key');
    if(dek.byteLength!==32){dek.fill(0);throw new TypeError('Corrupt approval wrapped key');}
    return dek;
  }catch(error){if(error instanceof TypeError&&error.message==='Approval KEK is unavailable')throw error;throw new TypeError('Corrupt approval wrapped key',{cause:error});}
  finally{kek.fill(0);}
}

/** A tenant-keyed digest is safe to expose for correlation; an offline dictionary cannot reproduce it. */
export function protectedContentDigest(rootKey:Uint8Array,tenantId:TenantId,content:string):string {
  const key=purposeKey(rootKey,tenantId,'gate-content-digest');
  try{return createHmac('sha256',key).update(content,'utf8').digest('hex');}
  finally{key.fill(0);}
}

/** Protects the route's deterministic request hash before it is persisted for replay comparison. */
export function protectedIdempotencyDigest(rootKey:Uint8Array,tenantId:TenantId,requestHash:string):string {
  const key=purposeKey(rootKey,tenantId,'chat-idempotency-digest');
  try{return createHmac('sha256',key).update(requestHash,'ascii').digest('hex');}
  finally{key.fill(0);}
}

export function sealApprovalEnvelope(keySource:ApprovalKeySource,payload:ApprovalEnvelopePayloadV1):SealedApprovalEnvelope {
  const active=activeRoot(keySource),nonce=randomBytes(NONCE_BYTES),wrapNonce=randomBytes(NONCE_BYTES);
  const kek=purposeKey(active.root,payload.tenantId,'approval-dek-wrap');
  let plaintext:Buffer|undefined,dek:Buffer|undefined;
  try {
    plaintext=Buffer.from(JSON.stringify(payload),'utf8');dek=randomBytes(32);
    const ciphertext=encrypt(dek,nonce,envelopeAad(payload.tenantId,payload.approvalId,payload.violationId),plaintext);
    const wrappedDek=encrypt(kek,wrapNonce,wrapAad(payload.tenantId,payload.approvalId,active.version),dek);
    // Digest the randomized ciphertext, not the low-entropy employee prompt inside it. AES-GCM
    // authenticates the plaintext; this digest is only a storage/correlation check and must not be
    // usable as an offline prompt-guessing oracle.
    return {ciphertext,nonce,keyVersion:DEK_KEY_VERSION,digest:createHash('sha256').update(ciphertext).digest('hex'),
      cryptoScheme:'dek_v2',wrappedDek,wrapNonce,kekVersion:active.version};
  } finally {
    plaintext?.fill(0);dek?.fill(0);kek.fill(0);
  }
}

export function openApprovalEnvelope(keySource:ApprovalKeySource,input:{
  readonly tenantId:TenantId;
  readonly approvalId:string;
  readonly violationId:string;
  readonly ciphertext:Uint8Array;
  readonly nonce:Uint8Array;
  readonly keyVersion:number;
  readonly cryptoScheme?:'legacy_v1'|'dek_v2';
  readonly wrappedDek?:Uint8Array|null;
  readonly wrapNonce?:Uint8Array|null;
  readonly kekVersion?:number|null;
}):ApprovalEnvelopePayloadV1 {
  const scheme=input.cryptoScheme??'legacy_v1';
  if(scheme!=='legacy_v1'&&scheme!=='dek_v2')throw new TypeError('Corrupt approval payload');
  if((scheme==='legacy_v1'&&input.keyVersion!==LEGACY_KEY_VERSION)||(scheme==='dek_v2'&&input.keyVersion!==DEK_KEY_VERSION))throw new TypeError('Corrupt approval payload');
  const key=scheme==='dek_v2'
    ?unwrapDek(keySource,input.tenantId,input.approvalId,{cryptoScheme:scheme,keyVersion:input.keyVersion,wrappedDek:input.wrappedDek,wrapNonce:input.wrapNonce,kekVersion:input.kekVersion})
    :purposeKey(rootForVersion(keySource,DEFAULT_KEK_VERSION),input.tenantId,'approval-payload');
  let plaintext:Buffer|undefined;
  try {
    plaintext=decrypt(key,input.nonce,scheme==='dek_v2'?envelopeAad(input.tenantId,input.approvalId,input.violationId):legacyAad(input.tenantId,input.approvalId,input.violationId,input.keyVersion),input.ciphertext,'Corrupt approval payload');
    const payload=JSON.parse(plaintext.toString('utf8')) as Partial<ApprovalEnvelopePayloadV1>;
    if(payload.schemaVersion!==1||payload.tenantId!==input.tenantId||payload.approvalId!==input.approvalId||payload.violationId!==input.violationId)
      throw new TypeError('Corrupt approval payload');
    validateAttachments(payload.attachments);
    validateConfirmedWarnings(payload.confirmedWarnings);
    return payload as ApprovalEnvelopePayloadV1;
  } finally {
    plaintext?.fill(0);key.fill(0);
  }
}

export function sealApprovalResult(keySource:ApprovalKeySource,payload:ApprovalReleaseResultV1,reference?:ApprovalDekReference):Pick<SealedApprovalEnvelope,'ciphertext'|'nonce'|'keyVersion'|'digest'> {
  const nonce=randomBytes(NONCE_BYTES),scheme=reference?.cryptoScheme??'legacy_v1';
  if(scheme!=='legacy_v1'&&scheme!=='dek_v2')throw new TypeError('Corrupt approval result');
  const key=scheme==='dek_v2'?unwrapDek(keySource,payload.tenantId,payload.approvalId,reference!):purposeKey(rootForVersion(keySource,DEFAULT_KEK_VERSION),payload.tenantId,'approval-result');
  let plaintext:Buffer|undefined;
  try{
    plaintext=Buffer.from(JSON.stringify(payload),'utf8');
    const ciphertext=encrypt(key,nonce,scheme==='dek_v2'?resultAad(payload.tenantId,payload.approvalId):legacyResultAad(payload.tenantId,payload.approvalId,LEGACY_KEY_VERSION),plaintext);
    return {ciphertext,nonce,keyVersion:scheme==='dek_v2'?DEK_KEY_VERSION:LEGACY_KEY_VERSION,digest:createHash('sha256').update(ciphertext).digest('hex')};
  }finally{plaintext?.fill(0);key.fill(0);}
}

export function openApprovalResult(keySource:ApprovalKeySource,input:{
  readonly tenantId:TenantId;readonly approvalId:string;readonly ciphertext:Uint8Array;readonly nonce:Uint8Array;
  readonly cryptoScheme?:'legacy_v1'|'dek_v2';readonly wrappedDek?:Uint8Array|null;readonly wrapNonce?:Uint8Array|null;
  readonly kekVersion?:number|null;readonly keyVersion?:number;
}):ApprovalReleaseResultV1 {
  const scheme=input.cryptoScheme??'legacy_v1',keyVersion=input.keyVersion??LEGACY_KEY_VERSION;
  if(scheme!=='legacy_v1'&&scheme!=='dek_v2')throw new TypeError('Corrupt approval result');
  if((scheme==='legacy_v1'&&keyVersion!==LEGACY_KEY_VERSION)||(scheme==='dek_v2'&&keyVersion!==DEK_KEY_VERSION))throw new TypeError('Corrupt approval result');
  const key=scheme==='dek_v2'?unwrapDek(keySource,input.tenantId,input.approvalId,{...input,keyVersion,cryptoScheme:scheme}):purposeKey(rootForVersion(keySource,DEFAULT_KEK_VERSION),input.tenantId,'approval-result');
  let plaintext:Buffer|undefined;
  try{
    plaintext=decrypt(key,input.nonce,scheme==='dek_v2'?resultAad(input.tenantId,input.approvalId):legacyResultAad(input.tenantId,input.approvalId,LEGACY_KEY_VERSION),input.ciphertext,'Corrupt approval result');
    const value=JSON.parse(plaintext.toString('utf8')) as Partial<ApprovalReleaseResultV1>;
    if(value.schemaVersion!==1||value.tenantId!==input.tenantId||value.approvalId!==input.approvalId)throw new TypeError('Corrupt approval result');
    return value as ApprovalReleaseResultV1;
  }finally{plaintext?.fill(0);key.fill(0);}
}
