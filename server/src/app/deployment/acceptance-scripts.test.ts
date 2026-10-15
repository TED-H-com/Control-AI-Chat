import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import test from 'node:test';

const root=new URL('../../../../',import.meta.url);
const read=(path:string):string=>readFileSync(new URL(path,root),'utf8');

test('safe Compose operations trust only the recorded deployment identity',()=>{
  const script=read('scripts/compose.sh');
  for(const boundary of [
    'compgen -e','COMPOSE_*','COMPOSE_PROJECT_NAME','COMPOSE_FILE',
    'status --porcelain --untracked-files=all','docker compose "$@"',
  ])assert.ok(script.includes(boundary),`safe Compose wrapper lost ${boundary}`);
  assert.equal(statSync(new URL('scripts/compose.sh',root)).mode&0o111,0o111);
});

test('the Docker context excludes every repository-approved ignored artifact class',()=>{
  const dockerignore=read('.dockerignore');
  for(const pattern of [
    '**/node_modules','**/dist','**/data','**/.env','**/backups','**/*.tsbuildinfo',
    '**/.DS_Store','**/*.swp','**/.idea','**/.vscode',
  ])assert.ok(dockerignore.includes(pattern),`.dockerignore lost ${pattern}`);
});

test('partner verification keeps the password off argv and covers the release handoff boundaries',()=>{
  const script=read('scripts/verify-install.sh');
  assert.match(script,/read -r -s -p 'One-time administrator password:/);
  assert.match(script,/--password-stdin/);
  assert.match(script,/Docker\/Compose commands attach[\s\S]*\{[\s\S]*\} <\/dev\/null[\s\S]*read -r admin_password/);
  assert.doesNotMatch(script,/exec \{password_fd\}/);
  assert.match(script,/--data-binary @-/);
  assert.doesNotMatch(script,/curl[^\n]*--data(?: |[=])[^@]/);
  for(const boundary of [
    'scripts/smoke.sh','timedatectl','schema','integrity','chain','schema_version','docker compose config',
    'HostConfig.PortBindings','NetworkSettings.Ports','Mounts','VERIFY_REPO_DIR','org.opencontainers.image.version',
    "rev-parse --verify 'HEAD^{commit}'",'RestartCount','/api/v1/auth/me','/admin','/api/v1/audit/integrity',
  ])assert.ok(script.includes(boundary),`verification lost ${boundary}`);
  assert.match(script,/must record exactly one COMPOSE_PROJECT_NAME/);
  assert.match(script,/noncanonical or unsupported COMPOSE_ control/);
  assert.match(script,/export COMPOSE_PROJECT_NAME=\$compose_project/);
  assert.match(script,/status --porcelain --untracked-files=all/);
  assert.match(script,/exactly one application container and one Caddy container/);
  assert.match(script,/set \+x/);
  assert.equal(statSync(new URL('scripts/verify-install.sh',root)).mode&0o111,0o111);
});

test('clean-install gate starts from a history-free archive and destroys only its disposable project',()=>{
  const script=read('scripts/clean-install-e2e.sh');
  assert.match(script,/git -C "\$repo_dir" archive --format=tar HEAD/);
  assert.match(script,/status --porcelain --untracked-files=all/);
  assert.match(script,/\/tmp\/gateway-clean-e2e\./);
  assert.match(script,/case "\$test_root" in\s+\/tmp\/gateway-clean-e2e\.\*/);
  assert.match(script,/case "\$variable" in COMPOSE_\*\) unset "\$variable"/);
  assert.match(script,/export COMPOSE_PROJECT_NAME=\$compose_project/);
  assert.match(script,/"\$\{compose_project\}_data" "\$\{compose_project\}_caddy_data" "\$\{compose_project\}_caddy_config"/);
  assert.match(script,/docker compose -p "\$compose_project" -f docker-compose\.yml -f docker-compose\.cloudflare-tunnel\.yml down -v --remove-orphans/);
  assert.match(script,/acceptance passed, but its cleanup failed/);
  assert.match(script,/docker volume inspect "\$expected_volume"/);
  assert.match(script,/docker network inspect "\$\{compose_project\}_internal"/);
  assert.match(script,/acceptance_complete=1/);
  assert.match(script,/Password: \[REDACTED\]/);
  assert.match(script,/grep -Fq -f - "\$deployment_dir\/\.env"/);
  assert.match(script,/installer accepted --force over an existing data volume/);
  assert.match(script,/SHA256SUMS/);
  assert.match(script,/data\.tar\.gz/);
  assert.match(script,/actual_data_volume/);
  assert.match(script,/\$\{compose_project\}_data/);
  assert.match(script,/restored application did not report database health within 180 seconds/);
  assert.match(script,/scripts\/compose\.sh/);
  assert.match(script,/scripts\/verify-install\.sh[\s\S]*scripts\/verify-install\.sh/);
  assert.equal(statSync(new URL('scripts/clean-install-e2e.sh',root)).mode&0o111,0o111);
});
