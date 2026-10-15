import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type Database from 'better-sqlite3';
import type { AuditService, AuditTransaction } from '../../lib/audit/index.js';
import type { JsonObject, TargetType } from '../../lib/audit/audit-types.js';
import { createDurableMutationIdempotency, MutationIdempotencyError } from '../idempotency/mutation.js';
import { GovernanceError } from '../../lib/governance/errors.js';
import { DefaultGateEngine } from '../../lib/gate/engine.js';
import { deterministicDetectors } from '../../lib/gate/registry.js';
import type { DetectorKind, GateAction, ResolvedRule } from '../../lib/gate/types.js';
import { GATE_ACTION_RANK } from '../../lib/gate/action.js';
import { assertGovernancePermission, type GovernancePermission } from '../../lib/governance/permissions.js';
import type { TenantRole } from '../../lib/governance/types.js';
import type { TenantDb } from '../../lib/db.js';
import { normalizeEmail } from '../../lib/identity/password.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { TenantId } from '../../shared/types.js';
import { LOCALES, type CredentialLinkResponse, type DeliveredCredentialLink, type ErrorReason, type Locale } from '../../shared/api.js';
import { TimeZoneValidationError, canonicalTimeZone } from '../../lib/timezone.js';
import { adminCapabilities, adminDashboardSummary, workspaceTimeZone, type ConsoleStatements } from './capabilities.js';
import { analyticsBreakdown, analyticsDetectors, analyticsTimeseries, resolveRange, type AnalyticsStatements } from './analytics.js';
import { generateNudges, warnProceededCount, type NudgeStatements } from './nudges.js';
import type { DirectoryReader } from './directory.js';
import { assistantWire, budgetWire, detectorWire, groupWire, modelWire, providerWire } from './wire.js';
import { createDiskBlobStore } from '../files/storage.js';
import { imageDimensions, imagePixelsAllowed, sniffMime } from '../../lib/extraction/security.js';
import { MIME } from '../../lib/extraction/types.js';
import type {Mailer,MailLogger} from '../../lib/email/mailer.js';
import {credentialMail} from '../../lib/email/credential-mail.js';
import {ADMIN_RESET_LINK_TTL_MS,SETUP_LINK_TTL_MS,issueCredentialLinkInTransaction,type CredentialLinkPurpose} from '../../lib/identity/credential-links.js';
import { accountActions, canActOnAccount, credentialLinkForAccount, tenantRoles } from './user-account-policy.js';

type Row = Record<string, unknown>;
type Body = Record<string, unknown>;
type Statement = Database.Statement<[TenantId, ...unknown[]], Row>;

export interface AdminStatements {
  readonly getSettings: Statement; readonly updateSettings: Statement;
  readonly listUsers: Statement; readonly getUser: Statement; readonly getUserByEmail: Statement; readonly insertUser: Statement; readonly updateUser: Statement; readonly deleteUser: Statement; readonly cancelUserCredentialLinks:Statement; readonly forceLogoutUserSessions:Statement;
  readonly listUserRoles: Statement; readonly listUserGroups: Statement; readonly roleId: Statement; readonly clearAssignableRoles: Statement; readonly assignRole: Statement;
  readonly listGroups: Statement; readonly getGroup: Statement; readonly insertGroup: Statement; readonly updateGroup: Statement; readonly deleteGroup: Statement; readonly updateGroupVersion:Statement; readonly addMember: Statement; readonly removeMember: Statement;
  readonly listModels: Statement; readonly getModel: Statement; readonly insertModel: Statement; readonly updateModel: Statement; readonly enableGroupModel: Statement; readonly disableGroupModel: Statement;
  readonly listAssistants: Statement; readonly getAssistant: Statement; readonly insertAssistant: Statement; readonly updateAssistant: Statement; readonly deleteAssistant: Statement;
  readonly listProviders: Statement; readonly getProviderAccess:Statement; readonly insertProviderAccess:Statement; readonly updateProviderAccess:Statement;
  readonly listBudgets: Statement; readonly getBudget: Statement; readonly insertBudget: Statement; readonly updateBudget: Statement; readonly deleteBudget: Statement;
  readonly listPolicies: Statement; readonly listRules: Statement; readonly getRule: Statement; readonly insertRule: Statement; readonly updateRule: Statement; readonly deleteRule: Statement;
  readonly listDetectors: Statement; readonly getDetector: Statement; readonly insertDetector: Statement; readonly updateDetector: Statement; readonly deleteDetector: Statement;
  readonly customTermsDetector:Statement; readonly customTermsPolicy:Statement; readonly customTermsRules:Statement; readonly updateCustomTermsRule:Statement;
  readonly complianceRules:Statement;
  readonly listLegalHolds:Statement; readonly listLegalHoldUsers:Statement; readonly legalHoldTargetUser:Statement; readonly legalHoldTargetProject:Statement; readonly legalHoldTargetConversation:Statement;
  readonly insertLegalHold:Statement; readonly getLegalHold:Statement; readonly releaseLegalHold:Statement;
}

