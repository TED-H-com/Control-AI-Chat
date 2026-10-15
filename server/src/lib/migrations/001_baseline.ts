import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const baselineSchemaSql = `
-- Migration ledger.
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;

-- Tenancy, users, roles, and organization membership.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(slug) BETWEEN 2 AND 63),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  verified_domain TEXT COLLATE NOCASE,
  domain_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  CHECK ((verified_domain IS NULL) = (domain_verified_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX ux_tenants_domain ON tenants(verified_domain) WHERE verified_domain IS NOT NULL;
CREATE INDEX ix_tenants_status ON tenants(status, created_at);

CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  default_locale TEXT NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en','zh-TW','ja')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  conversation_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (conversation_retention_days BETWEEN 1 AND 3650),
  audit_retention_days INTEGER CHECK (audit_retention_days IS NULL OR audit_retention_days >= 365),
  retain_full_transcripts INTEGER NOT NULL DEFAULT 1 CHECK (retain_full_transcripts IN (0,1)),
  requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 10000),
  concurrent_streams INTEGER NOT NULL DEFAULT 3 CHECK (concurrent_streams BETWEEN 1 AND 100),
  max_upload_bytes INTEGER NOT NULL DEFAULT 26214400 CHECK (max_upload_bytes BETWEEN 1 AND 104857600),
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT,
  brand_name TEXT,
  brand_icon_file_id TEXT,
  brand_icon_mime TEXT,
  brand_icon_sha256 TEXT,
  support_vendor_name TEXT,
  support_contact_email TEXT,
  support_contact_phone TEXT,
  support_contact_url TEXT,
  support_notes TEXT
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','deprovisioned')),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','zh-TW','ja')),
  density TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable','compact')),
  color_mode TEXT NOT NULL DEFAULT 'system' CHECK (color_mode IN ('light','dark','system')),
  email_verified_at INTEGER,
  totp_secret_ciphertext TEXT,
  totp_enabled_at INTEGER,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER, totp_issuer_used TEXT,
  UNIQUE (tenant_id, email),
  CHECK (password_hash IS NOT NULL OR status IN ('invited','deprovisioned')),
  CHECK ((totp_secret_ciphertext IS NULL) = (totp_enabled_at IS NULL))
) STRICT;
CREATE INDEX ix_users_tenant_status ON users(tenant_id, status, display_name);
CREATE INDEX ix_users_tenant_created ON users(tenant_id, created_at DESC);
CREATE INDEX ix_users_deleted ON users(tenant_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX ux_users_tenant_id ON users(tenant_id,id);
CREATE UNIQUE INDEX ux_governance_users_tenant_id ON users(tenant_id,id);

CREATE TABLE credential_links (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('setup','reset')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
  issued_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  issued_by_service TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  consumed_at INTEGER,
  superseded_at INTEGER,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE,
  CHECK(consumed_at IS NULL OR consumed_at>=created_at),
  CHECK(superseded_at IS NULL OR superseded_at>=created_at),
  CHECK(issued_by_user_id IS NULL OR issued_by_service IS NULL)
) STRICT;
CREATE UNIQUE INDEX ux_credential_links_live ON credential_links(tenant_id,user_id,purpose)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX ix_credential_links_user ON credential_links(tenant_id,user_id,created_at DESC);

CREATE TABLE groups (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
) STRICT;
CREATE INDEX ix_groups_active ON groups(tenant_id, name) WHERE deleted_at IS NULL;

CREATE TABLE group_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','system')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX ix_group_members_user ON group_members(tenant_id, user_id, group_id);

CREATE TABLE roles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, key)
) STRICT;
CREATE UNIQUE INDEX ux_roles_system_key ON roles(key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX ux_roles_tenant_key ON roles(tenant_id, key) WHERE tenant_id IS NOT NULL;

CREATE TABLE permissions (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*.*'),
  description TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
) WITHOUT ROWID, STRICT;

CREATE TABLE user_roles (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX ix_user_roles_role ON user_roles(tenant_id, role_id, user_id);

-- Sessions and multi-factor authentication.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  jwt_id TEXT NOT NULL UNIQUE CHECK (length(jwt_id) = 36),
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  user_agent TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('password','mfa')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT, mfa_verified_at_ms INTEGER,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;
CREATE INDEX ix_sessions_user_active ON sessions(tenant_id, user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX ix_sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE mfa_enrollments (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL CHECK(length(secret_ciphertext)>3),
  issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  PRIMARY KEY(tenant_id,user_id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE TABLE mfa_recovery_codes (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_digest TEXT NOT NULL CHECK(length(code_digest)=64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,user_id,code_digest),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE TABLE mfa_login_challenges (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id)=36),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX ix_mfa_login_challenges_expiry ON mfa_login_challenges(expires_at);

-- Models, provider configuration, and access controls.
CREATE TABLE platform_model_versions (
  id TEXT PRIMARY KEY CHECK(length(id)=64),
  provider_key TEXT NOT NULL CHECK(provider_key IN ('openai','anthropic','google','xai','openrouter','venice','nvidia')),
  model_key TEXT NOT NULL CHECK(length(model_key) BETWEEN 1 AND 300),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 300),
  protocol TEXT NOT NULL CHECK(protocol IN ('openai_responses','openai_chat_completions','anthropic_messages','google_generate_content')),
  context_window INTEGER NOT NULL CHECK(context_window>0),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens>0),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
  input_microusd_per_million INTEGER NOT NULL CHECK(input_microusd_per_million>=0),
  output_microusd_per_million INTEGER NOT NULL CHECK(output_microusd_per_million>=0),
  cached_input_microusd_per_million INTEGER CHECK(cached_input_microusd_per_million IS NULL OR cached_input_microusd_per_million>=0),
  pricing_version INTEGER NOT NULL CHECK(pricing_version>=0),
  pricing_verified_at INTEGER,
  vendor_jurisdiction TEXT NOT NULL DEFAULT 'unknown' CHECK(vendor_jurisdiction IN ('us','non_us','unknown')),
  vendor_jurisdiction_verified_at INTEGER,
  processing_region TEXT NOT NULL DEFAULT 'unknown' CHECK(processing_region IN ('us','global','unknown')),
  processing_region_verified_at INTEGER,
  direct_provider INTEGER NOT NULL DEFAULT 0 CHECK(direct_provider IN (0,1)),
  speed_class TEXT NOT NULL DEFAULT 'unknown' CHECK(speed_class IN ('unknown','fast','standard','premium')),
  quality_tier INTEGER NOT NULL DEFAULT 0 CHECK(quality_tier BETWEEN 0 AND 3),
  multi_model_eligible INTEGER NOT NULL DEFAULT 0 CHECK(multi_model_eligible IN (0,1)),
  authoritative INTEGER NOT NULL DEFAULT 0 CHECK(authoritative IN (0,1)),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(effective_to IS NULL OR effective_to>effective_from),
  CHECK(vendor_jurisdiction<>'us' OR (vendor_jurisdiction_verified_at IS NOT NULL AND direct_provider=1)),
  CHECK(processing_region<>'us' OR (processing_region_verified_at IS NOT NULL AND direct_provider=1)),
  CHECK(authoritative=0 OR (pricing_verified_at IS NOT NULL AND vendor_jurisdiction_verified_at IS NOT NULL AND quality_tier>0 AND speed_class<>'unknown')),
  CHECK(multi_model_eligible=0 OR (authoritative=1 AND direct_provider=1 AND vendor_jurisdiction='us' AND speed_class='fast' AND quality_tier=1))
) STRICT;
CREATE INDEX ix_platform_model_route ON platform_model_versions(authoritative,vendor_jurisdiction,direct_provider,speed_class,quality_tier,multi_model_eligible,provider_key);
CREATE INDEX ix_platform_model_lookup ON platform_model_versions(provider_key,model_key,effective_from DESC);

CREATE TABLE model_catalog (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  input_microusd_per_million INTEGER NOT NULL CHECK (input_microusd_per_million >= 0),
  output_microusd_per_million INTEGER NOT NULL CHECK (output_microusd_per_million >= 0),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  platform_model_version_id TEXT REFERENCES platform_model_versions(id) ON DELETE RESTRICT,
  speed_class TEXT NOT NULL DEFAULT 'balanced' CHECK(speed_class IN ('fast','balanced','slow','unknown')),
  quality_tier INTEGER NOT NULL DEFAULT 1 CHECK(quality_tier>0),
  multi_model_eligible INTEGER NOT NULL DEFAULT 0 CHECK(multi_model_eligible IN (0,1)),
  cached_input_microusd_per_million INTEGER CHECK(cached_input_microusd_per_million IS NULL OR cached_input_microusd_per_million>=0),
  vendor_jurisdiction TEXT NOT NULL DEFAULT 'unknown',
  processing_region TEXT NOT NULL DEFAULT 'unknown',
  preference_weight INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, provider_key, model_key)
) STRICT;
CREATE UNIQUE INDEX ux_model_default ON model_catalog(tenant_id) WHERE is_default=1 AND enabled=1;
CREATE INDEX ix_model_picker ON model_catalog(tenant_id, enabled, provider_key, display_name);
CREATE UNIQUE INDEX ux_model_catalog_tenant_id ON model_catalog(tenant_id,id);
CREATE INDEX ix_model_catalog_platform_version ON model_catalog(tenant_id,platform_model_version_id) WHERE platform_model_version_id IS NOT NULL;

CREATE TABLE provider_config (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  credential_source TEXT NOT NULL DEFAULT 'encrypted' CHECK (credential_source IN ('environment','encrypted')),
  credential_ciphertext TEXT,
  key_version INTEGER CHECK (key_version IS NULL OR key_version > 0),
  base_url TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, provider_key),
  CHECK ((credential_source='environment' AND credential_ciphertext IS NULL) OR (credential_source='encrypted' AND (credential_ciphertext IS NOT NULL OR enabled=0)))
) STRICT;

CREATE TABLE group_model_access (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  model_catalog_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (group_id, model_catalog_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX ix_group_model_model ON group_model_access(model_catalog_id, group_id) WHERE enabled=1;

CREATE TABLE group_provider_access (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  provider_config_id TEXT NOT NULL REFERENCES provider_config(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY (group_id, provider_config_id)
) WITHOUT ROWID, STRICT;

-- Assistants, projects, conversations, and messages.
CREATE TABLE assistants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model_catalog_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX ux_assistants_tenant_name ON assistants (tenant_id, name);

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER
) STRICT;
CREATE INDEX ix_projects_owner ON projects(tenant_id, owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New conversation' CHECK (length(title) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  pinned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  content_purged_at INTEGER, tone TEXT, role TEXT, assistant_id TEXT REFERENCES assistants(id) ON DELETE SET NULL,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;
CREATE INDEX ix_conversations_sidebar ON conversations(tenant_id, owner_user_id, status, pinned_at DESC, updated_at DESC);
CREATE INDEX ix_conversations_purge ON conversations(tenant_id, updated_at) WHERE content_purged_at IS NULL;
CREATE UNIQUE INDEX ux_governance_conversations_tenant_id ON conversations(tenant_id,id);

CREATE TABLE project_conversations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, conversation_id),
  UNIQUE (conversation_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  status TEXT NOT NULL CHECK (status IN ('pending','streaming','complete','stopped','failed','blocked')),
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
  model_catalog_id TEXT,
  provider_key TEXT,
  provider_request_id TEXT,
  error_code TEXT,
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_microusd INTEGER CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  policy_action TEXT CHECK (policy_action IS NULL OR policy_action IN ('allow','flag','redact','warn','block','require_approval','mask')),
  protected_item_count INTEGER CHECK (protected_item_count IS NULL OR protected_item_count >= 0),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  edited_from_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  deleted_at INTEGER, approval_id TEXT REFERENCES policy_approval_requests(id),
  UNIQUE (conversation_id, sequence_no),
  CHECK (role = 'assistant' OR output_tokens IS NULL)
) STRICT;
CREATE INDEX ix_messages_conversation ON messages(tenant_id, conversation_id, sequence_no);
CREATE INDEX ix_messages_model_time ON messages(tenant_id, model_catalog_id, created_at DESC);
CREATE INDEX ix_messages_author_time ON messages(tenant_id, author_user_id, created_at DESC);
CREATE INDEX ix_messages_provider_request ON messages(provider_key, provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE UNIQUE INDEX ux_message_approval_release
  ON messages(tenant_id,approval_id) WHERE approval_id IS NOT NULL AND role='assistant';
CREATE UNIQUE INDEX ux_governance_messages_tenant_id ON messages(tenant_id,id);

CREATE TABLE message_parts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('text','file_ref','image_ref','redacted_text')),
  text_content TEXT,
  file_id TEXT,
  mime_type TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, ordinal),
  CHECK (kind IN ('text','redacted_text') OR text_content IS NULL),
  CHECK (kind NOT IN ('file_ref','image_ref') OR file_id IS NOT NULL)
) STRICT;
CREATE INDEX ix_message_parts_file ON message_parts(tenant_id, file_id) WHERE file_id IS NOT NULL;

CREATE TABLE user_chat_preferences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_model_id TEXT REFERENCES model_catalog(id) ON DELETE SET NULL,
  locale TEXT CHECK (locale IS NULL OR locale IN ('en','zh-TW','ja')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id,user_id)
) WITHOUT ROWID, STRICT;

-- Files and reusable skills.
CREATE TABLE project_files (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 500),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 104857600),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','ready','failed','blocked','purged')),
  extracted_text TEXT,
  extraction_error TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  content_purged_at INTEGER,
  UNIQUE (project_id, sha256)
) STRICT;
CREATE INDEX ix_project_files_project ON project_files(tenant_id, project_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_project_files_purge ON project_files(tenant_id, created_at) WHERE content_purged_at IS NULL;

CREATE TABLE skills (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('tenant','personal')),
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT,
  template TEXT NOT NULL CHECK (length(template) BETWEEN 1 AND 100000),
  parameters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parameters_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_skills_tenant_name ON skills(tenant_id, name) WHERE scope='tenant' AND deleted_at IS NULL;
CREATE UNIQUE INDEX ux_skills_personal_name ON skills(tenant_id, owner_user_id, name) WHERE scope='personal' AND deleted_at IS NULL;

CREATE TABLE skill_invocations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
  skill_version INTEGER NOT NULL CHECK (skill_version > 0),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  rendered_prompt_sha256 TEXT NOT NULL CHECK (length(rendered_prompt_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('rendered','submitted','blocked','failed')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_skill_invocations_skill ON skill_invocations(tenant_id, skill_id, created_at DESC);

-- Gate decisions and policy configuration.
CREATE TABLE detector_definitions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('keyword','regex','pii','secret','source_code','classification','injection','semantic','file','institution')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, key)
) STRICT;
CREATE UNIQUE INDEX ux_detectors_builtin_key ON detector_definitions(key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX ux_detectors_tenant_key ON detector_definitions(tenant_id, key) WHERE tenant_id IS NOT NULL;
CREATE INDEX ix_detectors_enabled ON detector_definitions(tenant_id, enabled, kind);

CREATE TABLE policies (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, name)
) STRICT;

CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  detector_id TEXT NOT NULL REFERENCES detector_definitions(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant','group','user','model')),
  scope_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','file')),
  action TEXT NOT NULL CHECK (action IN ('allow','flag','redact','warn','block','require_approval','mask')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_type = 'tenant') = (scope_id IS NULL))
) STRICT;
CREATE INDEX ix_policy_rules_eval ON policy_rules(tenant_id, direction, enabled, priority, scope_type, scope_id);
CREATE INDEX ix_policy_rules_policy ON policy_rules(policy_id, priority);

CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  project_file_id TEXT REFERENCES project_files(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','file')),
  final_action TEXT NOT NULL CHECK (final_action IN ('allow','flag','redact','warn','block','require_approval','mask')),
  status TEXT NOT NULL CHECK (status IN ('final','awaiting_confirmation','pending_approval','approved','denied')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  matched_rule_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(matched_rule_ids_json)),
  matched_detector_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(matched_detector_keys_json)),
  protected_item_count INTEGER CHECK (protected_item_count IS NULL OR protected_item_count >= 0),
  redacted_excerpt TEXT,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0,1)),
  decided_at INTEGER NOT NULL,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  review_note TEXT,
  CHECK ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL))
) STRICT;
CREATE INDEX ix_gate_queue ON gate_decisions(tenant_id, status, decided_at) WHERE status IN ('pending_approval','awaiting_confirmation');
CREATE INDEX ix_gate_user_time ON gate_decisions(tenant_id, user_id, decided_at DESC);
CREATE INDEX ix_gate_action_time ON gate_decisions(tenant_id, final_action, decided_at DESC);
CREATE INDEX ix_gate_message ON gate_decisions(message_id);
CREATE UNIQUE INDEX ux_gate_decisions_tenant_id ON gate_decisions(tenant_id,id);

-- Budgets, routing, usage, and provider execution.
CREATE TABLE budgets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant','group','user')),
  scope_id TEXT,
  period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  metric TEXT NOT NULL CHECK (metric IN ('tokens','usd')),
  soft_limit INTEGER CHECK (soft_limit IS NULL OR soft_limit >= 0),
  hard_limit INTEGER NOT NULL CHECK (hard_limit > 0),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_type='tenant') = (scope_id IS NULL)),
  CHECK (soft_limit IS NULL OR soft_limit <= hard_limit),
  UNIQUE (tenant_id, scope_type, scope_id, period, metric)
) STRICT;
CREATE INDEX ix_budgets_enforce ON budgets(tenant_id, enabled, scope_type, scope_id, metric, period);
CREATE UNIQUE INDEX ux_budgets_tenant_scope ON budgets(tenant_id, period, metric) WHERE scope_type='tenant';

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE RESTRICT,
  usage_record_id TEXT,
  reservation_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reserve','settle','release','adjustment')),
  amount INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  CHECK (period_end > period_start),
  CHECK (kind='adjustment' OR amount >= 0)
) STRICT;
CREATE UNIQUE INDEX ux_budget_reservation_kind ON budget_ledger(budget_id, reservation_key, kind) WHERE reservation_key IS NOT NULL;
CREATE INDEX ix_budget_ledger_sum ON budget_ledger(budget_id, period_start, period_end, created_at);
CREATE INDEX ix_budget_ledger_usage ON budget_ledger(usage_record_id) WHERE usage_record_id IS NOT NULL;

CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','released','settled')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  settled_at INTEGER,
  release_reason TEXT,
  budget_windows_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(budget_windows_json)),
  UNIQUE(tenant_id,idempotency_key)
) STRICT;
CREATE INDEX ix_budget_reservations_active ON budget_reservations(tenant_id,status,expires_at);

CREATE TABLE routing_decisions (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 300),
  run_id TEXT NOT NULL CHECK(length(run_id)>0),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  assistant_message_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('auto','single','multi_model')),
  requested_provider TEXT CHECK(requested_provider IS NULL OR requested_provider IN ('openai','anthropic','google','xai')),
  requested_model_catalog_id TEXT,
  requested_effort TEXT NOT NULL CHECK(requested_effort IN ('fast','standard','deep')),
  selected_model_catalog_id TEXT,
  selected_platform_model_version_id TEXT REFERENCES platform_model_versions(id) ON DELETE RESTRICT,
  selected_provider TEXT CHECK(selected_provider IS NULL OR selected_provider IN ('openai','anthropic','google','xai','openrouter','venice','nvidia')),
  selected_reasoning_effort TEXT CHECK(selected_reasoning_effort IS NULL OR selected_reasoning_effort IN ('none','low','medium','high')),
  vendor_jurisdiction_constraint TEXT NOT NULL DEFAULT 'any' CHECK(vendor_jurisdiction_constraint IN ('us','any')),
  processing_region_constraint TEXT NOT NULL DEFAULT 'any' CHECK(processing_region_constraint IN ('us','any')),
  downgrade_reason TEXT CHECK(downgrade_reason IS NULL OR downgrade_reason IN ('model_unavailable','provider_unavailable','policy','capability','region')),
  baseline_platform_model_version_id TEXT REFERENCES platform_model_versions(id) ON DELETE RESTRICT,
  baseline_cost_microusd INTEGER CHECK(baseline_cost_microusd IS NULL OR baseline_cost_microusd>=0),
  credential_source TEXT CHECK(credential_source IS NULL OR credential_source IN ('platform','byok')),
  route_reason_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(route_reason_json)),
  status TEXT NOT NULL CHECK(status IN ('planned','selected','dispatching','completed','failed','cancelled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  UNIQUE(tenant_id,run_id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,assistant_message_id) REFERENCES messages(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,requested_model_catalog_id) REFERENCES model_catalog(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,selected_model_catalog_id) REFERENCES model_catalog(tenant_id,id) ON DELETE RESTRICT,
  CHECK((mode='multi_model' AND selected_model_catalog_id IS NULL AND selected_platform_model_version_id IS NULL AND selected_provider IS NULL) OR
        (mode<>'multi_model' AND ((status='planned' AND selected_model_catalog_id IS NULL AND selected_platform_model_version_id IS NULL) OR
          (status<>'planned' AND selected_model_catalog_id IS NOT NULL AND selected_provider IS NOT NULL))))
) STRICT;
CREATE INDEX ix_routing_decision_tenant_time ON routing_decisions(tenant_id,created_at_ms DESC,id);
CREATE INDEX ix_routing_decision_downgrade ON routing_decisions(tenant_id,downgrade_reason,created_at_ms DESC) WHERE downgrade_reason IS NOT NULL;

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  model_catalog_id TEXT REFERENCES model_catalog(id) ON DELETE SET NULL,
  provider_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  provider_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','failed','cancelled')),
  provider_cost_microusd INTEGER CHECK(provider_cost_microusd IS NULL OR provider_cost_microusd>=0),
  customer_charge_microusd INTEGER CHECK(customer_charge_microusd IS NULL OR customer_charge_microusd>=0),
  credential_source TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK(credential_source IN ('platform','byok','legacy_unknown')),
  baseline_cost_microusd INTEGER CHECK(baseline_cost_microusd IS NULL OR baseline_cost_microusd>=0),
  savings_microusd INTEGER CHECK(savings_microusd IS NULL OR savings_microusd>=0),
  platform_model_version_id TEXT REFERENCES platform_model_versions(id) ON DELETE RESTRICT,
  routing_decision_id TEXT REFERENCES routing_decisions(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, message_id)
) STRICT;
CREATE INDEX ix_usage_tenant_time ON usage_records(tenant_id, started_at DESC);
CREATE INDEX ix_usage_user_time ON usage_records(tenant_id, user_id, started_at DESC);
CREATE INDEX ix_usage_group_time ON usage_records(tenant_id, group_id, started_at DESC);
CREATE INDEX ix_usage_model_time ON usage_records(tenant_id, model_catalog_id, started_at DESC);
CREATE INDEX ix_usage_project_time ON usage_records(tenant_id, project_id, started_at DESC);
CREATE INDEX ix_usage_provider_request ON usage_records(tenant_id,provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX ix_usage_routing_decision ON usage_records(tenant_id,routing_decision_id) WHERE routing_decision_id IS NOT NULL;
CREATE INDEX ix_usage_customer_charge ON usage_records(tenant_id,started_at DESC,credential_source,customer_charge_microusd);
CREATE UNIQUE INDEX ux_governance_usage_tenant_id ON usage_records(tenant_id,id);
CREATE TRIGGER tr_usage_routing_tenant_insert
BEFORE INSERT ON usage_records
WHEN NEW.routing_decision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM routing_decisions r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.routing_decision_id
)
BEGIN SELECT RAISE(ABORT,'usage routing decision belongs to another tenant'); END;
CREATE TRIGGER tr_usage_routing_tenant_update
BEFORE UPDATE OF tenant_id,routing_decision_id ON usage_records
WHEN NEW.routing_decision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM routing_decisions r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.routing_decision_id
)
BEGIN SELECT RAISE(ABORT,'usage routing decision belongs to another tenant'); END;

CREATE TABLE multi_model_workflows (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routing_decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL CHECK(length(run_id)>0),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  assistant_message_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('planned','running','consolidating','completed','failed','cancelled','indeterminate')),
  expected_executions INTEGER NOT NULL DEFAULT 5 CHECK(expected_executions=5),
  next_execution_ordinal INTEGER NOT NULL DEFAULT 1 CHECK(next_execution_ordinal BETWEEN 1 AND 6),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,run_id),
  FOREIGN KEY(tenant_id,routing_decision_id) REFERENCES routing_decisions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,assistant_message_id) REFERENCES messages(tenant_id,id) ON DELETE RESTRICT,
  CHECK((lease_owner IS NULL)=(lease_expires_at_ms IS NULL)),
  CHECK((status='completed')=(completed_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX ix_multi_workflow_claim ON multi_model_workflows(status,lease_expires_at_ms,updated_at_ms,tenant_id);

CREATE TABLE provider_executions (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  routing_decision_id TEXT NOT NULL,
  usage_record_id TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
  execution_role TEXT NOT NULL CHECK(execution_role IN ('draft','critique','alternative','refine','consolidate')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 300),
  model_catalog_id TEXT NOT NULL,
  platform_model_version_id TEXT,
  provider_key TEXT NOT NULL CHECK(provider_key IN ('openai','anthropic','google','xai','openrouter','venice','nvidia')),
  credential_source TEXT NOT NULL CHECK(credential_source IN ('platform','byok')),
  status TEXT NOT NULL CHECK(status IN ('planned','claimed','streaming','checkpointed','succeeded','failed','cancelled','indeterminate')),
  fence_token TEXT,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  provider_request_id TEXT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens>=0),
  provider_cost_microusd INTEGER CHECK(provider_cost_microusd IS NULL OR provider_cost_microusd>=0),
  customer_charge_microusd INTEGER CHECK(customer_charge_microusd IS NULL OR customer_charge_microusd>=0),
  baseline_cost_microusd INTEGER CHECK(baseline_cost_microusd IS NULL OR baseline_cost_microusd>=0),
  savings_microusd INTEGER CHECK(savings_microusd IS NULL OR savings_microusd>=0),
  result_ciphertext BLOB,
  result_nonce BLOB CHECK(result_nonce IS NULL OR length(result_nonce)=12),
  result_key_version INTEGER CHECK(result_key_version IS NULL OR result_key_version>0),
  result_digest TEXT CHECK(result_digest IS NULL OR length(result_digest)=64),
  result_key_destroyed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  UNIQUE(workflow_id,ordinal),
  FOREIGN KEY(tenant_id,workflow_id) REFERENCES multi_model_workflows(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,routing_decision_id) REFERENCES routing_decisions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,usage_record_id) REFERENCES usage_records(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,model_catalog_id) REFERENCES model_catalog(tenant_id,id) ON DELETE RESTRICT,
  CHECK((ordinal=1 AND execution_role='draft') OR (ordinal=2 AND execution_role='critique') OR
        (ordinal=3 AND execution_role='alternative') OR (ordinal=4 AND execution_role='refine') OR
        (ordinal=5 AND execution_role='consolidate')),
  CHECK((lease_owner IS NULL)=(lease_expires_at_ms IS NULL)),
  CHECK((result_ciphertext IS NULL AND result_nonce IS NULL AND result_key_version IS NULL AND result_digest IS NULL) OR
        (result_ciphertext IS NOT NULL AND result_nonce IS NOT NULL AND result_key_version IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK(credential_source<>'byok' OR COALESCE(customer_charge_microusd,0)=0)
) STRICT;
CREATE INDEX ix_provider_execution_claim ON provider_executions(status,lease_expires_at_ms,created_at_ms,tenant_id);
CREATE INDEX ix_provider_execution_usage ON provider_executions(tenant_id,usage_record_id) WHERE usage_record_id IS NOT NULL;
CREATE INDEX ix_provider_execution_billing ON provider_executions(tenant_id,completed_at_ms,credential_source,customer_charge_microusd);

CREATE TABLE rate_limit_buckets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_key TEXT NOT NULL CHECK (bucket_key IN ('requests','streams')),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  lease_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, bucket_key, window_start)
) WITHOUT ROWID, STRICT;
CREATE INDEX ix_rate_limit_cleanup ON rate_limit_buckets(updated_at);

-- Approvals and violation review.
CREATE TABLE policy_approval_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  violation_id TEXT NOT NULL,
  gate_decision_id TEXT,
  requesting_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_ciphertext BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  assignee_user_id TEXT,
  decision_by_user_id TEXT,
  decision_reason_code TEXT,
  decision_note TEXT,
  release_message_id TEXT,
  release_attempts INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER,
  released_at_ms INTEGER,
  release_run_id TEXT,
  release_user_message_id TEXT,
  release_reservation_id TEXT,
  release_lease_owner TEXT,
  release_lease_expires_at_ms INTEGER,
  release_next_attempt_at_ms INTEGER,
  release_phase TEXT,
  release_error_code TEXT,
  provider_started_at_ms INTEGER,
  result_ciphertext BLOB,
  result_nonce BLOB,
  result_digest TEXT,
  release_finalize_attempts INTEGER NOT NULL DEFAULT 0 CHECK (release_finalize_attempts >= 0),
  payload_terminal_at_ms INTEGER,
  payload_purged_at_ms INTEGER,
  payload_crypto_scheme TEXT NOT NULL DEFAULT 'legacy_v1' CHECK(payload_crypto_scheme IN ('legacy_v1','dek_v2')),
  payload_crypto_state TEXT NOT NULL DEFAULT 'legacy_maintenance_required'
    CHECK(payload_crypto_state IN ('legacy_maintenance_required','legacy_tombstone_unverified','available','key_destroy_pending_scrub','key_destroyed')),
  payload_wrapped_dek BLOB CHECK(payload_wrapped_dek IS NULL OR length(payload_wrapped_dek)=48),
  payload_wrap_nonce BLOB CHECK(payload_wrap_nonce IS NULL OR length(payload_wrap_nonce)=12),
  payload_kek_version INTEGER CHECK(payload_kek_version IS NULL OR payload_kek_version>0),
  payload_key_destroyed_at_ms INTEGER,
  routing_decision_id TEXT,
  FOREIGN KEY(violation_id) REFERENCES policy_violations(id),
  FOREIGN KEY(tenant_id,gate_decision_id) REFERENCES gate_decisions(tenant_id,id),
  UNIQUE(tenant_id,violation_id),
  UNIQUE(tenant_id,gate_decision_id)
) STRICT;
CREATE INDEX ix_approval_release_claim
  ON policy_approval_requests(status,release_next_attempt_at_ms,release_lease_expires_at_ms,created_at_ms);
CREATE UNIQUE INDEX ux_approval_release_run
  ON policy_approval_requests(tenant_id,release_run_id) WHERE release_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_approval_release_user_message
  ON policy_approval_requests(tenant_id,release_user_message_id) WHERE release_user_message_id IS NOT NULL;
CREATE TRIGGER tr_approval_release_status_insert
BEFORE INSERT ON policy_approval_requests
WHEN NEW.status NOT IN ('pending','claimed','approved','releasing','released','rejected','expired','cancelled','release_failed','release_indeterminate')
BEGIN SELECT RAISE(ABORT,'invalid approval status'); END;
CREATE TRIGGER tr_approval_release_status_update
BEFORE UPDATE OF status ON policy_approval_requests
WHEN NEW.status NOT IN ('pending','claimed','approved','releasing','released','rejected','expired','cancelled','release_failed','release_indeterminate')
BEGIN SELECT RAISE(ABORT,'invalid approval status'); END;
CREATE TRIGGER tr_approval_release_lease_update
BEFORE UPDATE OF release_lease_owner,release_lease_expires_at_ms ON policy_approval_requests
WHEN (NEW.release_lease_owner IS NULL)!=(NEW.release_lease_expires_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT,'approval lease fields must be paired'); END;
CREATE TRIGGER tr_approval_release_result_update
BEFORE UPDATE OF result_ciphertext,result_nonce,result_digest ON policy_approval_requests
WHEN (NEW.result_ciphertext IS NULL)+(NEW.result_nonce IS NULL)+(NEW.result_digest IS NULL) NOT IN (0,3)
BEGIN SELECT RAISE(ABORT,'approval result fields must be paired'); END;
CREATE TRIGGER tr_approval_release_dispatch_update
BEFORE UPDATE OF provider_started_at_ms ON policy_approval_requests
WHEN NEW.provider_started_at_ms IS NOT NULL AND NEW.release_reservation_id IS NULL
BEGIN SELECT RAISE(ABORT,'approval dispatch requires a reservation'); END;
CREATE TRIGGER tr_approval_payload_terminal_insert
BEFORE INSERT ON policy_approval_requests
WHEN NEW.status IN ('pending','claimed','approved','releasing','release_failed') AND NEW.payload_terminal_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'nonterminal approval cannot have a terminal timestamp'); END;
CREATE TRIGGER tr_approval_payload_terminal_update
BEFORE UPDATE OF status,payload_terminal_at_ms ON policy_approval_requests
WHEN (NEW.status IN ('pending','claimed','approved','releasing','release_failed') AND NEW.payload_terminal_at_ms IS NOT NULL)
  OR (OLD.payload_terminal_at_ms IS NOT NULL AND NEW.payload_terminal_at_ms IS NOT OLD.payload_terminal_at_ms)
BEGIN SELECT RAISE(ABORT,'invalid approval terminal timestamp'); END;
CREATE INDEX ix_approval_payload_retention
  ON policy_approval_requests(tenant_id,payload_crypto_state,payload_terminal_at_ms,id)
  WHERE payload_crypto_scheme='dek_v2' AND payload_crypto_state IN ('available','key_destroy_pending_scrub');
CREATE TRIGGER tr_approval_payload_crypto_insert
BEFORE INSERT ON policy_approval_requests
WHEN (
  NEW.payload_crypto_scheme='legacy_v1' AND (
    NEW.payload_crypto_state NOT IN ('legacy_maintenance_required','legacy_tombstone_unverified') OR
    NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
    NEW.payload_key_destroyed_at_ms IS NOT NULL OR NEW.payload_purged_at_ms IS NOT NULL
  )
) OR (
  NEW.payload_crypto_scheme='dek_v2' AND (
    NEW.key_version<>2 OR
    (NEW.payload_crypto_state='available' AND (
      NEW.payload_wrapped_dek IS NULL OR NEW.payload_wrap_nonce IS NULL OR NEW.payload_kek_version IS NULL OR
      NEW.payload_key_destroyed_at_ms IS NOT NULL OR NEW.payload_purged_at_ms IS NOT NULL
    )) OR
    (NEW.payload_crypto_state='key_destroy_pending_scrub' AND (
      NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
      NEW.payload_key_destroyed_at_ms IS NULL OR NEW.payload_purged_at_ms IS NOT NULL OR
      NEW.status NOT IN ('released','rejected','expired','cancelled','release_indeterminate')
    )) OR
    (NEW.payload_crypto_state='key_destroyed' AND (
      NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
      NEW.payload_key_destroyed_at_ms IS NULL OR NEW.payload_purged_at_ms IS NULL OR
      NEW.status NOT IN ('released','rejected','expired','cancelled','release_indeterminate')
    )) OR
    NEW.payload_crypto_state IN ('legacy_maintenance_required','legacy_tombstone_unverified')
  )
)
BEGIN SELECT RAISE(ABORT,'invalid approval envelope key state'); END;
CREATE TRIGGER tr_approval_payload_crypto_update
BEFORE UPDATE OF status,key_version,payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,payload_key_destroyed_at_ms,payload_purged_at_ms ON policy_approval_requests
WHEN (
  NEW.payload_crypto_scheme='legacy_v1' AND (
    NEW.payload_crypto_state NOT IN ('legacy_maintenance_required','legacy_tombstone_unverified') OR
    NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
    NEW.payload_key_destroyed_at_ms IS NOT NULL OR NEW.payload_purged_at_ms IS NOT NULL
  )
) OR (
  NEW.payload_crypto_scheme='dek_v2' AND (
    NEW.key_version<>2 OR
    (NEW.payload_crypto_state='available' AND (
      NEW.payload_wrapped_dek IS NULL OR NEW.payload_wrap_nonce IS NULL OR NEW.payload_kek_version IS NULL OR
      NEW.payload_key_destroyed_at_ms IS NOT NULL OR NEW.payload_purged_at_ms IS NOT NULL
    )) OR
    (NEW.payload_crypto_state='key_destroy_pending_scrub' AND (
      NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
      NEW.payload_key_destroyed_at_ms IS NULL OR NEW.payload_purged_at_ms IS NOT NULL OR
      NEW.status NOT IN ('released','rejected','expired','cancelled','release_indeterminate')
    )) OR
    (NEW.payload_crypto_state='key_destroyed' AND (
      NEW.payload_wrapped_dek IS NOT NULL OR NEW.payload_wrap_nonce IS NOT NULL OR NEW.payload_kek_version IS NOT NULL OR
      NEW.payload_key_destroyed_at_ms IS NULL OR NEW.payload_purged_at_ms IS NULL OR
      NEW.status NOT IN ('released','rejected','expired','cancelled','release_indeterminate')
    )) OR
    NEW.payload_crypto_state IN ('legacy_maintenance_required','legacy_tombstone_unverified')
  )
)
BEGIN SELECT RAISE(ABORT,'invalid approval envelope key state'); END;
CREATE TRIGGER tr_approval_payload_crypto_transition
BEFORE UPDATE OF payload_ciphertext,payload_nonce,key_version,payload_digest,result_ciphertext,result_nonce,result_digest,payload_crypto_scheme,payload_crypto_state,payload_wrapped_dek,payload_wrap_nonce,payload_kek_version,payload_key_destroyed_at_ms,payload_purged_at_ms ON policy_approval_requests
WHEN NEW.payload_crypto_scheme IS NOT OLD.payload_crypto_scheme OR
  (OLD.payload_crypto_state IN ('legacy_maintenance_required','legacy_tombstone_unverified','key_destroyed') AND
    NEW.payload_crypto_state IS NOT OLD.payload_crypto_state) OR
  (OLD.payload_crypto_state='available' AND NEW.payload_crypto_state NOT IN ('available','key_destroy_pending_scrub')) OR
  (OLD.payload_crypto_state='key_destroy_pending_scrub' AND NEW.payload_crypto_state NOT IN ('key_destroy_pending_scrub','key_destroyed')) OR
  (OLD.payload_crypto_state IN ('key_destroy_pending_scrub','key_destroyed') AND (
    NEW.payload_ciphertext IS NOT OLD.payload_ciphertext OR NEW.payload_nonce IS NOT OLD.payload_nonce OR
    NEW.key_version IS NOT OLD.key_version OR NEW.payload_digest IS NOT OLD.payload_digest OR
    NEW.result_ciphertext IS NOT OLD.result_ciphertext OR NEW.result_nonce IS NOT OLD.result_nonce OR NEW.result_digest IS NOT OLD.result_digest
  )) OR
  (OLD.payload_crypto_state='key_destroy_pending_scrub' AND (
    NEW.payload_wrapped_dek IS NOT OLD.payload_wrapped_dek OR NEW.payload_wrap_nonce IS NOT OLD.payload_wrap_nonce OR
    NEW.payload_kek_version IS NOT OLD.payload_kek_version OR NEW.payload_key_destroyed_at_ms IS NOT OLD.payload_key_destroyed_at_ms OR
    (NEW.payload_crypto_state='key_destroy_pending_scrub' AND NEW.payload_purged_at_ms IS NOT OLD.payload_purged_at_ms)
  )) OR
  (OLD.payload_crypto_state='key_destroyed' AND (
    NEW.payload_wrapped_dek IS NOT OLD.payload_wrapped_dek OR NEW.payload_wrap_nonce IS NOT OLD.payload_wrap_nonce OR
    NEW.payload_kek_version IS NOT OLD.payload_kek_version OR NEW.payload_key_destroyed_at_ms IS NOT OLD.payload_key_destroyed_at_ms OR
    NEW.payload_purged_at_ms IS NOT OLD.payload_purged_at_ms
  ))
BEGIN SELECT RAISE(ABORT,'approval envelope key destruction is irreversible'); END;
CREATE INDEX ix_approval_routing_decision ON policy_approval_requests(tenant_id,routing_decision_id) WHERE routing_decision_id IS NOT NULL;
CREATE TRIGGER tr_approval_routing_tenant_insert
BEFORE INSERT ON policy_approval_requests
WHEN NEW.routing_decision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM routing_decisions r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.routing_decision_id
)
BEGIN SELECT RAISE(ABORT,'approval routing decision belongs to another tenant'); END;
CREATE TRIGGER tr_approval_routing_tenant_update
BEFORE UPDATE OF tenant_id,routing_decision_id ON policy_approval_requests
WHEN NEW.routing_decision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM routing_decisions r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.routing_decision_id
)
BEGIN SELECT RAISE(ABORT,'approval routing decision belongs to another tenant'); END;

CREATE TABLE policy_violations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  approval_id TEXT,
  subject_user_id TEXT,
  group_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  direction TEXT NOT NULL,
  detector TEXT NOT NULL,
  gate_action TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee_user_id TEXT,
  rule_ids_json TEXT NOT NULL,
  redacted_excerpt TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  due_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolution_reason TEXT CHECK (resolution_reason IS NULL OR length(trim(resolution_reason)) BETWEEN 10 AND 1000),
  resolved_by_user_id TEXT,
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= 0),
  FOREIGN KEY(audit_event_id) REFERENCES audit_events(id),
  UNIQUE(tenant_id,audit_event_id)
) STRICT;
CREATE INDEX idx_policy_violations_triage
  ON policy_violations(tenant_id,status,assignee_user_id,due_at_ms,updated_at_ms DESC,id DESC);

CREATE TABLE policy_violation_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  violation_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(violation_id) REFERENCES policy_violations(id)
) STRICT;
CREATE INDEX idx_policy_violation_comments_timeline
  ON policy_violation_comments(tenant_id,violation_id,created_at_ms,id);

-- Audit, retention, legal holds, and operational alerts.
CREATE TABLE audit_chain_epochs (
  tenant_id TEXT NOT NULL,
  chain_epoch INTEGER NOT NULL,
  genesis_hash TEXT NOT NULL,
  prior_epoch_final_hash TEXT,
  first_sequence INTEGER NOT NULL DEFAULT 1,
  last_sequence INTEGER,
  final_hash TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  incident_id TEXT,
  opened_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  PRIMARY KEY(tenant_id,chain_epoch)
) WITHOUT ROWID;

CREATE TABLE audit_chain_heads (
  tenant_id TEXT PRIMARY KEY,
  chain_epoch INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_hash TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  last_verified_sequence INTEGER NOT NULL DEFAULT 0,
  last_verified_at_ms INTEGER,
  break_sequence INTEGER,
  break_detected_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  last_verified_hash TEXT
) WITHOUT ROWID;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  chain_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  outcome TEXT NOT NULL,
  severity TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_session_id TEXT,
  actor_ip_hmac TEXT,
  actor_user_agent TEXT,
  subject_user_id TEXT,
  group_id TEXT,
  project_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  model_id TEXT,
  provider_id TEXT,
  gate_action TEXT,
  detector TEXT,
  request_id TEXT NOT NULL,
  trace_id TEXT,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  metadata_text TEXT NOT NULL DEFAULT '',
  transcript_id TEXT,
  transcript_digest TEXT,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  hash_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,chain_epoch,sequence),
  FOREIGN KEY(tenant_id,chain_epoch) REFERENCES audit_chain_epochs(tenant_id,chain_epoch)
) STRICT;
CREATE INDEX idx_audit_tenant_time ON audit_events(tenant_id,occurred_at_ms DESC,id DESC);
CREATE INDEX idx_audit_chain_scan ON audit_events(tenant_id,chain_epoch,sequence,prev_hash,event_hash);

CREATE VIRTUAL TABLE audit_events_fts USING fts5(
  tenant_key,
  tenant_id UNINDEXED,
  event_id,
  action,
  request_id,
  target_id,
  metadata_text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

CREATE TABLE audit_transcripts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  content_state TEXT NOT NULL,
  content_encoding TEXT NOT NULL,
  content_ciphertext BLOB,
  content_nonce BLOB,
  key_version INTEGER,
  sanitized_preview TEXT,
  redacted_content_sha256 TEXT NOT NULL,
  original_content_hmac TEXT,
  character_count INTEGER NOT NULL,
  token_count INTEGER,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  purge_after_ms INTEGER,
  purged_at_ms INTEGER,
  UNIQUE(tenant_id,audit_event_id,direction),
  FOREIGN KEY(audit_event_id) REFERENCES audit_events(id)
) STRICT;

CREATE TABLE audit_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  format TEXT NOT NULL,
  include_content INTEGER NOT NULL,
  filters_json TEXT NOT NULL,
  status TEXT NOT NULL,
  storage_path TEXT,
  sha256 TEXT,
  row_count INTEGER,
  byte_count INTEGER,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  fields_json TEXT
) STRICT;

CREATE TABLE audit_legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  reason TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  released_by_user_id TEXT,
  released_at_ms INTEGER,
  release_reason TEXT
) STRICT;

CREATE TABLE alerts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('budget_threshold','violation_spike','provider_failure','audit_chain_break')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  dedupe_key TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  opened_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX ux_alert_open_dedupe ON alerts(tenant_id, dedupe_key) WHERE status<>'resolved';
CREATE INDEX ix_alert_queue ON alerts(tenant_id, status, severity, opened_at DESC);

-- Request idempotency.
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  status TEXT NOT NULL CHECK(status IN ('claimed','dispatching','completed','failed')),
  run_id TEXT,
  conversation_id TEXT,
  user_message_id TEXT,
  assistant_message_id TEXT,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(tenant_id,actor_user_id,method,path,idempotency_key)
) STRICT;
CREATE INDEX ix_idempotency_run ON idempotency_records(tenant_id,run_id);
CREATE INDEX ix_idempotency_retention
  ON idempotency_records(tenant_id,status,completed_at,updated_at,id);

-- Current immutable platform model metadata.
INSERT INTO platform_model_versions (id,provider_key,model_key,display_name,protocol,context_window,max_output_tokens,capabilities_json,input_microusd_per_million,output_microusd_per_million,cached_input_microusd_per_million,pricing_version,pricing_verified_at,vendor_jurisdiction,vendor_jurisdiction_verified_at,processing_region,processing_region_verified_at,direct_provider,speed_class,quality_tier,multi_model_eligible,authoritative,effective_from,effective_to,created_at) VALUES
('d605ae3a110ee31a4a43c2ad3ff6a63f805cd65da35970ecaa4d4c298f7afef0','openai','gpt-5.6-terra','GPT-5.6 Terra','openai_responses',270000,8192,'["text","files","reasoning"]',2500000,15000000,250000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'standard',2,0,1,1786320000000,NULL,1786320000000),
('d0746affaa132a01f068e1c8b7b52adea8cd9a89f4415499d3dc208aadfbe577','openai','gpt-5.6-sol','GPT-5.6 Sol','openai_responses',270000,8192,'["text","files","reasoning"]',5000000,30000000,500000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'premium',3,0,1,1786320000000,NULL,1786320000000),
('7806cafcf1d3d8ea184415f3f8def109c9053753e4dd70eb49341522a1a7e201','openai','gpt-5.6-luna','GPT-5.6 Luna','openai_responses',270000,8192,'["text","files","reasoning"]',1000000,6000000,100000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'fast',1,1,1,1786320000000,NULL,1786320000000),
('788cc274e5dd80f8d87480d64ef2e4987ad0cf676cb0e67372626e6fecd378a8','anthropic','claude-opus-5','Claude Opus 5','anthropic_messages',200000,8192,'["text","files","reasoning"]',5000000,25000000,500000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'premium',3,0,1,1786320000000,NULL,1786320000000),
('d345de5de4e4dc5f93989ff6084eb607d7989b7596de6e804f7e3fbc68790690','anthropic','claude-haiku-4-5-20251001','Claude Haiku 4.5','anthropic_messages',200000,8192,'["text","files"]',1000000,5000000,100000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'fast',1,1,1,1786320000000,NULL,1786320000000),
('8494ea2f73b4a291cc014eb658a5a02639538d6e044a5ea17cd96d74766dba20','google','gemini-3.1-pro-preview','Gemini 3.1 Pro','google_generate_content',200000,8192,'["text","files","reasoning"]',2000000,12000000,200000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'premium',3,0,1,1786320000000,NULL,1786320000000),
('429407e1d1828c55b719a0c038891f8bc366c5fa1d289f9763bf775b48d49c5f','google','gemini-3.6-flash','Gemini 3.6 Flash','google_generate_content',1048576,8192,'["text","files","reasoning"]',1500000,7500000,150000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'fast',1,1,1,1786320000000,NULL,1786320000000),
('0b042e8ba6a6b87398d46619f2a793f1cefa8c808668a702e9930d4a4f5c5383','google','gemini-3.1-flash-lite','Gemini 3.1 Flash Lite','google_generate_content',1048576,8192,'["text","files","reasoning"]',250000,1500000,25000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'fast',1,1,1,1786320000000,NULL,1786320000000),
('dc7b3a06715d2f47121964ccfd9cc3dc2176e7b13aea32db331ecbdd44dfab8d','xai','grok-4.5','Grok 4.5','openai_chat_completions',200000,8192,'["text","files","reasoning"]',2000000,6000000,300000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'premium',3,0,1,1786320000000,NULL,1786320000000),
('109f53bf0784a9520c6d0c738f83a3dd2fda98f7580eb3828074aa40a13e4965','xai','grok-4.3','Grok 4.3','openai_chat_completions',200000,8192,'["text","files"]',1250000,2500000,200000,1,1786320000000,'us',1786320000000,'unknown',NULL,1,'standard',2,0,1,1786320000000,NULL,1786320000000),
('9c4e70c8b430d1592c834f250848ddc6a7a89aa33dfb4899bc7fa92594ae3fda','anthropic','claude-sonnet-5','Claude Sonnet 5','anthropic_messages',200000,8192,'["text","files","reasoning"]',3000000,15000000,300000,1,1788220800000,'us',1788220800000,'unknown',NULL,1,'standard',2,0,1,1788220800000,NULL,1788220800000);
`;

export const migration001 = {
  version: 1,
  name: 'baseline',
  checksumSha256: createHash('sha256').update(baselineSchemaSql).digest('hex'),
  up(database: Database.Database): void {
    database.exec(baselineSchemaSql);
  },
} as const;
