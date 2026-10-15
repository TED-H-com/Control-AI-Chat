import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

interface ClientAddressInput {
  peer:string;
  forwarded?:string|undefined;
  suppliedSecret?:string|undefined;
  trustedProxySecret?:string|undefined;
}

function normalizedAddress(value:string|undefined):string|null {
  if(!value)return null;
  const candidate=value.trim().toLowerCase().replace(/^::ffff:/u,'');
  return isIP(candidate)===0?null:candidate;
}

function sameSecret(supplied:string|undefined,trusted:string|undefined):boolean {
  if(!supplied||!trusted)return false;
  const left=Buffer.from(supplied),right=Buffer.from(trusted);
  return left.length===right.length&&timingSafeEqual(left,right);
}

/**
 * Resolve an address only from the socket peer or from a Caddy assertion authenticated with the
 * deployment secret. Public forwarding headers are deliberately irrelevant.
 */
export function verifiedClientAddress(input:ClientAddressInput):string {
  const peer=normalizedAddress(input.peer)??'unknown';
  if(!sameSecret(input.suppliedSecret,input.trustedProxySecret))return peer;
  return normalizedAddress(input.forwarded)??peer;
}