/** Preparation is deliberately separate from request execution; execution always uses TenantDb. */
export function prepareAdminStatements(database: Database.Database): AdminStatements {
  const p = (sql:string):Statement => {
    // TenantDb always binds tenantId first. Prefix updates/deletes so that invariant also
    // holds when the tenant predicate appears textually after SET expressions.
    if (/^(?:UPDATE|DELETE)\s/u.test(sql)) sql=`WITH tenant_scope(id) AS (VALUES (?)) ${sql.replace('tenant_id=?','tenant_id=(SELECT id FROM tenant_scope)')}`;
    return database.prepare(sql) as Statement;
  };
  return {
    getSettings:p(`SELECT t.name,t.slug,t.status,s.* FROM tenant_settings s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=?`),
    updateSettings:p(`UPDATE tenant_settings SET default_locale=COALESCE(?,default_locale),timezone=COALESCE(?,timezone),conversation_retention_days=COALESCE(?,conversation_retention_days),retain_full_transcripts=COALESCE(?,retain_full_transcripts),requests_per_minute=COALESCE(?,requests_per_minute),concurrent_streams=COALESCE(?,concurrent_streams),updated_at=?,updated_by_user_id=? WHERE tenant_id=? AND updated_at=? RETURNING *`),
    listUsers:p(`WITH q(tenant_id,search,status,role_key,group_value,mfa) AS (VALUES (?,?,?,?,?,?))
      SELECT u.id,u.email,u.display_name,u.status,u.locale,u.totp_enabled_at,u.created_at,u.updated_at,u.last_login_at
      FROM users u JOIN q ON u.tenant_id=q.tenant_id
      WHERE u.deleted_at IS NULL
        AND (q.search IS NULL OR u.display_name LIKE q.search ESCAPE '\\' COLLATE NOCASE OR u.email LIKE q.search ESCAPE '\\' COLLATE NOCASE)
        AND (q.status IS NULL OR u.status=q.status)
        AND (q.mfa IS NULL OR (q.mfa='enabled' AND u.totp_enabled_at IS NOT NULL) OR (q.mfa='disabled' AND u.totp_enabled_at IS NULL))
        AND (q.role_key IS NULL OR EXISTS (
          SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
          WHERE ur.tenant_id=u.tenant_id AND ur.user_id=u.id AND r.key=q.role_key COLLATE NOCASE
        ))
        AND (q.group_value IS NULL OR EXISTS (
          SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id AND g.tenant_id=gm.tenant_id
          WHERE gm.tenant_id=u.tenant_id AND gm.user_id=u.id AND g.deleted_at IS NULL
            AND (g.id=q.group_value OR g.name=q.group_value COLLATE NOCASE)
        ))
      ORDER BY u.display_name,u.id`),
    getUser:p(`SELECT id,email,display_name,status,locale,totp_enabled_at,created_at,updated_at,last_login_at FROM users WHERE tenant_id=? AND id=? AND deleted_at IS NULL`),
    getUserByEmail:p(`SELECT id,email,display_name,status,locale,totp_enabled_at,created_at,updated_at,last_login_at FROM users WHERE tenant_id=? AND email=?`),
    insertUser:p(`INSERT INTO users(tenant_id,id,email,display_name,status,locale,created_at,updated_at) VALUES(?, ?, ?, ?, 'invited',?, ?, ?) RETURNING id,email,display_name,status,locale,totp_enabled_at,created_at,updated_at,last_login_at`),
    updateUser:p(`UPDATE users SET display_name=COALESCE(?,display_name),status=COALESCE(?,status),locale=COALESCE(?,locale),updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND deleted_at IS NULL RETURNING id,email,display_name,status,locale,totp_enabled_at,created_at,updated_at,last_login_at`),
    deleteUser:p(`UPDATE users SET status='deprovisioned',deleted_at=?,updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND deleted_at IS NULL`),
    cancelUserCredentialLinks:p(`UPDATE credential_links SET superseded_at=? WHERE tenant_id=? AND user_id=? AND consumed_at IS NULL AND superseded_at IS NULL`),
    forceLogoutUserSessions:p(`UPDATE sessions SET revoked_at=?,revoke_reason=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`),
    listUserRoles:p(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.tenant_id=? AND ur.user_id=? ORDER BY r.key`),
    listUserGroups:p(`SELECT g.id,g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.tenant_id=? AND gm.user_id=? AND g.deleted_at IS NULL ORDER BY g.name`),
    roleId:p(`SELECT id FROM roles WHERE (tenant_id=? OR tenant_id IS NULL) AND key=? ORDER BY tenant_id DESC LIMIT 1`),
    clearAssignableRoles:p(`DELETE FROM user_roles WHERE tenant_id=? AND user_id=? AND role_id IN (SELECT id FROM roles WHERE key IN ('admin','compliance','member'))`),
    assignRole:p(`WITH tenant_scope(id) AS (VALUES (?)) INSERT INTO user_roles(tenant_id,user_id,role_id,granted_by_user_id,created_at) SELECT tenant_scope.id,?,?,?,? FROM tenant_scope WHERE EXISTS(SELECT 1 FROM users WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND deleted_at IS NULL)`),
    listGroups:p(`SELECT g.id,g.name,g.description,g.is_system,g.created_at,g.updated_at,COUNT(gm.user_id) member_count FROM groups g LEFT JOIN group_members gm ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id WHERE g.tenant_id=? AND g.deleted_at IS NULL GROUP BY g.id ORDER BY g.name,g.id`),
    getGroup:p(`SELECT g.id,g.name,g.description,g.is_system,g.created_at,g.updated_at,(SELECT COUNT(*) FROM group_members gm WHERE gm.tenant_id=g.tenant_id AND gm.group_id=g.id) member_count FROM groups g WHERE g.tenant_id=? AND g.id=? AND g.deleted_at IS NULL`),
    insertGroup:p(`INSERT INTO groups(tenant_id,id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?) RETURNING id,name,description,is_system,created_at,updated_at,0 member_count`),
    updateGroup:p(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE groups SET name=COALESCE(?,name),description=CASE WHEN ? THEN ? ELSE description END,updated_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND updated_at=? AND deleted_at IS NULL AND is_system=0 RETURNING id,name,description,is_system,created_at,updated_at,(SELECT COUNT(*) FROM group_members WHERE tenant_id=(SELECT id FROM tenant_scope) AND group_id=groups.id) member_count`),
    deleteGroup:p(`UPDATE groups SET deleted_at=?,updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND deleted_at IS NULL AND is_system=0`),
    updateGroupVersion:p(`UPDATE groups SET updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND deleted_at IS NULL RETURNING updated_at`),
    addMember:p(`WITH tenant_scope(id) AS (VALUES (?)) INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) SELECT g.tenant_id,g.id,u.id,'manual',? FROM groups g JOIN users u ON u.tenant_id=g.tenant_id WHERE g.tenant_id=(SELECT id FROM tenant_scope) AND g.id=? AND u.id=? AND g.deleted_at IS NULL AND u.deleted_at IS NULL ON CONFLICT(group_id,user_id) DO NOTHING`),
    removeMember:p(`DELETE FROM group_members WHERE tenant_id=? AND group_id=? AND user_id=? AND source='manual'`),
    listModels:p(`SELECT m.*,(SELECT COUNT(*) FROM group_model_access a JOIN groups g ON g.id=a.group_id WHERE g.tenant_id=m.tenant_id AND a.model_catalog_id=m.id AND a.enabled=1) enabled_group_count FROM model_catalog m WHERE m.tenant_id=? ORDER BY m.provider_key,m.display_name`),
    getModel:p(`SELECT * FROM model_catalog WHERE tenant_id=? AND id=?`),
    insertModel:p(`INSERT INTO model_catalog(tenant_id,id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,preference_weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`),
    updateModel:p(`UPDATE model_catalog SET display_name=COALESCE(?,display_name),enabled=COALESCE(?,enabled),context_window=COALESCE(?,context_window),max_output_tokens=COALESCE(?,max_output_tokens),input_microusd_per_million=COALESCE(?,input_microusd_per_million),output_microusd_per_million=COALESCE(?,output_microusd_per_million),capabilities_json=COALESCE(?,capabilities_json),preference_weight=COALESCE(?,preference_weight),updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? RETURNING *`),
    enableGroupModel:p(`INSERT INTO group_model_access(group_id,model_catalog_id,enabled) SELECT g.id,m.id,1 FROM groups g JOIN model_catalog m ON m.tenant_id=g.tenant_id WHERE g.tenant_id=? AND g.id=? AND m.id=? ON CONFLICT(group_id,model_catalog_id) DO UPDATE SET enabled=1`),
    disableGroupModel:p(`UPDATE group_model_access SET enabled=0 WHERE group_id IN (SELECT id FROM groups WHERE tenant_id=? AND id=?) AND model_catalog_id=?`),
    listAssistants:p(`SELECT a.*,m.display_name model FROM assistants a JOIN model_catalog m ON m.id=a.model_catalog_id AND m.tenant_id=a.tenant_id WHERE a.tenant_id=? ORDER BY a.name,a.id`),
    getAssistant:p(`SELECT a.*,m.display_name model FROM assistants a JOIN model_catalog m ON m.id=a.model_catalog_id AND m.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.id=?`),
    insertAssistant:p(`INSERT INTO assistants(tenant_id,id,name,description,system_prompt,model_catalog_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) RETURNING *`),
    updateAssistant:p(`UPDATE assistants SET name=COALESCE(?,name),description=CASE WHEN ? THEN ? ELSE description END,system_prompt=COALESCE(?,system_prompt),model_catalog_id=COALESCE(?,model_catalog_id),updated_at=?,version=version+1 WHERE tenant_id=? AND id=? AND version=? RETURNING *`),
    deleteAssistant:p(`DELETE FROM assistants WHERE tenant_id=? AND id=?`),
    listProviders:p(`SELECT pc.provider_key,pc.enabled,pc.credential_source,pc.base_url,pc.updated_at,pc.credential_ciphertext IS NOT NULL credential_configured,
      CASE WHEN pc.credential_source='encrypted' THEN json_extract(pc.config_json,'$.maskedSuffix') END credential_masked_suffix,
      g.id group_id,g.name group_name,COALESCE(gpa.enabled,0) group_enabled,gpa.version group_version
      FROM provider_config pc LEFT JOIN group_provider_access gpa ON gpa.provider_config_id=pc.id
      LEFT JOIN groups g ON g.id=gpa.group_id AND g.deleted_at IS NULL
      WHERE pc.tenant_id=? ORDER BY pc.provider_key,g.name`),
    getProviderAccess:p(`SELECT g.id group_id,pc.provider_key provider_id,gpa.enabled relationship_enabled,gpa.version relationship_version
      FROM groups g JOIN provider_config pc ON pc.tenant_id=g.tenant_id
      LEFT JOIN group_provider_access gpa ON gpa.group_id=g.id AND gpa.provider_config_id=pc.id
      WHERE g.tenant_id=? AND g.id=? AND g.deleted_at IS NULL AND pc.provider_key=?`),
    insertProviderAccess:p(`WITH tenant_scope(id) AS (VALUES (?))
      INSERT INTO group_provider_access(group_id,provider_config_id,enabled,version)
      SELECT g.id,pc.id,?,1 FROM groups g JOIN provider_config pc ON pc.tenant_id=g.tenant_id
      WHERE g.tenant_id=(SELECT id FROM tenant_scope) AND g.id=? AND g.deleted_at IS NULL AND pc.provider_key=? AND ?=0
        AND NOT EXISTS(SELECT 1 FROM group_provider_access WHERE group_id=g.id AND provider_config_id=pc.id)
      RETURNING enabled,version`),
    updateProviderAccess:p(`WITH tenant_scope(id) AS (VALUES (?))
      UPDATE group_provider_access SET enabled=?,version=version+1
      WHERE group_id=(SELECT id FROM groups WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND deleted_at IS NULL)
        AND provider_config_id=(SELECT id FROM provider_config WHERE tenant_id=(SELECT id FROM tenant_scope) AND provider_key=?)
        AND version=? RETURNING enabled,version`),
    listBudgets:p(`SELECT b.*,CASE b.scope_type WHEN 'group' THEN g.name WHEN 'user' THEN COALESCE(u.display_name,u.email) ELSE NULL END scope_name FROM budgets b LEFT JOIN groups g ON b.scope_type='group' AND g.tenant_id=b.tenant_id AND g.id=b.scope_id AND g.deleted_at IS NULL LEFT JOIN users u ON b.scope_type='user' AND u.tenant_id=b.tenant_id AND u.id=b.scope_id AND u.deleted_at IS NULL WHERE b.tenant_id=? ORDER BY b.scope_type,b.scope_id,b.period,b.metric`), getBudget:p(`SELECT * FROM budgets WHERE tenant_id=? AND id=?`),
    insertBudget:p(`INSERT INTO budgets(tenant_id,id,scope_type,scope_id,period,metric,soft_limit,hard_limit,timezone,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`),
    updateBudget:p(`UPDATE budgets SET soft_limit=CASE WHEN ? THEN ? ELSE soft_limit END,hard_limit=COALESCE(?,hard_limit),timezone=COALESCE(?,timezone),enabled=COALESCE(?,enabled),updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? RETURNING *`), deleteBudget:p(`UPDATE budgets SET enabled=0,updated_at=? WHERE tenant_id=? AND id=? AND updated_at=?`),
    listPolicies:p(`SELECT id,name,description,enabled,priority,created_at,updated_at FROM policies WHERE tenant_id=? AND deleted_at IS NULL ORDER BY priority,name,id`),
    listRules:p(`SELECT pr.*,p.name policy_name,d.key detector_key,d.kind detector_kind FROM policy_rules pr JOIN policies p ON p.id=pr.policy_id JOIN detector_definitions d ON d.id=pr.detector_id WHERE pr.tenant_id=? ORDER BY pr.priority,pr.id`),
    getRule:p(`SELECT pr.*,p.name policy_name,d.key detector_key,d.kind detector_kind FROM policy_rules pr JOIN policies p ON p.id=pr.policy_id JOIN detector_definitions d ON d.id=pr.detector_id WHERE pr.tenant_id=? AND pr.id=?`),
    insertRule:p(`WITH tenant_scope(id) AS (VALUES (?)) INSERT INTO policy_rules(tenant_id,id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) SELECT tenant_scope.id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM tenant_scope WHERE EXISTS(SELECT 1 FROM policies WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?) AND EXISTS(SELECT 1 FROM detector_definitions WHERE (tenant_id=(SELECT id FROM tenant_scope) OR tenant_id IS NULL) AND id=?) RETURNING *`),
    updateRule:p(`UPDATE policy_rules SET scope_type=COALESCE(?,scope_type),scope_id=?,direction=COALESCE(?,direction),action=COALESCE(?,action),severity=COALESCE(?,severity),config_json=COALESCE(?,config_json),enabled=COALESCE(?,enabled),priority=COALESCE(?,priority),updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? RETURNING *`), deleteRule:p(`DELETE FROM policy_rules WHERE tenant_id=? AND id=? AND updated_at=?`),
    listDetectors:p(`SELECT * FROM detector_definitions WHERE tenant_id=? OR tenant_id IS NULL ORDER BY builtin DESC,key`), getDetector:p(`SELECT * FROM detector_definitions WHERE tenant_id=? AND id=?`),
    insertDetector:p(`INSERT INTO detector_definitions(tenant_id,id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?) RETURNING *`),
    updateDetector:p(`UPDATE detector_definitions SET config_json=COALESCE(?,config_json),config_sha256=COALESCE(?,config_sha256),enabled=COALESCE(?,enabled),updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND builtin=0 RETURNING *`), deleteDetector:p(`UPDATE detector_definitions SET enabled=0,updated_at=? WHERE tenant_id=? AND id=? AND updated_at=? AND builtin=0`),
    customTermsDetector:p(`SELECT * FROM detector_definitions WHERE tenant_id=? AND key='custom-terms' AND builtin=0`),
    customTermsPolicy:p(`SELECT id FROM policies WHERE tenant_id=? AND enabled=1 AND deleted_at IS NULL ORDER BY CASE name WHEN 'Default enterprise protection' THEN 0 ELSE 1 END,priority,id LIMIT 1`),
    customTermsRules:p(`SELECT pr.* FROM policy_rules pr JOIN detector_definitions d ON d.id=pr.detector_id WHERE pr.tenant_id=? AND d.tenant_id=pr.tenant_id AND d.key='custom-terms' AND d.builtin=0 AND pr.direction='outbound' AND pr.scope_type='tenant' ORDER BY pr.priority,pr.id`),
    updateCustomTermsRule:p(`UPDATE policy_rules SET config_json=?,enabled=?,severity=?,updated_at=? WHERE tenant_id=? AND id=?`),
    complianceRules:p(`SELECT pr.detector_id detectorId,pr.action action,pr.scope_type scopeType,pr.scope_id scopeId,pr.direction direction
      FROM policy_rules pr
      JOIN policies p ON p.id=pr.policy_id AND p.tenant_id=pr.tenant_id AND p.enabled=1 AND p.deleted_at IS NULL
      JOIN detector_definitions d ON d.id=pr.detector_id AND d.enabled=1
      WHERE pr.tenant_id=? AND pr.enabled=1`),
    listLegalHolds:p(`SELECT h.*,COALESCE(placed.display_name,placed.email) placed_by,COALESCE(released.display_name,released.email) released_by,
      CASE h.scope_type WHEN 'user' THEN COALESCE(target.display_name,target.email) WHEN 'project' THEN project.name
        WHEN 'conversation' THEN COALESCE(owner.display_name,owner.email) ELSE NULL END scope_label,
      CASE WHEN h.scope_type='conversation' THEN conversation.created_at ELSE NULL END scope_created_at
      FROM audit_legal_holds h
      LEFT JOIN users placed ON placed.tenant_id=h.tenant_id AND placed.id=h.created_by_user_id
      LEFT JOIN users released ON released.tenant_id=h.tenant_id AND released.id=h.released_by_user_id
      LEFT JOIN users target ON h.scope_type='user' AND target.tenant_id=h.tenant_id AND target.id=h.scope_id
      LEFT JOIN projects project ON h.scope_type='project' AND project.tenant_id=h.tenant_id AND project.id=h.scope_id
      LEFT JOIN conversations conversation ON h.scope_type='conversation' AND conversation.tenant_id=h.tenant_id AND conversation.id=h.scope_id
      LEFT JOIN users owner ON owner.tenant_id=h.tenant_id AND owner.id=conversation.owner_user_id
      WHERE h.tenant_id=? AND (?='all' OR (?='active' AND h.released_at_ms IS NULL) OR (?='released' AND h.released_at_ms IS NOT NULL))
        AND (? IS NULL OR h.created_at_ms<? OR (h.created_at_ms=? AND h.id<?))
      ORDER BY h.created_at_ms DESC,h.id DESC LIMIT ?`),
    listLegalHoldUsers:p(`SELECT id,email,display_name,status FROM users
      WHERE tenant_id=? AND (display_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR email LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY COALESCE(display_name,email),id LIMIT 50`),
    legalHoldTargetUser:p(`SELECT id FROM users WHERE tenant_id=? AND id=?`),
    legalHoldTargetProject:p(`SELECT id FROM projects WHERE tenant_id=? AND id=?`),
    legalHoldTargetConversation:p(`SELECT id FROM conversations WHERE tenant_id=? AND id=?`),
    insertLegalHold:p(`INSERT INTO audit_legal_holds(tenant_id,id,scope_type,scope_id,starts_at_ms,ends_at_ms,reason,created_by_user_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?) RETURNING *`),
    getLegalHold:p(`SELECT * FROM audit_legal_holds WHERE tenant_id=? AND id=?`),
    releaseLegalHold:p(`UPDATE audit_legal_holds SET released_by_user_id=?,released_at_ms=?,release_reason=? WHERE tenant_id=? AND id=? AND released_at_ms IS NULL RETURNING *`),
  };
}

export interface AdminAdapterDependencies { readonly database:Database.Database; readonly statements:AdminStatements; readonly audit:AuditService; readonly now?:()=>number;
  readonly idempotencyHmacKey:Uint8Array; readonly invitationResponseEncryptionKey:Uint8Array;
  readonly uploadDir?:string; readonly appOrigin:string; readonly mailer?:Mailer; readonly logger?:MailLogger;
  /** The read-only console: capabilities, dashboard, analytics and the four bounded list screens. */
  readonly console:ConsoleStatements; readonly analytics:AnalyticsStatements; readonly nudges:NudgeStatements; readonly directory:DirectoryReader }

