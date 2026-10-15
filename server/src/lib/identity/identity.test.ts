import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_NAME } from '../../shared/brand.js';
import { hashPassword, validatePassword } from './password.js';
import { generateRecoveryCodes, generateTotpSecret, otpauthUri, totp, verifyTotp } from './mfa.js';
import { issueAccessToken, verifyAccessToken } from './tokens.js';
test('password policy uses Unicode code points and rejects common passwords',()=>{assert.deepEqual(validatePassword('password123'),['minimum_length','common_password']);assert.deepEqual(validatePassword('correct horse battery staple'),[]);});
test('password policy errors expose structured rules',async()=>{await assert.rejects(hashPassword('123456789012'),error=>{assert.ok(error&&typeof error==='object'&&'code'in error&&error.code==='PASSWORD_POLICY_FAILED'&&'details'in error);assert.deepEqual(error.details,{rules:['common_password']});return true})});
test('TOTP accepts current code and rejects a bad code',()=>{const secret=generateTotpSecret(),at=1_700_000_000_000;assert.equal(verifyTotp(secret,totp(secret,at),at),true);assert.equal(verifyTotp(secret,'000000',at),false);});
test('TOTP enrollment falls back to the product issuer when branding is unset',()=>{assert.ok(otpauthUri('SECRET','person@example.com').startsWith(`otpauth://totp/${encodeURIComponent(PRODUCT_NAME)}:`));});
test('MFA recovery codes use the exact unbiased format accepted by the login screen',()=>{
 const sample=generateRecoveryCodes(20);assert.equal(new Set(sample).size,20);for(const code of sample)assert.match(code,/^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);
 const bytes=[252,253,254,255,0,35,1,34,2,33,3,32,4,31];
 assert.deepEqual(generateRecoveryCodes(1,size=>Buffer.from([...bytes,...Array(Math.max(0,size-bytes.length)).fill(0)].slice(0,size))),['A9B8C-7D6E5'],'byte values outside the even 36-character range must be rejected');
});
test('access JWT accepts the configured issuer and rejects another origin',()=>{const secret='a secure test secret with more than thirty two bytes',input={userId:'u',sessionId:'s',tenantId:'t',role:'member' as const,authMethods:['password'] as const,mfa:false,sessionVersion:1,now:100,ttlSeconds:60};const configured=issueAccessToken(input,secret,'https://chat.acme.example');assert.equal(verifyAccessToken(configured.token,secret,110,'https://chat.acme.example').sub,'u');assert.throws(()=>verifyAccessToken(configured.token,secret,110,'https://other.example'));const parts=configured.token.split('.');parts[1]=`${parts[1]!.slice(0,-1)}A`;assert.throws(()=>verifyAccessToken(parts.join('.'),secret,110,'https://chat.acme.example'));});
