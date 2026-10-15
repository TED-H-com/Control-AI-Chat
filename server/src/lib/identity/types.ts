export type AuthMethod = 'password' | 'recovery_code';
export type TenantRole = 'owner' | 'admin' | 'compliance' | 'member';
export type MfaPolicy = 'optional' | 'admins' | 'all';
import type { ACCESS_TOKEN_AUDIENCE } from './tokens.js';

export interface AccessTokenClaims {
  iss: string; aud: typeof ACCESS_TOKEN_AUDIENCE; sub: string;
  sid: string; tid: string; role: TenantRole; amr: readonly AuthMethod[];
  mfa: boolean; sv: number; jti: string; iat: number; nbf: number; exp: number;
}

export interface AuthenticatedPrincipal {
  userId: string; sessionId: string; tenantId: string; role: TenantRole;
  authMethods: readonly AuthMethod[]; mfaSatisfied: boolean;
}

export class IdentityError extends Error {
  constructor(readonly code:string, message:string, readonly retryable=false, readonly details?:Readonly<Record<string,unknown>>) { super(message); this.name='IdentityError'; }
}