const b=(request:RouteRequest):Body => typeof request.body==='object'&&request.body!==null ? request.body as Body : {};
const s=(value:unknown,name:string,max=1000):string => { if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new AdminError(422,`${name} is required`);return value.trim(); };
const optionalString=(value:unknown,max=1000):string|null|undefined => value===undefined?undefined:value===null?null:s(value,'value',max);
const integer=(value:unknown,name:string,min=0):number => {if(!Number.isSafeInteger(value)||Number(value)<min)throw new AdminError(422,`${name} must be an integer of at least ${min}`);return Number(value)};
const boundedInteger=(value:unknown,name:string,min:number,max:number):number => {if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new AdminError(422,`${name} must be an integer between ${min} and ${max}`);return Number(value)};
const choice=<T extends string>(value:string,name:string,allowed:readonly T[]):T => {if(!(allowed as readonly string[]).includes(value))throw new AdminError(422,`${name} must be one of ${allowed.join(', ')}`);return value as T};
const boolInt=(value:unknown):0|1|undefined => value===undefined?undefined:value===true?1:value===false?0:undefined;
const optionalText=(value:unknown,name:string,max:number):string|null|undefined=>{if(value===undefined)return undefined;if(value===null||value==='')return null;if(typeof value!=='string'||value.trim().length>max)throw new AdminError(422,`${name} must be at most ${max} characters`);return value.trim()};
const supportEmail=(value:unknown):string|null|undefined=>{const parsed=optionalText(value,'supportContactEmail',320);if(parsed&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parsed))throw new AdminError(422,'supportContactEmail must be a valid email address',undefined,'support_email_invalid');return parsed};
const supportUrl=(value:unknown):string|null|undefined=>{const parsed=optionalText(value,'supportContactUrl',2048);if(!parsed)return parsed;let url:URL;try{url=new URL(parsed)}catch{throw new AdminError(422,'supportContactUrl must be a valid HTTPS URL',undefined,'support_url_invalid')}if(url.protocol!=='https:')throw new AdminError(422,'supportContactUrl must use HTTPS',undefined,'support_url_https_required');return url.toString()};
// Without these the value reaches the locale CHECK constraint unvalidated, so a typo — or any
// locale we do not sell into — surfaces as a 500 instead of a 422.
const locale=(value:unknown,name:string):Locale => {const parsed=s(value,name,10);if(!(LOCALES as readonly string[]).includes(parsed))throw new AdminError(422,`${name} must be one of ${LOCALES.join(', ')}`);return parsed as Locale};
const optionalLocale=(value:unknown,name:string):Locale|null|undefined => value===undefined?undefined:value===null?null:locale(value,name);
const optionalQuery=(value:string|undefined,name:string,max:number):string|null => {
  if(value===undefined||value.trim()==='')return null;
  const parsed=value.trim().normalize('NFC');
  if(parsed.length>max)throw new AdminError(422,`${name} must be at most ${max} characters`);
  return parsed;
};
const queryChoice=<T extends string>(value:string|undefined,name:string,choices:readonly T[]):T|null => {
  const parsed=optionalQuery(value,name,40);
  if(parsed===null)return null;
  if(!(choices as readonly string[]).includes(parsed))throw new AdminError(422,`${name} must be one of ${choices.join(', ')}`);
  return parsed as T;
};
const likeLiteral=(value:string|null):string|null => value===null?null:`%${value.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`;
const emailAddress=(value:unknown):{email:string;domain:string} => {
  const normalized=normalizeEmail(s(value,'email',254));
  const separator=normalized.lastIndexOf('@');
  if(separator<1||separator===normalized.length-1||normalized.includes(' ')||normalized.indexOf('@')!==separator)throw new AdminError(422,'email must be a valid email address');
  const domain=domainToASCII(normalized.slice(separator+1).replace(/\.$/u,''));
  if(!domain||domain.length>253||domain.includes('..')||!domain.includes('.'))throw new AdminError(422,'email must be a valid email address');
  return {email:`${normalized.slice(0,separator)}@${domain}`,domain};
};
const json=(value:unknown):string => JSON.stringify(value??{});
const roles=(request:RouteRequest):readonly TenantRole[] => request.tenant?.principal.roles??[];
const db=(request:RouteRequest):TenantDb => {if(!request.tenant)throw new AdminError(401,'Authentication required');return request.tenant.db};
const one=(row:Row|undefined):Row => {if(!row)throw new AdminError(404,'Resource was not found');return row};
class AdminError extends Error { constructor(readonly status:number,message:string,readonly code?:string,readonly reason?:ErrorReason){super(message)} }
function expectedVersion(request:RouteRequest):number {
  const header=request.headers.get('If-Match');
  if(header===null)throw new AdminError(428,'If-Match is required','PRECONDITION_REQUIRED');
  const value=header.trim().replace(/^W\//,'').replaceAll('"','');
  const parsed=/^\d+$/.test(value)?Number(value):NaN;
  if(!Number.isSafeInteger(parsed)||parsed<0)throw new AdminError(412,'The policy rule changed since it was read','PRECONDITION_FAILED');
  return parsed;
}
function changedSinceRead():never {throw new AdminError(412,'The resource changed since it was read','PRECONDITION_FAILED','resource_changed')}

type HoldScope='tenant'|'user'|'conversation'|'project'|'date_range';
function holdReason(value:unknown,field='reason'):string {
  if(typeof value!=='string')throw new AdminError(422,`${field} is required`,undefined,'hold_reason_invalid');
  const trimmed=value.trim();
  if(trimmed.length<1||trimmed.length>1000)throw new AdminError(422,`${field} must be between 1 and 1000 characters`,undefined,'hold_reason_invalid');
  return trimmed;
}
function holdDate(value:unknown,field:string):number|null {
  if(value===undefined)return null;
  if(typeof value!=='string'||!value.trim())throw new AdminError(422,`${field} must be an ISO date and time`);
  const instant=value.trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(instant))throw new AdminError(422,`${field} must be an ISO date and time with an offset`);
  const parsed=Date.parse(instant);
  if(!Number.isFinite(parsed))throw new AdminError(422,`${field} must be an ISO date and time`);
  return parsed;
}
function holdWire(row:Row):Row{return{
  id:row.id,scopeType:row.scope_type,scopeId:row.scope_id,scopeLabel:row.scope_label??null,
  scopeCreatedAt:row.scope_created_at===null||row.scope_created_at===undefined?null:new Date(Number(row.scope_created_at)).toISOString(),
  startsAt:row.starts_at_ms===null?null:new Date(Number(row.starts_at_ms)).toISOString(),endsAt:row.ends_at_ms===null?null:new Date(Number(row.ends_at_ms)).toISOString(),
  reason:row.reason,placedBy:row.placed_by??null,placedAt:new Date(Number(row.created_at_ms)).toISOString(),releasedBy:row.released_by??null,
  releasedAt:row.released_at_ms===null?null:new Date(Number(row.released_at_ms)).toISOString(),releaseReason:row.release_reason??null,
  status:row.released_at_ms===null?'active':'released',
}}
function listLegalHolds(request:RouteRequest,deps:AdminAdapterDependencies,permit:Permit):RouteResult {
  permit(request,'audit.read_metadata');const tenant=db(request),status=request.query.status??'active';
  if(!['active','released','all'].includes(status))throw new AdminError(422,'status must be active, released, or all');
  const limitText=request.query.limit,limit=limitText===undefined?50:Number(limitText);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new AdminError(422,'limit must be between 1 and 100');
  let cursorAt:number|null=null,cursorId:string|null=null;
  if(request.query.cursor){try{const decoded=Buffer.from(request.query.cursor,'base64url').toString('utf8'),split=decoded.indexOf(':');cursorAt=Number(decoded.slice(0,split));cursorId=decoded.slice(split+1);if(split<1||!Number.isSafeInteger(cursorAt)||!cursorId)throw new Error()}catch{throw new AdminError(422,'cursor is invalid')}}
  const rows=tenant.all(deps.statements.listLegalHolds,status,status,status,cursorAt,cursorAt,cursorAt,cursorId,limit+1),hasMore=rows.length>limit,items=rows.slice(0,limit).map(holdWire),last=rows[limit-1];
  const nextCursor=hasMore&&last?Buffer.from(`${last.created_at_ms}:${last.id}`).toString('base64url'):null;
  return{body:{items,nextCursor}};
}
function listLegalHoldUsers(request:RouteRequest,deps:AdminAdapterDependencies,permit:Permit):RouteResult {
  permit(request,'retention.read');
  const search=String(request.query.search??'').trim();
  if(!search)return {body:{items:[],nextCursor:null}};
  const escaped=`%${search.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`;
  const rows=db(request).all(deps.statements.listLegalHoldUsers,escaped,escaped);
  return {body:{items:rows.map(row=>({id:row.id,email:row.email,displayName:row.display_name,status:row.status})),nextCursor:null}};
}
function placeLegalHold(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'retention.legal_hold.update');const tenant=db(request),input=b(request),scopeType=input.scopeType;
  if(typeof scopeType!=='string'||!['tenant','user','conversation','project','date_range'].includes(scopeType))throw new AdminError(422,'scopeType must name a supported legal hold scope');
  const scope=scopeType as HoldScope,needsId=scope==='user'||scope==='conversation'||scope==='project';
  if(needsId&&(typeof input.scopeId!=='string'||!input.scopeId.trim()))throw new AdminError(422,'scopeId is required');
  if(!needsId&&Object.hasOwn(input,'scopeId'))throw new AdminError(422,'scopeId must be absent');
  const scopeId=needsId?String(input.scopeId):null,startsAt=holdDate(input.startsAt,'startsAt'),endsAt=holdDate(input.endsAt,'endsAt');
  if(scope==='date_range'&&startsAt===null&&endsAt===null)throw new AdminError(422,'startsAt or endsAt is required',undefined,'hold_dates_required');
  if(startsAt!==null&&endsAt!==null&&startsAt>=endsAt)throw new AdminError(422,'startsAt must be before endsAt',undefined,'date_order_invalid');
  if(scopeId){const target=scope==='user'?deps.statements.legalHoldTargetUser:scope==='project'?deps.statements.legalHoldTargetProject:deps.statements.legalHoldTargetConversation;if(!tenant.get(target,scopeId))throw new AdminError(422,'scopeId is invalid',undefined,'hold_target_invalid')}
  const reason=holdReason(input.reason),id=randomUUID(),row=one(tenant.get(deps.statements.insertLegalHold,id,scope,scopeId,startsAt,endsAt,reason,request.tenant!.principal.userId,at));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.legal_hold_placed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'tenant',id:tenant.tenantId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{holdId:id,scopeType:scope,scopeId,reasonLength:reason.length}});
  return{status:201,body:{item:holdWire({...row,scope_label:null,placed_by:null,released_by:null}),auditEventId:receipt.id}};
}
function releaseLegalHold(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'retention.legal_hold.update');const tenant=db(request),reason=holdReason(b(request).reason),id=request.params.id!,current=tenant.get(deps.statements.getLegalHold,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  if(current.released_at_ms!==null)throw new AdminError(409,'The legal hold has already been released','CONFLICT','legal_hold_already_released');
  const row=one(tenant.get(deps.statements.releaseLegalHold,request.tenant!.principal.userId,at,reason,id));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.legal_hold_released',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'tenant',id:tenant.tenantId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{holdId:id,scopeType:String(current.scope_type),scopeId:current.scope_id as string|null,reasonLength:reason.length}});
  return{body:{item:holdWire({...row,scope_label:null,placed_by:null,released_by:null}),auditEventId:receipt.id}};
}

function setProviderGroupAccess(request:RouteRequest,input:Body,at:number,statements:AdminStatements,tx:AuditTransaction,
  permit:(request:RouteRequest,permission:GovernancePermission)=>void):RouteResult {
  permit(request,'provider.group_allowlist.update');
  const expected=expectedVersion(request),enabled=boolInt(input.enabled)??1,tenant=db(request);
  const groupId=request.params.groupId!,providerId=request.params.providerId!;
  const current=tenant.get(statements.getProviderAccess,groupId,providerId);
  if(!current)throw new AdminError(404,'Resource was not found');
  const row=expected===0
    ? tenant.get(statements.insertProviderAccess,enabled,groupId,providerId,expected)
    : tenant.get(statements.updateProviderAccess,enabled,groupId,providerId,expected);
  if(!row)changedSinceRead();
  const version=Number(row.version),storedEnabled=Number(row.enabled)===1;
  const receipt=tx.append({tenantId:request.tenant!.principal.tenantId,action:'admin.provider_allowlist_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'provider',id:providerId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},
    metadata:{groupId,enabled:storedEnabled,fromVersion:expected,toVersion:version}});
  return {body:{item:{groupId,providerId,enabled:storedEnabled,version},auditEventId:receipt.id}};
}

