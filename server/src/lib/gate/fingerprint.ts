import { createHmac } from 'node:crypto';
export function fingerprint(tenantId:string,value:string):string { return createHmac('sha256',tenantId).update(value.normalize('NFKC')).digest('hex') }
