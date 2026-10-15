import type Database from 'better-sqlite3';
import type {TenantId} from '../../shared/types.js';
import type {TenantRetentionPolicy} from './audit-types.js';

interface Row {conversation_retention_days:number|null;retain_full_transcripts:number|null}

/**
 * `tenant_settings.conversation_retention_days` is `NOT NULL DEFAULT 90`, so this applies only to a
 * tenant with no settings row at all. The admin retention screen reads the same constant: if the two
 * disagreed, the screen would report a tenant as kept forever while this worker destroyed its
 * content on the schema's own default.
 */
export const DEFAULT_CONVERSATION_RETENTION_DAYS=90;

export function createTenantRetentionPolicy(database:Database.Database,now:()=>number=Date.now):(tenantId:TenantId)=>TenantRetentionPolicy {
  const read=database.prepare<[TenantId],Row>('SELECT conversation_retention_days,retain_full_transcripts FROM tenant_settings WHERE tenant_id=?');
  return tenantId=>{const row=read.get(tenantId);return{tenantId,chatTranscriptDays:row?.conversation_retention_days??DEFAULT_CONVERSATION_RETENTION_DAYS,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:(row?.retain_full_transcripts??1)===1,effectiveAtMs:now()}};
}