export function createAdminAdapter(deps:AdminAdapterDependencies):{execute(operation:string,request:RouteRequest):Promise<RouteResult>} {
  const now=deps.now??Date.now,brandBlobs=createDiskBlobStore(deps.uploadDir??'/tmp/gateway-test-uploads');
  const permit=(request:RouteRequest,p:GovernancePermission) => {try{assertGovernancePermission(roles(request),p)}catch{throw new AdminError(403,`Missing permission: ${p}`,undefined,'missing_permission')}};
  const invitationIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,responseEncryptionKey:deps.invitationResponseEncryptionKey,namespace:'admin-user-invitation',now,cacheResult:replayWithoutCredential});
  const credentialLinkIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,responseEncryptionKey:deps.invitationResponseEncryptionKey,namespace:'admin-user-credential-link',now,cacheResult:replayWithoutCredential});
  const providerAccessIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-provider-group-access',method:'PUT',now});
  const forceLogoutIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-user-force-logout',now});
  const settingsUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-settings-update',method:'PATCH',now});
  const groupCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-create',now});
  const groupUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-update',method:'PATCH',now});
  const groupDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-delete',method:'DELETE',now});
  const groupMemberAddIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-membership',method:'PUT',now});
  const groupMemberRemoveIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-membership',method:'DELETE',now});
  const groupModelEnableIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-model-access',method:'PUT',now});
  const groupModelDisableIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-group-model-access',method:'DELETE',now});
  const modelCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-model-create',now});
  const modelUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-model-update',method:'PATCH',now});
  const budgetCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-budget-create',now});
  const budgetUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-budget-update',method:'PATCH',now});
  const budgetDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-budget-delete',method:'DELETE',now});
  const ruleCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-rule-create',now});
  const ruleUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-rule-update',method:'PATCH',now});
  const ruleDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-rule-delete',method:'DELETE',now});
  const ruleTestIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,responseEncryptionKey:deps.invitationResponseEncryptionKey,namespace:'admin-rule-test',now});
  const detectorCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-detector-create',now});
  const detectorUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-detector-update',method:'PATCH',now});
  const detectorDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-detector-delete',method:'DELETE',now});
  const customTermsUpsertIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-custom-terms',now});
  const customTermsDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-custom-terms',method:'DELETE',now});
  const assistantCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-assistant-create',now});
  const assistantUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-assistant-update',method:'PATCH',now});
  const assistantDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-assistant-delete',method:'DELETE',now});
  const legalHoldCreateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-legal-hold-create',now});
  const legalHoldReleaseIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-legal-hold-release',now});
  // Retrying a user mutation must replay its first outcome, and reusing its key against another
  // user must be refused. That guarantee used to ride on the seat-reconciliation ledger; with seats
  // gone it lives on the durable mutation record instead. Without a key the mutation runs inline,
  // exactly as it did when the fallback key was the request id.
  // Two instances because uniqueness includes method: this namespace serves PATCH (update) and
  // DELETE, and a single default-POST owner would store the wrong method on every row.
  const userUpdateIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-user-mutation',method:'PATCH',now});
  const userDeleteIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,namespace:'admin-user-mutation',method:'DELETE',now});
  return {async execute(operation,request){
    try {
      if(operation==='gate.test')return await ruleTestIdempotency.executeSideEffectFree(operation,request,()=>testRule(request,b(request),permit));
      // Reporting reads nothing it can change, so it stays outside the audit transaction the write
      // operations below share. Reading the console is not itself an audited event; opening a
      // transcript is, and that lives in the audit adapter.
      if(CONSOLE_OPERATIONS.has(operation))return consoleOperation(operation,request,deps,permit,now());
      if(operation==='admin.legalHolds.list')return listLegalHolds(request,deps,permit);
      if(operation==='admin.legalHolds.users')return listLegalHoldUsers(request,deps,permit);
      if(operation==='admin.legalHolds.create')return legalHoldCreateIdempotency.execute(operation,request,(tx,at)=>placeLegalHold(request,deps,tx,at,permit));
      if(operation==='admin.legalHolds.release')return legalHoldReleaseIdempotency.execute(operation,request,(tx,at)=>releaseLegalHold(request,deps,tx,at,permit));
      if(operation==='admin.settings.update')return settingsUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateSettings(request,deps,tx,at,permit));
      if(operation==='admin.users.create'){
        const result=invitationIdempotency.execute(operation,request,(tx,at)=>createUser(request,deps,tx,at,permit));
        return finishCredentialDelivery(result,request,deps);
      }
      if(operation==='admin.users.credentialLink'){
        const result=credentialLinkIdempotency.execute(operation,request,(tx,at)=>issueAdminCredentialLink(request,deps,tx,at,permit));
        return finishCredentialDelivery(result,request,deps);
      }
      if((operation==='admin.users.update'||operation==='admin.users.delete')&&request.headers.get('Idempotency-Key')!==null)
        return (operation==='admin.users.update'?userUpdateIdempotency:userDeleteIdempotency).execute(operation,request,(tx,at)=>userMutation(operation,request,deps,tx,at,permit));
      if(operation==='admin.users.forceLogout')return forceLogoutIdempotency.execute(operation,request,
        (tx,at)=>forceLogoutUser(request,deps,tx,at,permit));
      if(operation==='admin.groups.create')return groupCreateIdempotency.execute(operation,request,
        (tx,at)=>createGroup(request,deps,tx,at,permit));
      if(operation==='admin.groups.update')return groupUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateGroup(request,deps,tx,at,permit));
      if(operation==='admin.groups.delete')return groupDeleteIdempotency.execute(operation,request,
        (tx,at)=>deleteGroup(request,deps,tx,at,permit));
      if(operation==='admin.groups.addMember')return groupMemberAddIdempotency.execute(operation,request,
        (tx,at)=>changeGroupMembership(operation,request,deps,tx,at,permit));
      if(operation==='admin.groups.removeMember')return groupMemberRemoveIdempotency.execute(operation,request,
        (tx,at)=>changeGroupMembership(operation,request,deps,tx,at,permit));
      if(operation==='admin.models.enableForGroup')return groupModelEnableIdempotency.execute(operation,request,
        (tx,at)=>changeGroupModelAccess(operation,request,deps,tx,at,permit));
      if(operation==='admin.models.disableForGroup')return groupModelDisableIdempotency.execute(operation,request,
        (tx,at)=>changeGroupModelAccess(operation,request,deps,tx,at,permit));
      if(operation==='admin.models.create')return modelCreateIdempotency.execute(operation,request,
        (tx,at)=>createModel(request,deps,tx,at,permit));
      if(operation==='admin.models.update')return modelUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateModel(request,deps,tx,at,permit));
      if(operation==='budgets.create')return budgetCreateIdempotency.execute(operation,request,
        (tx,at)=>createBudget(request,deps,tx,at,permit));
      if(operation==='budgets.update')return budgetUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateBudget(request,deps,tx,at,permit));
      if(operation==='budgets.delete')return budgetDeleteIdempotency.execute(operation,request,
        (tx,at)=>deleteBudget(request,deps,tx,at,permit));
      if(operation==='gate.rules.create')return ruleCreateIdempotency.execute(operation,request,
        (tx,at)=>createRule(request,deps,tx,at,permit));
      if(operation==='gate.rules.update')return ruleUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateRule(request,deps,tx,at,permit));
      if(operation==='gate.rules.delete')return ruleDeleteIdempotency.execute(operation,request,
        (tx,at)=>deleteRule(request,deps,tx,at,permit));
      if(operation==='admin.detectors.create')return detectorCreateIdempotency.execute(operation,request,
        (tx,at)=>mutateDetectorCreate(request,deps,tx,at,permit));
      if(operation==='admin.detectors.update')return detectorUpdateIdempotency.execute(operation,request,
        (tx,at)=>mutateDetectorUpdate(request,deps,tx,at,permit));
      if(operation==='admin.detectors.delete')return detectorDeleteIdempotency.execute(operation,request,
        (tx,at)=>mutateDetectorDelete(request,deps,tx,at,permit));
      if(operation==='admin.customTerms.upsert')return customTermsUpsertIdempotency.execute(operation,request,
        (tx,at)=>mutateCustomTerms(operation,request,deps,tx,at,permit));
      if(operation==='admin.customTerms.delete')return customTermsDeleteIdempotency.execute(operation,request,
        (tx,at)=>mutateCustomTerms(operation,request,deps,tx,at,permit));
      if(operation==='admin.assistants.create')return assistantCreateIdempotency.execute(operation,request,
        (tx,at)=>createAssistant(request,deps,tx,at,permit));
      if(operation==='admin.assistants.update')return assistantUpdateIdempotency.execute(operation,request,
        (tx,at)=>updateAssistant(request,deps,tx,at,permit));
      if(operation==='admin.assistants.delete')return assistantDeleteIdempotency.execute(operation,request,
        (tx,at)=>deleteAssistant(request,deps,tx,at,permit));
      if(operation==='admin.providers.setGroupAccess')return providerAccessIdempotency.execute(operation,request,
        (tx,at)=>setProviderGroupAccess(request,b(request),at,deps.statements,tx,permit));
      if(operation==='admin.settings.icon'){
        permit(request,'tenant.update');const input=b(request),candidate=input.file??Object.values(input)[0];
        if(!candidate||typeof candidate!=='object'||typeof (candidate as {arrayBuffer?:unknown}).arrayBuffer!=='function')throw new AdminError(422,'An icon file is required',undefined,'icon_required');
        const bytes=new Uint8Array(await (candidate as {arrayBuffer():Promise<ArrayBuffer>}).arrayBuffer());
        if(bytes.byteLength>512*1024)throw new AdminError(413,'The brand icon must be 512 KB or smaller',undefined,'icon_too_large');
        const prefix=Buffer.from(bytes.subarray(0,4096)).toString('utf8').trimStart();
        if(/^<\?xml\b/iu.test(prefix)||/<svg(?:\s|>)/iu.test(prefix))throw new AdminError(422,'SVG icons are refused because SVG documents can contain scripts and external references',undefined,'icon_svg_refused');
        const mime=sniffMime(bytes);if(mime!=='image/png'&&mime!=='image/jpeg'&&mime!=='image/webp')throw new AdminError(422,'The brand icon must contain PNG, JPEG, or WebP image data',undefined,'icon_type_refused');
        const dimensions=imageDimensions(bytes,mime);if(!dimensions||!imagePixelsAllowed(dimensions,4_000_000))throw new AdminError(422,'The brand icon has invalid or excessive pixel dimensions',undefined,'icon_dimensions_invalid');
        const tenantId=request.tenant!.principal.tenantId,sha256=createHash('sha256').update(bytes).digest('hex'),fileId=randomUUID(),storageKey=`${tenantId}/branding/${sha256}`;
        await brandBlobs.put(storageKey,bytes);
        deps.audit.transact(tx=>{deps.database.prepare('UPDATE tenant_settings SET brand_icon_file_id=?,brand_icon_mime=?,brand_icon_sha256=?,updated_at=?,updated_by_user_id=? WHERE tenant_id=?').run(fileId,mime,sha256,now(),request.tenant!.principal.userId,tenantId);tx.append({tenantId,action:'admin.tenant_setting_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'tenant',id:tenantId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http'},metadata:{fields:['brand_icon_file_id','brand_icon_mime','brand_icon_sha256']}})});
        return{status:201,body:{fileId,mimeType:mime,sha256,width:dimensions.width,height:dimensions.height,url:'/api/v1/deployment/icon'}};
      }
      return deps.audit.transact(tx=>{
      const audit=(request:RouteRequest,action:Parameters<AuditService['append']>[0]['action'],target:TargetType,id:string|null,metadata:JsonObject={}) => tx.append({tenantId:request.tenant!.principal.tenantId,action,actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:target,id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:now()},metadata});
      const tenant=db(request),input=b(request),at=now();
      if(operation==='admin.settings.get'){permit(request,'tenant.read');return {body:{...one(tenant.get(deps.statements.getSettings)),accepted_upload_mime_types:Object.values(MIME)}}}
      if(operation==='admin.users.list'){
        permit(request,'member.read');
        const search=likeLiteral(optionalQuery(request.query.search,'search',200));
        const status=queryChoice(request.query.status,'status',['invited','active','suspended'] as const);
        const roleKey=optionalQuery(request.query.role,'role',64),groupValue=optionalQuery(request.query.group,'group',200);
        const mfa=queryChoice(request.query.mfa,'mfa',['enabled','disabled'] as const);
        const rows=tenant.all(deps.statements.listUsers,search,status,roleKey,groupValue,mfa);
        return {body:{items:rows.map(row=>user(request,tenant,row,deps.statements)),nextCursor:null}};
      }
      if(operation==='admin.users.get'){permit(request,'member.read');return {body:user(request,tenant,one(tenant.get(deps.statements.getUser,request.params.id!)),deps.statements)}}
      if(operation==='admin.users.update'||operation==='admin.users.delete')return userMutation(operation,request,deps,tx,at,permit);
      if(operation==='gate.policies.list'){permit(request,'policy.read');return {body:{items:tenant.all(deps.statements.listPolicies),nextCursor:null}}}
      if(operation==='admin.compliance.summary'){permit(request,'policy.read');return complianceSummary(request,tenant,deps.statements)}
      if(operation.startsWith('admin.customTerms.'))return customTermsOperation(operation,request,tenant,input,at,deps.statements,permit,audit);
      if(operation==='admin.groups.list'){permit(request,'group.read');return {body:{items:tenant.all(deps.statements.listGroups).map(groupWire),nextCursor:null}}}
      if(operation==='admin.groups.get'){permit(request,'group.read');return {body:groupWire(one(tenant.get(deps.statements.getGroup,request.params.id!)))}}
      if(operation==='admin.models.list'){permit(request,'model.read');return {body:{items:tenant.all(deps.statements.listModels).map(modelWire),nextCursor:null}}}
      if(operation==='admin.assistants.list'){permit(request,'assistant.read');return {body:{items:tenant.all(deps.statements.listAssistants).map(assistantWire),nextCursor:null}}}
      if(operation==='admin.assistants.get'){permit(request,'assistant.read');return {body:assistantWire(one(tenant.get(deps.statements.getAssistant,request.params.id!)))}}
      if(operation==='admin.assistants.create')return createAssistant(request,deps,tx,at,permit);
      if(operation==='admin.assistants.update')return updateAssistant(request,deps,tx,at,permit);
      if(operation==='admin.assistants.delete')return deleteAssistant(request,deps,tx,at,permit);
      if(operation==='admin.providers.list'){permit(request,'model.read');return {body:{items:providerWire(tenant.all(deps.statements.listProviders)),nextCursor:null}}}
      if(operation.startsWith('budgets.'))return budgetOperation(operation,request,tenant,input,at,deps.statements,permit,audit);
      if(operation.startsWith('gate.rules.'))return ruleOperation(operation,request,tenant,input,at,deps.statements,permit,audit);
      if(operation.startsWith('admin.detectors.'))return detectorOperation(operation,request,tenant,input,at,deps.statements,permit,audit);
      throw new AdminError(501,`NotImplemented: admin operation ${operation} has no adapter`);
      });
    } catch(error){
      if(error instanceof MutationIdempotencyError)return {status:error.status,body:{error:{code:error.code,message:error.message,requestId:request.requestId,retryable:false}}};
      if(error instanceof GovernanceError&&error.code==='idempotency_conflict')return {status:409,body:{error:{code:'IDEMPOTENCY_CONFLICT',message:error.message,requestId:request.requestId,retryable:false}}};
      if(error instanceof TimeZoneValidationError)return {status:422,body:{error:{code:'VALIDATION_FAILED',message:error.message,requestId:request.requestId,retryable:false}}};
      if(error instanceof AdminError)return {status:error.status,body:{error:{code:error.code??(error.status===403?'FORBIDDEN':error.status===404?'RESOURCE_NOT_FOUND':error.status===409?'CONFLICT':error.status>=500?'SERVICE_UNAVAILABLE':'VALIDATION_FAILED'),message:error.message,requestId:request.requestId,retryable:error.status===503,...(error.reason?{details:{reason:error.reason}}:{})}}};
      throw error;
    }
  }};
}

function updateSettings(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'tenant.update');const tenant=db(request),input=b(request),actor=request.tenant!.principal.userId;
  if(Object.hasOwn(input,'auditRetentionDays')||Object.hasOwn(input,'rehydrateRedactions'))throw new AdminError(422,'This setting is reserved and is not supported by the online application');
  const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1);
  const retentionDays=input.retentionDays===undefined?null:boundedInteger(input.retentionDays,'retentionDays',1,3650),requestsPerMinute=input.requestsPerMinute===undefined?null:boundedInteger(input.requestsPerMinute,'requestsPerMinute',1,10000),concurrentStreams=input.concurrentStreams===undefined?null:boundedInteger(input.concurrentStreams,'concurrentStreams',1,100);
  const timeZone=input.timezone===undefined?null:canonicalTimeZone(input.timezone);
  const updated=tenant.get(deps.statements.updateSettings,optionalLocale(input.defaultLocale,'defaultLocale')??null,timeZone,retentionDays,boolInt(input.transcriptCapture)??null,requestsPerMinute,concurrentStreams,updatedAt,actor,expected);
  if(!updated){if(tenant.get(deps.statements.getSettings))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const values:{column:string;value:string|null|undefined}[]=[
    {column:'brand_name',value:optionalText(input.brandName,'brandName',200)},
    {column:'support_vendor_name',value:optionalText(input.supportVendorName,'supportVendorName',200)},
    {column:'support_contact_email',value:supportEmail(input.supportContactEmail)},
    {column:'support_contact_phone',value:optionalText(input.supportContactPhone,'supportContactPhone',100)},
    {column:'support_contact_url',value:supportUrl(input.supportContactUrl)},
    {column:'support_notes',value:optionalText(input.supportNotes,'supportNotes',2000)},
  ];
  for(const item of values)if(item.value!==undefined)deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE tenant_settings SET ${item.column}=? WHERE tenant_id=(SELECT id FROM tenant_scope)`).run(tenant.tenantId,item.value);
  const row=one(tenant.get(deps.statements.getSettings));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.tenant_setting_changed',
    actor:{type:'user',id:actor,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'tenant',id:tenant.tenantId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{fields:Object.keys(input)}});
  return {body:{item:row,auditEventId:receipt.id}};
}

function userMutation(operation:'admin.users.update'|'admin.users.delete',request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  const tenant=db(request),input=b(request),actor=request.tenant!.principal.userId;
  const audit=(action:Parameters<AuditService['append']>[0]['action'],id:string,metadata:JsonObject={}) => tx.append({tenantId:tenant.tenantId,action,actor:{type:'user',id:actor,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'user',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  if(operation==='admin.users.update'){
    const target=request.params.id!,previous=one(tenant.get(deps.statements.getUser,target));
    const fields=(['displayName','status','locale','role'] as const).filter(field=>Object.hasOwn(input,field));
    if(fields.length===0)throw new AdminError(422,'At least one user field is required');
    const changesStatus=Object.hasOwn(input,'status'),changesRole=Object.hasOwn(input,'role');
    const status=changesStatus?choice(String(input.status),'status',['active','suspended'] as const):undefined;
    if(changesStatus&&!['active','suspended'].includes(String(previous.status)))throw new AdminError(422,'status can be changed only for an active or suspended user',undefined,'resource_changed');
    if(target===actor&&changesStatus)throw new AdminError(403,'You cannot disable your own account',undefined,'self_status_change');
    if(target===actor&&changesRole)throw new AdminError(403,'You cannot change your own role',undefined,'self_role_change');
    const targetRoles=tenantRoles(tenant.all(deps.statements.listUserRoles,target).map(row=>String(row.key)));
    if(changesStatus){permit(request,'member.suspend');requireAccountAccess(request,targetRoles)}
    if(changesRole)requireAccountAccess(request,targetRoles);
    if(Object.hasOwn(input,'displayName')||Object.hasOwn(input,'locale'))permit(request,'member.update_profile');
    const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1);
    const row=tenant.get(deps.statements.updateUser,optionalString(input.displayName,200)??null,status??null,optionalLocale(input.locale,'locale')??null,updatedAt,target,expected);
    if(!row){if(tenant.get(deps.statements.getUser,target))changedSinceRead();throw new AdminError(404,'Resource was not found')}
    if(input.role!==undefined)assignRole(request,tenant,deps.statements,target,s(input.role,'role',30) as TenantRole,at,permit);
    const receipt=audit(input.role!==undefined?'admin.role_changed':'admin.user_updated',target,{fields});
    if(input.status==='active'&&previous.status!=='active')audit('admin.user_enabled',target);
    else if(input.status!==undefined&&input.status!=='active'&&previous.status==='active')audit('admin.user_disabled',target);
    return {body:{item:user(request,tenant,row,deps.statements),auditEventId:receipt.id}};
  }
  if(operation==='admin.users.delete'){
    const target=request.params.id!,current=one(tenant.get(deps.statements.getUser,target));
    if(target===actor)throw new AdminError(403,'You cannot deprovision your own account',undefined,'self_removal');
    permit(request,'member.deprovision');requireAccountAccess(request,tenantRoles(tenant.all(deps.statements.listUserRoles,current.id).map(row=>String(row.key))));
    const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1),deleted=tenant.run(deps.statements.deleteUser,updatedAt,updatedAt,target,expected);
    if(deleted.changes===0){if(tenant.get(deps.statements.getUser,target))changedSinceRead();throw new AdminError(404,'Resource not found')}
    tenant.run(deps.statements.cancelUserCredentialLinks,updatedAt,target);
    audit('admin.user_deleted',target);return {status:204};
  }
  throw new AdminError(404,'Resource not found');
}


function createAssistant(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'assistant.create');const tenant=db(request),input=b(request),modelId=s(input.modelCatalogId??input.model_catalog_id,'modelCatalogId',36),model=tenant.get(deps.statements.getModel,modelId);
  if(!model||model.enabled!==1)throw new AdminError(422,'modelCatalogId must identify an enabled tenant model',undefined,'model_unavailable');
  const id=randomUUID();let row:Row;
  try{row=one(tenant.get(deps.statements.insertAssistant,id,s(input.name,'name',200),optionalString(input.description,2000)??null,s(input.systemPrompt??input.system_prompt,'systemPrompt',20000),modelId,at,at))}catch(error){if(error instanceof Error&&(error.message.includes('ux_assistants_tenant_name')||error.message.includes('assistants.tenant_id, assistants.name')))throw new AdminError(409,'An assistant with this name already exists',undefined,'assistant_name_taken');throw error}
  const full={...row,model:model.display_name};const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'model',id:modelId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'assistant_created',assistantId:id}});
  return {status:201,body:{item:assistantWire(full),auditEventId:receipt.id}};
}

function updateAssistant(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'assistant.update');const tenant=db(request),input=b(request),modelId=input.modelCatalogId??input.model_catalog_id;
  if(modelId!==undefined){const parsed=s(modelId,'modelCatalogId',36),model=tenant.get(deps.statements.getModel,parsed);if(!model||model.enabled!==1)throw new AdminError(422,'modelCatalogId must identify an enabled tenant model',undefined,'model_unavailable')}
  let row:Row|undefined;try{row=tenant.get(deps.statements.updateAssistant,optionalString(input.name,200)??null,input.description!==undefined?1:0,input.description===undefined?null:optionalString(input.description,2000),input.systemPrompt===undefined&&input.system_prompt===undefined?null:s(input.systemPrompt??input.system_prompt,'systemPrompt',20000),modelId===undefined?null:s(modelId,'modelCatalogId',36),at,request.params.id!,expectedVersion(request))}catch(error){if(error instanceof Error&&(error.message.includes('ux_assistants_tenant_name')||error.message.includes('assistants.tenant_id, assistants.name')))throw new AdminError(409,'An assistant with this name already exists',undefined,'assistant_name_taken');throw error}
  if(!row){if(tenant.get(deps.statements.getAssistant,request.params.id!))throw new AdminError(412,'The assistant changed since it was read','PRECONDITION_FAILED');throw new AdminError(404,'Resource was not found')}
  const full=one(tenant.get(deps.statements.getAssistant,request.params.id!));const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'model',id:String(full.model_catalog_id)},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'assistant_updated',assistantId:request.params.id!}});
  return {body:{item:assistantWire(full),auditEventId:receipt.id}};
}

function deleteAssistant(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'assistant.delete');const tenant=db(request),id=request.params.id!,current=one(tenant.get(deps.statements.getAssistant,id));changed(tenant.run(deps.statements.deleteAssistant,id));tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'model',id:String(current.model_catalog_id)},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'assistant_deleted',assistantId:id}});
  return {status:204};
}

function createGroup(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'group.create');const tenant=db(request),input=b(request),id=randomUUID();
  const row=one(tenant.get(deps.statements.insertGroup,id,s(input.name,'name',200),optionalString(input.description,2000)??null,at,at));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.group_created',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'group',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {status:201,body:{item:groupWire(row),auditEventId:receipt.id}};
}

function createModel(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'model.tenant_access.update');const tenant=db(request),input=b(request),id=randomUUID();
  const row=one(tenant.get(deps.statements.insertModel,id,s(input.provider,'provider',30),s(input.providerModelId??input.modelKey,'providerModelId',200),s(input.displayName,'displayName',200),boolInt(input.enabled)??1,0,integer(input.contextWindowTokens,'contextWindowTokens',1),integer(input.maxOutputTokens,'maxOutputTokens',1),integer(input.inputPriceMicroUsdPerMillion,'inputPrice',0),integer(input.outputPriceMicroUsdPerMillion,'outputPrice',0),json(input.capabilities??[]),input.preferenceWeight===undefined?0:integer(input.preferenceWeight,'preferenceWeight'),at,at));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'model',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {status:201,body:{item:modelWire(row),auditEventId:receipt.id}};
}

function createBudget(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'budget.update');const tenant=db(request),input=b(request),id=randomUUID(),scope=s(input.scope??input.scopeType,'scope',20),scopeId=scope==='tenant'?null:s(input.scopeId,'scopeId',100),soft=input.softLimit===null?null:input.softLimit===undefined?null:integer(input.softLimit,'softLimit'),hard=integer(input.hardLimit,'hardLimit',1);
  choice(scope,'scope',['tenant','group','user']);const period=choice(s(input.period,'period',20),'period',['daily','weekly','monthly']),metric=choice(s(input.metric,'metric',20),'metric',['tokens','usd']);
  if(soft!==null&&soft>hard)throw new AdminError(422,'softLimit cannot exceed hardLimit',undefined,'soft_limit_above_hard');
  const timeZone=input.timezone===undefined?String(one(tenant.get(deps.statements.getSettings)).timezone):canonicalTimeZone(input.timezone);
  const row=one(tenant.get(deps.statements.insertBudget,id,scope,scopeId,period,metric,soft,hard,timeZone,boolInt(input.enabled)??1,at,at));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.tenant_setting_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'budget',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'budget_created'}});
  return {status:201,body:{item:budgetWire(row),auditEventId:receipt.id}};
}

function updateBudget(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'budget.update');const tenant=db(request),input=b(request),id=request.params.id!,expected=expectedVersion(request),current=tenant.get(deps.statements.getBudget,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  for(const field of ['scope','scopeType','scopeId','period','metric'])if(Object.hasOwn(input,field))throw new AdminError(422,`${field} cannot be changed; create a new budget instead`);
  const soft=input.softLimit===undefined?current.soft_limit:input.softLimit===null?null:integer(input.softLimit,'softLimit',0),hard=input.hardLimit===undefined?Number(current.hard_limit):integer(input.hardLimit,'hardLimit',1);
  if(soft!==null&&Number(soft)>hard)throw new AdminError(422,'softLimit cannot exceed hardLimit',undefined,'soft_limit_above_hard');
  const timeZone=input.timezone===undefined?null:canonicalTimeZone(input.timezone),updatedAt=Math.max(at,expected+1),row=tenant.get(deps.statements.updateBudget,input.softLimit===undefined?0:1,soft,input.hardLimit===undefined?null:hard,timeZone,boolInt(input.enabled)??null,updatedAt,id,expected);
  if(!row){if(tenant.get(deps.statements.getBudget,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.tenant_setting_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'budget',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'budget_updated'}});
  return {body:{item:budgetWire(row),auditEventId:receipt.id}};
}

function deleteBudget(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'budget.update');const tenant=db(request),id=request.params.id!,expected=expectedVersion(request),updatedAt=Math.max(at,expected+1);
  const result=tenant.run(deps.statements.deleteBudget,updatedAt,id,expected);
  if(result.changes===0){if(tenant.get(deps.statements.getBudget,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  tx.append({tenantId:tenant.tenantId,action:'admin.tenant_setting_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'budget',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{kind:'budget_disabled'}});
  return {status:204};
}

function createRule(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'policy.update');const tenant=db(request),input=b(request),id=randomUUID(),policyId=s(input.policyId,'policyId'),detectorId=s(input.detectorId,'detectorId'),scope=s(input.scopeType??'tenant','scopeType',20),scopeId=scope==='tenant'?null:s(input.scopeId,'scopeId');
  if(!['tenant','group','user','model'].includes(scope))throw new AdminError(422,'scopeType must be tenant, group, user, or model');
  if(scope==='model'&&!tenant.get(deps.statements.getModel,scopeId!))throw new AdminError(422,'scopeId must identify an existing tenant model');
  const row=one(tenant.get(deps.statements.insertRule,id,policyId,detectorId,scope,scopeId,
    s(input.direction,'direction'),s(input.action,'action'),typeof input.severity==='string'?input.severity:'medium',json(input.config),
    boolInt(input.enabled)??1,input.priority===undefined?100:integer(input.priority,'priority'),at,at,policyId,detectorId));
  const receipt=tx.append({tenantId:tenant.tenantId,action:'gate.rule_created',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'policy_rule',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {status:201,body:{item:row,auditEventId:receipt.id}};
}

function updateRule(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'policy.update');const tenant=db(request),input=b(request),expected=expectedVersion(request),updatedAt=Math.max(at,expected+1),id=request.params.id!;
  const current=tenant.get(deps.statements.getRule,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  const scope=input.scopeType===undefined?String(current.scope_type):s(input.scopeType,'scopeType',20);
  if(!['tenant','group','user','model'].includes(scope))throw new AdminError(422,'scopeType must be tenant, group, user, or model');
  const scopeId=scope==='tenant'?null:input.scopeId===undefined?current.scope_id:s(input.scopeId,'scopeId');
  if(scope==='model'&&!tenant.get(deps.statements.getModel,scopeId!))throw new AdminError(422,'scopeId must identify an existing tenant model');
  const row=tenant.get(deps.statements.updateRule,scope,scopeId,input.direction??null,input.action??null,input.severity??null,
    input.config===undefined?null:json(input.config),boolInt(input.enabled)??null,input.priority??null,updatedAt,id,expected);
  if(!row){if(tenant.get(deps.statements.getRule,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const receipt=tx.append({tenantId:tenant.tenantId,action:'gate.rule_updated',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'policy_rule',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {body:{item:row,auditEventId:receipt.id}};
}

function deleteRule(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'policy.update');const tenant=db(request),id=request.params.id!,current=tenant.get(deps.statements.getRule,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  const expected=expectedVersion(request),result=tenant.run(deps.statements.deleteRule,id,expected);
  if(result.changes===0){if(tenant.get(deps.statements.getRule,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  tx.append({tenantId:tenant.tenantId,action:'gate.rule_deleted',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'policy_rule',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {status:204};
}

function changeGroupMembership(operation:'admin.groups.addMember'|'admin.groups.removeMember',request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'group.membership.update');
  const tenant=db(request),groupId=request.params.id!,userId=request.params.userId!,expected=expectedVersion(request),nextVersion=Math.max(at,expected+1);
  const versionRow=tenant.get(deps.statements.updateGroupVersion,nextVersion,groupId,expected);
  if(!versionRow){if(tenant.get(deps.statements.getGroup,groupId))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const add=operation==='admin.groups.addMember';
  const result=add?tenant.run(deps.statements.addMember,at,groupId,userId):tenant.run(deps.statements.removeMember,groupId,userId);
  if(result.changes===0)throw new AdminError(404,'Group or user was not found, or membership is externally managed',undefined,'membership_externally_managed');
  const version=Number(versionRow.updated_at),change=add?'added':'removed';
  tx.append({tenantId:tenant.tenantId,action:'admin.group_membership_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'group',id:groupId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},
    metadata:{userId,change,fromVersion:expected,toVersion:version}});
  return {status:204};
}

function changeGroupModelAccess(operation:'admin.models.enableForGroup'|'admin.models.disableForGroup',request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'model.group_access.update');
  const tenant=db(request),groupId=request.params.groupId!,modelId=request.params.modelId!,expected=expectedVersion(request),nextVersion=Math.max(at,expected+1);
  const versionRow=tenant.get(deps.statements.updateGroupVersion,nextVersion,groupId,expected);
  if(!versionRow){if(tenant.get(deps.statements.getGroup,groupId))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const enabled=operation==='admin.models.enableForGroup';
  const result=enabled?tenant.run(deps.statements.enableGroupModel,groupId,modelId):tenant.run(deps.statements.disableGroupModel,groupId,modelId);
  if(result.changes===0)throw new AdminError(404,'Group or model was not found, or access already has that state',undefined,'group_model_state_unchanged');
  const version=Number(versionRow.updated_at);
  tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'model',id:modelId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},
    metadata:{groupId,enabled,fromVersion:expected,toVersion:version}});
  return {status:204};
}

function updateModel(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  const tenant=db(request),input=b(request),id=request.params.id!,pricingChanged=input.inputPriceMicroUsdPerMillion!==undefined||input.outputPriceMicroUsdPerMillion!==undefined;
  permit(request,pricingChanged?'model.pricing.update':'model.tenant_access.update');
  const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1);
  const row=tenant.get(deps.statements.updateModel,optionalString(input.displayName,200)??null,boolInt(input.enabled)??null,input.contextWindowTokens??null,input.maxOutputTokens??null,input.inputPriceMicroUsdPerMillion??null,input.outputPriceMicroUsdPerMillion??null,input.capabilities===undefined?null:json(input.capabilities),input.preferenceWeight===undefined?null:integer(input.preferenceWeight,'preferenceWeight'),updatedAt,id,expected);
  if(!row){if(tenant.get(deps.statements.getModel,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.model_access_changed',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'model',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{pricingChanged}});
  return {body:{item:modelWire(row),auditEventId:receipt.id}};
}

function updateGroup(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'group.update');const tenant=db(request),input=b(request),id=request.params.id!,current=tenant.get(deps.statements.getGroup,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  if(Number(current.is_system)===1)throw new AdminError(403,'System groups cannot be changed',undefined,'system_group_immutable');
  const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1),row=tenant.get(deps.statements.updateGroup,
    optionalString(input.name,200)??null,input.description===undefined?0:1,input.description===undefined?null:optionalString(input.description,2000),updatedAt,id,expected);
  if(!row){if(tenant.get(deps.statements.getGroup,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  const receipt=tx.append({tenantId:tenant.tenantId,action:'admin.group_updated',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'group',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {body:{item:groupWire(row),auditEventId:receipt.id}};
}

function deleteGroup(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'group.delete');const tenant=db(request),id=request.params.id!,current=tenant.get(deps.statements.getGroup,id);
  if(!current)throw new AdminError(404,'Resource was not found');
  if(Number(current.is_system)===1)throw new AdminError(403,'System groups cannot be deleted',undefined,'system_group_immutable');
  const expected=expectedVersion(request),updatedAt=Math.max(at,expected+1),result=tenant.run(deps.statements.deleteGroup,updatedAt,updatedAt,id,expected);
  if(result.changes===0){if(tenant.get(deps.statements.getGroup,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}
  tx.append({tenantId:tenant.tenantId,action:'admin.group_deleted',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'group',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{}});
  return {status:204};
}

function forceLogoutUser(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  const tenant=db(request),target=request.params.id!,current=tenant.get(deps.statements.getUser,target);
  if(!current)throw new AdminError(404,'Resource not found');
  if(target!==request.tenant!.principal.userId){permit(request,'member.suspend');requireAccountAccess(request,tenantRoles(tenant.all(deps.statements.listUserRoles,target).map(row=>String(row.key))))}
  const revoked=tenant.run(deps.statements.forceLogoutUserSessions,at,'admin_forced_logout',target).changes;
  tx.append({tenantId:tenant.tenantId,action:'identity.sessions_revoked_all',
    actor:{type:'user',id:request.tenant!.principal.userId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'user',id:target},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},
    metadata:{count:revoked,reasonCode:'admin_forced_logout'}});
  return {body:{revoked}};
}

function createUser(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  permit(request,'member.invite');
  const tenant=db(request),input=b(request),actor=request.tenant!.principal.userId;
  const audit=(action:Parameters<AuditService['append']>[0]['action'],id:string,metadata:JsonObject={}) => tx.append({tenantId:tenant.tenantId,action,actor:{type:'user',id:actor,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'user',id},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  const address=emailAddress(input.email),displayName=s(input.displayName,'displayName',200),userLocale=input.locale===undefined?'en':locale(input.locale,'locale');
  const existing=tenant.get(deps.statements.getUserByEmail,address.email);
  if(existing)throw new AdminError(409,'A user with this email already exists',undefined,'email_taken');
  const id=randomUUID();
  const invitedRole=(input.role===undefined?'member':s(input.role,'role',30)) as TenantRole;
  if(!['admin','compliance','member'].includes(invitedRole))throw new AdminError(422,'role must be admin, compliance, or member');
  const row=one(tenant.get(deps.statements.insertUser,id,address.email,displayName,userLocale,at,at));
  assignRole(request,tenant,deps.statements,id,invitedRole,at,permit);
  const link=issueCredentialLinkInTransaction(deps.database,{tenantId:tenant.tenantId,userId:id,purpose:'setup',issuedByUserId:actor,lifetimeMs:SETUP_LINK_TTL_MS,appOrigin:deps.appOrigin,now:at});
  const receipt=audit('admin.user_invited',id,{emailDomain:address.domain,role:invitedRole});
  const setup:DeliveredCredentialLink={purpose:'setup',url:link.url,expiresAt:new Date(link.expiresAt).toISOString(),emailSent:false,emailFailure:null};
  return {status:201,headers:{'Cache-Control':'no-store','Pragma':'no-cache'},body:{item:user(request,tenant,row,deps.statements),auditEventId:receipt.id,setup}};
}

function replayWithoutCredential(result:RouteResult):RouteResult {
  const body=result.body&&typeof result.body==='object'&&!Array.isArray(result.body)?result.body as Record<string,unknown>:null;
  if(!body)return result;
  if('setup'in body)return{...result,body:{...body,setup:{purpose:'setup',reissueRequired:true} satisfies CredentialLinkResponse}};
  if('credentialLink'in body){const value=body.credentialLink,purpose=value&&typeof value==='object'&&'purpose'in value?String((value as {purpose:unknown}).purpose):undefined;return{...result,body:{...body,credentialLink:{...(purpose?{purpose}:{}),reissueRequired:true}}}}
  return result;
}

async function finishCredentialDelivery(result:RouteResult,request:RouteRequest,deps:AdminAdapterDependencies):Promise<RouteResult> {
  const body=result.body&&typeof result.body==='object'&&!Array.isArray(result.body)?result.body as Record<string,unknown>:null;
  const field=body&&body.setup&&typeof body.setup==='object'?'setup':body&&body.credentialLink&&typeof body.credentialLink==='object'?'credentialLink':null;
  if(!body||!field)return result;
  const link=body[field] as Record<string,unknown>;
  if(typeof link.url!=='string'||typeof link.expiresAt!=='string')return result;
  const targetId=field==='setup'&&body.item&&typeof body.item==='object'&&'id'in body.item?String((body.item as {id:unknown}).id):request.params.id;
  const tenantId=request.tenant!.principal.tenantId;
  const recipient=deps.database.prepare<[TenantId,string],{email:string;locale:Locale;workspace_name:string;timezone:string}>(`SELECT u.email,u.locale,t.name workspace_name,COALESCE(s.timezone,'UTC') timezone FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN tenant_settings s ON s.tenant_id=t.id WHERE u.tenant_id=? AND u.id=?`).get(tenantId,targetId!);
  const failure=(emailFailure:'smtp_unconfigured'|'delivery_failed')=>({...result,body:{...body,[field]:{...link,emailSent:false,emailFailure}}});
  if(!deps.mailer||!recipient)return failure('smtp_unconfigured');
  try{
    await deps.mailer.send(credentialMail({to:recipient.email,locale:recipient.locale,workspaceName:recipient.workspace_name,purpose:(field==='setup'?'setup':link.purpose) as CredentialLinkPurpose,url:link.url,expiresAt:Date.parse(link.expiresAt),timeZone:recipient.timezone}));
    return{...result,body:{...body,[field]:{...link,emailSent:true,emailFailure:null}}};
  }catch{
    deps.logger?.warn('Credential link email delivery failed',{tenantId,userId:targetId,purpose:field==='setup'?'setup':String(link.purpose)});
    return failure('delivery_failed');
  }
}

function issueAdminCredentialLink(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult {
  const tenant=db(request),targetId=request.params.id!,actorId=request.tenant!.principal.userId,target=tenant.get(deps.statements.getUser,targetId);
  if(!target)throw new AdminError(404,'Resource was not found');
  if(targetId===actorId)throw new AdminError(403,'Use password change for your own account',undefined,'self_password_link');
  const targetRoles=tenantRoles(tenant.all(deps.statements.listUserRoles,targetId).map(row=>String(row.key)));
  let purpose:CredentialLinkPurpose,lifetimeMs:number;
  if(target.status==='invited'){
    purpose='setup';lifetimeMs=SETUP_LINK_TTL_MS;
  }else if(target.status==='active'){
    purpose='reset';lifetimeMs=ADMIN_RESET_LINK_TTL_MS;
  }else throw new AdminError(409,'Credential links are unavailable for this user','CONFLICT','password_link_unavailable');
  const advertised=credentialLinkForAccount({userId:actorId,roles:roles(request)},{userId:targetId,roles:targetRoles,status:String(target.status)});
  if(advertised!==purpose)throw new AdminError(403,'You cannot issue a password link for this user',undefined,'password_link_refused');
  const link=issueCredentialLinkInTransaction(deps.database,{tenantId:tenant.tenantId,userId:targetId,purpose,issuedByUserId:actorId,lifetimeMs,appOrigin:deps.appOrigin,now:at});
  const receipt=tx.append({tenantId:tenant.tenantId,action:'identity.credential_link_issued',actor:{type:'user',id:actorId,sessionId:request.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'user',id:targetId},outcome:'success',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata:{purpose}});
  const credentialLink:DeliveredCredentialLink={purpose,url:link.url,expiresAt:new Date(link.expiresAt).toISOString(),emailSent:false,emailFailure:null};
  return{headers:{'Cache-Control':'no-store','Pragma':'no-cache'},body:{credentialLink,auditEventId:receipt.id}};
}

/**
 * The reporting half of the console. Every one of these is a read, so none of them opens an audit
 * transaction; the two operations that do disclose message content — transcript and export — live in
 * the audit adapter, which records them.
 *
 * The route catalog has already checked the caller's tenant permission against `role_permissions`.
 * `permit` is the second, coarser gate the rest of this module uses, and it stays here so a role that
 * somehow holds `audit:read` without being able to read the tenant still cannot read the tenant.
 */
const CONSOLE_OPERATIONS = new Set(['admin.capabilities','admin.dashboard','admin.nudges','admin.analytics.timeseries','admin.analytics.breakdown','admin.analytics.detectors','admin.roles.list','admin.retention.list','admin.projects.list']);
function consoleOperation(operation:string,request:RouteRequest,deps:AdminAdapterDependencies,permit:Permit,at:number):RouteResult {
  const tenant=db(request),query=request.query;
  // Bad filters are the caller's mistake, not a fault: these modules signal them with TypeError and
  // RangeError, which would otherwise surface as a 500 on a mistyped granularity.
  try {
    if(operation==='admin.capabilities'){
      // Ungated on purpose. This is the console's first call and it asks "what may I do here";
      // refusing it would lock out exactly the caller who needs the answer, and it returns nothing
      // beyond that caller's own grants.
      return {body:adminCapabilities(tenant,request.tenant!.principal.userId,deps.console,at)};
    }
    if(operation==='admin.dashboard'){permit(request,'report.read');const window=resolveRange(query.range,at,workspaceTimeZone(tenant,deps.console));return {body:adminDashboardSummary(tenant,{...window,nowMs:at},deps.console)}}
    if(operation==='admin.nudges'){permit(request,'report.read');const window=resolveRange(query.range,at,workspaceTimeZone(tenant,deps.console)),summary=adminDashboardSummary(tenant,{...window,nowMs:at},deps.console);return {body:{items:generateNudges({pendingApprovals:summary.pendingApprovals,blockedRequests:summary.blockedRequests,budgetUsedMicroUsd:summary.budgetUsedMicroUsd,budgetLimitMicroUsd:summary.budgetLimitMicroUsd,warnProceeded:warnProceededCount(tenant,window.fromMs,window.toMs,deps.nudges)})}}}
    if(operation==='admin.analytics.timeseries'){permit(request,'report.read');return {body:analyticsTimeseries(tenant,query,deps.analytics,()=>at)}}
    if(operation==='admin.analytics.breakdown'){permit(request,'report.read');return {body:analyticsBreakdown(tenant,query,deps.analytics,()=>at)}}
    if(operation==='admin.analytics.detectors'){permit(request,'report.read');return {body:analyticsDetectors(tenant,query,deps.analytics,()=>at)}}
    if(operation==='admin.roles.list'){permit(request,'member.read');return {body:deps.directory.listRoles(tenant,query)}}
    if(operation==='admin.retention.list'){permit(request,'retention.read');return {body:deps.directory.listRetention(tenant,query)}}
    permit(request,'tenant.read');return {body:deps.directory.listProjects(tenant,query)};
  } catch(error){
    if(error instanceof TypeError||error instanceof RangeError)throw new AdminError(422,error.message);
    throw error;
  }
}

function changed(result:Database.RunResult):void {if(result.changes===0)throw new AdminError(404,'Resource was not found')}
const strongestOf=(actions:readonly GateAction[]):GateAction=>actions.reduce<GateAction>((strongest,action)=>GATE_ACTION_RANK[action]>GATE_ACTION_RANK[strongest]?action:strongest,'allow');
function complianceSummary(request:RouteRequest,tenant:TenantDb,statements:AdminStatements):RouteResult {
  const scopeType=queryChoice(request.query.scopeType,'scopeType',['tenant','group','model'] as const)??'tenant';
  const direction=queryChoice(request.query.direction,'direction',['outbound','inbound','file'] as const)??'outbound';
  const scopeId=optionalQuery(request.query.scopeId,'scopeId',100);
  const groups=tenant.all(statements.listGroups).map(row=>({id:String(row.id),name:String(row.name)}));
  const models=tenant.all(statements.listModels).map(row=>({id:String(row.id),name:String(row.display_name)}));
  if(scopeType==='tenant'&&scopeId!==null)throw new AdminError(422,'scopeId is only valid for group or model scope');
  if(scopeType!=='tenant'&&scopeId===null)throw new AdminError(422,`scopeId is required for ${scopeType} scope`);
  const group=scopeType==='group'?groups.find(item=>item.id===scopeId):undefined;
  const model=scopeType==='model'?models.find(item=>item.id===scopeId):undefined;
  if(scopeType==='group'&&!group)throw new AdminError(404,'Group was not found');
  if(scopeType==='model'&&!model)throw new AdminError(404,'Model was not found');
  const actions=new Map<string,GateAction[]>();
  for(const row of tenant.all(statements.complianceRules)){
    if(row.direction!==direction)continue;
    if(row.scopeType!=='tenant'&&!(row.scopeType===scopeType&&row.scopeId===scopeId))continue;
    const detectorId=String(row.detectorId),action=row.action as GateAction,current=actions.get(detectorId)??[];
    current.push(action);actions.set(detectorId,current);
  }
  const detectors=tenant.all(statements.listDetectors).map(row=>{
    const detectorActions=row.enabled===1?actions.get(String(row.id))??[]:[];
    const covered=detectorActions.length>0;
    return {detectorId:String(row.id),key:String(row.key),name:String(row.key),kind:String(row.kind),builtin:row.builtin===1,
      detectorEnabled:row.enabled===1,effectiveAction:strongestOf(detectorActions),covered,contributingRuleCount:detectorActions.length};
  }).sort((left,right)=>left.covered!==right.covered?(left.covered?-1:1):GATE_ACTION_RANK[right.effectiveAction]-GATE_ACTION_RANK[left.effectiveAction]||left.name.localeCompare(right.name));
  const summary={block:0,warn:0,mask:0,redact:0,flag:0,allow:0,notCovered:0,requireApproval:0};
  for(const detector of detectors){if(!detector.covered){summary.notCovered++;continue}if(detector.effectiveAction==='require_approval')summary.requireApproval++;else summary[detector.effectiveAction]++;}
  return {body:{scopes:{groups,models},scope:{type:scopeType,id:scopeId,label:group?.name??model?.name??'Organization default'},direction,detectors,summary}};
}
const iso=(value:unknown):string|null => typeof value==='number'&&Number.isFinite(value)?new Date(value).toISOString():null;
function user(request:RouteRequest,tenant:TenantDb,row:Row,statements:AdminStatements):Row{const targetRoles=tenantRoles(tenant.all(statements.listUserRoles,row.id).map(x=>String(x.key)));return {
  id:String(row.id),email:String(row.email),displayName:String(row.display_name),status:String(row.status),
  roles:targetRoles,groups:tenant.all(statements.listUserGroups,row.id).map(group=>({id:String(group.id),name:String(group.name)})),
  actions:accountActions({userId:request.tenant!.principal.userId,roles:roles(request)},{userId:String(row.id),roles:targetRoles,status:String(row.status)}),
  mfaEnabled:row.totp_enabled_at!==null&&row.totp_enabled_at!==undefined,
  locale:String(row.locale),version:Number(row.updated_at),lastActiveAt:iso(row.last_login_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
}}
function assignRole(request:RouteRequest,tenant:TenantDb,st:AdminStatements,targetId:string,target:TenantRole,at:number,permit:(r:RouteRequest,p:GovernancePermission)=>void):void {if(target==='owner')throw new AdminError(403,'Ownership transfer requires the dedicated owner-only operation',undefined,'ownership_transfer_required');permit(request,target==='admin'?'member.assign_admin_role':target==='compliance'?'member.assign_compliance_role':'member.assign_member_role');if(targetId===request.tenant!.principal.userId)throw new AdminError(403,'You cannot change your own role',undefined,'self_role_change');const found=one(tenant.get(st.roleId,target));tenant.run(st.clearAssignableRoles,targetId);changed(tenant.run(st.assignRole,targetId,found.id,request.tenant!.principal.userId,at,targetId))}
function requireAccountAccess(request:RouteRequest,targetRoles:readonly TenantRole[]):void {if(!canActOnAccount(roles(request),targetRoles))throw new AdminError(403,'You cannot act on an account with permissions above your own',undefined,'account_above_caller')}

type Permit=(r:RouteRequest,p:GovernancePermission)=>void; type Audit=(r:RouteRequest,a:Parameters<AuditService['append']>[0]['action'],t:TargetType,id:string|null,m?:JsonObject)=>ReturnType<AuditService['append']>;
function budgetOperation(op:string,r:RouteRequest,t:TenantDb,_i:Body,_at:number,sx:AdminStatements,permit:Permit,_audit:Audit):RouteResult {permit(r,op.endsWith('.list')||op.endsWith('.get')?'budget.read':'budget.update');if(op.endsWith('.list'))return{body:{items:t.all(sx.listBudgets).map(budgetWire),nextCursor:null}};if(op.endsWith('.get'))return{body:budgetWire(one(t.get(sx.getBudget,r.params.id!)))};throw new AdminError(501,`NotImplemented: ${op}`)}
function ruleOperation(op:string,r:RouteRequest,t:TenantDb,_i:Body,_at:number,sx:AdminStatements,permit:Permit,_audit:Audit):RouteResult {
  permit(r,op.endsWith('.list')||op.endsWith('.get')?'policy.read':'policy.update');
  if(op.endsWith('.list'))return{body:{items:t.all(sx.listRules),nextCursor:null}};
  if(op.endsWith('.get'))return{body:one(t.get(sx.getRule,r.params.id!))};
  throw new AdminError(501,`NotImplemented: ${op}`);
}
function mutateDetectorCreate(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult{
  const audit:Audit=(r,action,target,id,metadata={})=>tx.append({tenantId:r.tenant!.principal.tenantId,action,actor:{type:'user',id:r.tenant!.principal.userId,sessionId:r.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:target,id},outcome:'success',context:{requestId:r.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  return detectorOperation('admin.detectors.create',request,db(request),b(request),at,deps.statements,permit,audit);
}
function mutateDetectorUpdate(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult{
  const audit:Audit=(r,action,target,id,metadata={})=>tx.append({tenantId:r.tenant!.principal.tenantId,action,actor:{type:'user',id:r.tenant!.principal.userId,sessionId:r.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:target,id},outcome:'success',context:{requestId:r.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  return detectorOperation('admin.detectors.update',request,db(request),b(request),at,deps.statements,permit,audit);
}
function mutateDetectorDelete(request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult{
  const audit:Audit=(r,action,target,id,metadata={})=>tx.append({tenantId:r.tenant!.principal.tenantId,action,actor:{type:'user',id:r.tenant!.principal.userId,sessionId:r.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:target,id},outcome:'success',context:{requestId:r.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  return detectorOperation('admin.detectors.delete',request,db(request),b(request),at,deps.statements,permit,audit);
}
function detectorOperation(op:string,r:RouteRequest,t:TenantDb,i:Body,at:number,sx:AdminStatements,permit:Permit,audit:Audit):RouteResult {permit(r,op.endsWith('.list')||op.endsWith('.get')?'policy.read':'policy.update');if(op.endsWith('.list'))return{body:{items:t.all(sx.listDetectors).map(detectorWire),nextCursor:null}};if(op.endsWith('.get'))return{body:detectorWire(one(t.get(sx.getDetector,r.params.id!)))};if(op.endsWith('.create')){const id=randomUUID(),cfg=json(i.config),row=one(t.get(sx.insertDetector,id,s(i.key,'key',100),s(i.kind,'kind',40),cfg,createHash('sha256').update(cfg).digest('hex'),boolInt(i.enabled)??1,at,at));const receipt=audit(r,'gate.rule_created','policy_rule',id,{kind:'detector'});return{status:201,body:{item:detectorWire(row),auditEventId:receipt.id}}}if(op.endsWith('.update')){const id=r.params.id!,current=t.get(sx.getDetector,id);if(!current)throw new AdminError(404,'Resource was not found');if(Number(current.builtin)===1)throw new AdminError(403,'Built-in detectors cannot be changed',undefined,'builtin_detector_immutable');if(i.enabled!==undefined&&typeof i.enabled!=='boolean')throw new AdminError(422,'enabled must be a boolean');const expected=expectedVersion(r),updatedAt=Math.max(at,expected+1),cfg=i.config===undefined?null:json(i.config),row=t.get(sx.updateDetector,cfg,cfg?createHash('sha256').update(cfg).digest('hex'):null,boolInt(i.enabled)??null,updatedAt,id,expected);if(!row){if(t.get(sx.getDetector,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}const receipt=audit(r,'gate.rule_updated','policy_rule',id,{kind:'detector'});return{body:{item:detectorWire(row),auditEventId:receipt.id}}}if(op.endsWith('.delete')){const id=r.params.id!,current=t.get(sx.getDetector,id);if(!current)throw new AdminError(404,'Resource was not found');if(Number(current.builtin)===1)throw new AdminError(403,'Built-in detectors cannot be deleted',undefined,'builtin_detector_immutable');const expected=expectedVersion(r),updatedAt=Math.max(at,expected+1),result=t.run(sx.deleteDetector,updatedAt,id,expected);if(result.changes===0){if(t.get(sx.getDetector,id))changedSinceRead();throw new AdminError(404,'Resource was not found')}audit(r,'gate.rule_deleted','policy_rule',id,{kind:'detector'});return{status:204}}throw new AdminError(501,`NotImplemented: ${op}`)}

const CUSTOM_TERM_ACTIONS=['flag','warn','redact','block'] as const;
type CustomTermAction=typeof CUSTOM_TERM_ACTIONS[number];
const customTermSeverity:Record<CustomTermAction,string>={flag:'medium',warn:'high',redact:'high',block:'critical'};
function termsConfig(terms:readonly string[]):Record<string,unknown>{return{terms:[...terms].sort((a,b)=>a.localeCompare(b)),regexes:[],wholeWord:false,maxMatches:Math.max(20,Math.min(5000,terms.length))}}
function configTerms(value:unknown):string[]{try{const parsed=JSON.parse(String(value)) as {terms?:unknown};return Array.isArray(parsed.terms)?parsed.terms.filter((term):term is string=>typeof term==='string'):[]}catch{return[]}}
function customTermsState(t:TenantDb,sx:AdminStatements){
  const byAction=new Map<CustomTermAction,string[]>(),seen=new Set<string>();
  for(const row of t.all(sx.customTermsRules))if(CUSTOM_TERM_ACTIONS.includes(row.action as CustomTermAction)&&Number(row.enabled)===1){const action=row.action as CustomTermAction;for(const term of configTerms(row.config_json))if(!seen.has(term)){seen.add(term);const list=byAction.get(action)??[];list.push(term);byAction.set(action,list)}}
  const terms=CUSTOM_TERM_ACTIONS.flatMap(action=>(byAction.get(action)??[]).map(term=>({term,action}))).sort((a,b)=>a.term.localeCompare(b.term));
  return{terms,counts:{flag:byAction.get('flag')?.length??0,warn:byAction.get('warn')?.length??0,redact:byAction.get('redact')?.length??0,block:byAction.get('block')?.length??0}};
}
function mutateCustomTerms(operation:'admin.customTerms.upsert'|'admin.customTerms.delete',request:RouteRequest,deps:AdminAdapterDependencies,tx:AuditTransaction,at:number,permit:Permit):RouteResult{
  const audit:Audit=(r,action,target,id,metadata={})=>tx.append({tenantId:r.tenant!.principal.tenantId,action,actor:{type:'user',id:r.tenant!.principal.userId,sessionId:r.tenant!.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:target,id},outcome:'success',context:{requestId:r.requestId,traceId:null,source:'http',occurredAtMs:at},metadata});
  return customTermsOperation(operation,request,db(request),b(request),at,deps.statements,permit,audit);
}
function customTermsOperation(op:string,r:RouteRequest,t:TenantDb,i:Body,at:number,sx:AdminStatements,permit:Permit,audit:Audit):RouteResult{
  const read=op.endsWith('.list');permit(r,read?'policy.read':'policy.update');if(read)return{body:customTermsState(t,sx)};
  let incoming:string[];
  if(op.endsWith('.delete'))incoming=Array.isArray(i.terms)?i.terms as string[]:[i.term as string];
  else {if(!CUSTOM_TERM_ACTIONS.includes(i.action as CustomTermAction))throw new AdminError(422,`action must be one of ${CUSTOM_TERM_ACTIONS.join(', ')}`,undefined,'custom_terms_action_invalid');if(!Array.isArray(i.terms)||i.terms.length<1)throw new AdminError(422,'terms must contain at least one term',undefined,'custom_terms_required');incoming=i.terms as string[]}
  const normalized=[...new Set(incoming.map(value=>typeof value==='string'?value.trim().normalize('NFC'):'').filter(Boolean))];
  if(!normalized.length)throw new AdminError(422,'At least one non-blank term is required',undefined,'custom_terms_blank');
  for(const term of normalized)if(term.length<2||term.length>256)throw new AdminError(422,'Each term must be between 2 and 256 characters',undefined,'custom_term_length');
  let detector=t.get(sx.customTermsDetector),rules=t.all(sx.customTermsRules);
  if(!op.endsWith('.delete')&&!detector){const cfg=json(termsConfig([])),id=randomUUID();detector=one(t.get(sx.insertDetector,id,'custom-terms','keyword',cfg,createHash('sha256').update(cfg).digest('hex'),1,at,at));rules=[]}
  const target=op.endsWith('.delete')?null:i.action as CustomTermAction;
  const sets=new Map<CustomTermAction,Set<string>>();for(const action of CUSTOM_TERM_ACTIONS)sets.set(action,new Set());
  for(const row of rules)if(CUSTOM_TERM_ACTIONS.includes(row.action as CustomTermAction))for(const term of configTerms(row.config_json))sets.get(row.action as CustomTermAction)!.add(term);
  for(const term of normalized){for(const set of sets.values())set.delete(term);if(target)sets.get(target)!.add(term)}
  const total=[...sets.values()].reduce((sum,set)=>sum+set.size,0);if(total>5000)throw new AdminError(422,'Custom terms cannot exceed 5,000 total terms',undefined,'custom_terms_too_many');
  if(detector){for(const action of CUSTOM_TERM_ACTIONS){const terms=[...sets.get(action)!].sort((a,b)=>a.localeCompare(b)),row=rules.find(candidate=>candidate.action===action);if(row)t.run(sx.updateCustomTermsRule,json(termsConfig(terms)),terms.length?1:0,customTermSeverity[action],at,row.id);else if(terms.length){const policy=one(t.get(sx.customTermsPolicy));t.get(sx.insertRule,randomUUID(),policy.id,detector.id,'tenant',null,'outbound',action,customTermSeverity[action],json(termsConfig(terms)),1,1000,at,at,policy.id,detector.id)}}
    const union=[...sets.values()].flatMap(set=>[...set]);const cfg=json(termsConfig(union));t.get(sx.updateDetector,cfg,createHash('sha256').update(cfg).digest('hex'),1,at,detector.id,detector.updated_at)}
  const receipt=audit(r,op.endsWith('.delete')?'gate.rule_deleted':'gate.rule_updated','policy_rule',detector?String(detector.id):null,{kind:'custom_terms',count:normalized.length});return{body:{...customTermsState(t,sx),auditEventId:receipt.id}};
}
async function testRule(request:RouteRequest,input:Body,permit:Permit):Promise<RouteResult>{permit(request,'policy.update');const draft=(typeof input.rule==='object'&&input.rule!==null?input.rule:input) as Body,text=s(input.sampleText??input.text,'sampleText',1_000_000),kind=normalizeDetector(s(draft.detectorKind??draft.detector,'detectorKind',40)),action=s(draft.action,'action',40) as GateAction;const rule:ResolvedRule={id:'draft',revision:1,name:'Draft rule',detectorKind:kind,action,passMask:(draft.direction==='inbound'?'postflight':'preflight'),priority:100,scopeType:'org',scopeId:request.tenant!.principal.tenantId,config:(typeof draft.config==='object'&&draft.config!==null?draft.config:{}) as Readonly<Record<string,unknown>>,failureMode:'closed',sourceOrder:0};const engine=new DefaultGateEngine({detectors:deterministicDetectors()});const verdict=await engine.evaluate({evaluationId:randomUUID(),requestId:request.requestId,pass:rule.passMask==='postflight'?'postflight':'preflight',subject:{tenantId:request.tenant!.principal.tenantId,userId:request.tenant!.principal.userId,groupIds:[],roles:request.tenant!.principal.roles},conversationId:null,messageId:null,projectId:null,providerId:'draft',modelId:'draft',locale:'en',nowMs:Date.now(),parts:[{id:'sample',source:'user_prompt',text,mimeType:null,fileId:null,provenance:{draft:true}}],policySnapshot:{snapshotId:'draft',tenantId:request.tenant!.principal.tenantId,policyVersion:0,fingerprint:createHash('sha256').update(JSON.stringify(draft)).digest('hex'),rules:[rule],createdAtMs:Date.now()},abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{draft:true}});return{body:{published:false,action:verdict.action,disposition:verdict.disposition,matches:verdict.matches.map(m=>({category:m.category,confidence:m.confidence,safeExcerpt:m.safeExcerpt,start:m.span?.start??null,end:m.span?.end??null})),degraded:verdict.degraded,failureCodes:verdict.failureCodes,timings:verdict.timings}}}
function normalizeDetector(value:string):DetectorKind {const map:Record<string,DetectorKind>={keyword:'keyword',regex:'keyword',phrase:'keyword',pii:'pii',secret:'secret',source_code:'source_code',classification:'classification_tag',classification_tag:'classification_tag',prompt_injection:'prompt_injection',injection:'prompt_injection',semantic:'semantic_policy',institution:'institution_name',institution_name:'institution_name'};const kind=map[value];if(!kind||kind==='semantic_policy')throw new AdminError(422,kind==='semantic_policy'?'Draft semantic rules require a configured classifier':'Unsupported detector kind');return kind}
