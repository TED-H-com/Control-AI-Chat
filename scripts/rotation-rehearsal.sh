#!/usr/bin/env bash
# Rehearse the documented provider credential-key rotation against a disposable archive of HEAD.
set -euo pipefail
set +x # Never trace installer output or generated secrets, even under bash -x.
umask 077

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
test_root=
deployment_dir=
compose_project=
started=0
acceptance_complete=0
allow_dirty=0
final_revision=
final_architecture=

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '[%s/17] %s\n' "$1" "$2"; }
validate_project() {
  [[ "$compose_project" =~ ^gateway-rotation-rehearsal-[a-z0-9]+$ ]] ||
    die 'refusing an invalid disposable Compose project identity'
}

cleanup() {
  status=$?
  trap - EXIT
  set +e
  cleanup_failed=0
  if [ "$started" -eq 1 ]; then
    if [[ "$compose_project" =~ ^gateway-rotation-rehearsal-[a-z0-9]+$ ]] && [ -d "$deployment_dir" ]; then
      (cd "$deployment_dir" && docker compose -p "$compose_project" -f docker-compose.yml \
        -f docker-compose.cloudflare-tunnel.yml down -v --remove-orphans >/dev/null 2>&1) || {
        printf 'ERROR: cleanup could not stop the disposable Compose project\n' >&2
        cleanup_failed=1
      }
    else
      printf 'ERROR: cleanup refused an invalid disposable Compose project identity or directory\n' >&2
      cleanup_failed=1
    fi
    if [[ "$compose_project" =~ ^gateway-rotation-rehearsal-[a-z0-9]+$ ]]; then
      remaining_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project" 2>/dev/null) || cleanup_failed=1
      remaining_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$compose_project" 2>/dev/null) || cleanup_failed=1
      remaining_networks=$(docker network ls -q --filter "label=com.docker.compose.project=$compose_project" 2>/dev/null) || cleanup_failed=1
      if [ -n "${remaining_containers:-}${remaining_volumes:-}${remaining_networks:-}" ]; then
        printf 'ERROR: cleanup left disposable Compose resources behind\n' >&2
        cleanup_failed=1
      fi
      for expected_volume in "${compose_project}_data" "${compose_project}_caddy_data" "${compose_project}_caddy_config"; do
        if docker volume inspect "$expected_volume" >/dev/null 2>&1; then
          printf 'ERROR: cleanup left exact disposable volume %s behind\n' "$expected_volume" >&2
          cleanup_failed=1
        fi
      done
      if docker network inspect "${compose_project}_internal" >/dev/null 2>&1; then
        printf 'ERROR: cleanup left the disposable private network behind\n' >&2
        cleanup_failed=1
      fi
      # Only the generated project's app tag; never force removal or prune shared images.
      remaining_image=$(docker image ls -q "${compose_project}-app:latest" 2>/dev/null) || cleanup_failed=1
      if [ -n "$remaining_image" ]; then
        if [[ "$compose_project" =~ ^gateway-rotation-rehearsal-[a-z0-9]+$ ]]; then
          docker image rm "${compose_project}-app:latest" >/dev/null 2>&1 || cleanup_failed=1
        fi
      fi
      remaining_image=$(docker image ls -q "${compose_project}-app:latest" 2>/dev/null) || cleanup_failed=1
      [ -z "$remaining_image" ] || cleanup_failed=1
    fi
  fi
  if [ -n "$test_root" ]; then
    if [[ "$test_root" =~ ^/tmp/gateway-rotation-rehearsal\.[A-Za-z0-9]{6}$ ]] &&
      [[ "$compose_project" =~ ^gateway-rotation-rehearsal-[a-z0-9]+$ ]]; then
      rm -rf -- "$test_root" || cleanup_failed=1
      if [ -e "$test_root" ] || [ -L "$test_root" ]; then
        printf 'ERROR: cleanup left its temporary directory behind\n' >&2
        cleanup_failed=1
      fi
    else
      printf 'ERROR: cleanup refused an invalid temporary directory\n' >&2
      cleanup_failed=1
    fi
  fi
  if [ "$cleanup_failed" -ne 0 ]; then
    printf 'ERROR: rotation rehearsal cleanup failed\n' >&2
    [ "$status" -ne 0 ] || status=1
  fi
  if [ "$status" -eq 0 ] && [ "$acceptance_complete" -eq 1 ]; then
    printf 'rotation-rehearsal: PASS revision=%s architecture=%s\n' "$final_revision" "$final_architecture"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for argument in "$@"; do
  case "$argument" in
    --allow-dirty) allow_dirty=1 ;;
    --help|-h) printf 'Usage: %s [--allow-dirty]\nRehearses HEAD in a destructive-but-disposable Compose project.\n' "$0"; exit 0 ;;
    *) die "unknown argument: $argument" ;;
  esac
done

# Reject caller Compose overrides instead of silently accepting a different deployment boundary.
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) die "unset caller Compose variable before running this rehearsal: $variable" ;; esac
done < <(compgen -e)
unset APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET AUDIT_KEY PROXY_SHARED_SECRET
unset PROVIDER_CREDENTIAL_KEY PROVIDER_CREDENTIAL_PREVIOUS_KEYS PROVIDER_CREDENTIAL_KEY_VERSION
unset RETENTION_ENFORCEMENT_ENABLED NODE_ENV APP_VERSION VCS_REF

step 1 'Check prerequisites and reserve an isolated disposable project'
[ "$(uname -s)" = Linux ] || die 'Linux is required'
final_architecture=$(uname -m)
case "$final_architecture" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $final_architecture" ;; esac
for command_name in docker git openssl curl tar sha256sum ss python3 awk grep tr mktemp mkdir rm sleep cat; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
source_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null) || die 'could not inspect the release checkout state'
if [ -n "$source_status" ]; then
  [ "$allow_dirty" -eq 1 ] || die 'tracked and untracked changes must be committed; use --allow-dirty only to rehearse HEAD during development'
  printf 'WARNING: --allow-dirty: the archive reflects HEAD, NOT the working tree; uncommitted changes will NOT be exercised.\n' >&2
fi
final_revision=$(git -C "$repo_dir" rev-parse --verify 'HEAD^{commit}')
docker info >/dev/null 2>&1 || die 'the Docker daemon is not reachable'
docker compose version >/dev/null 2>&1 || die 'the Docker Compose plugin is required'
listeners=$(ss -H -tln) || die 'could not inspect listening ports'
if printf '%s\n' "$listeners" | awk '$4 ~ /:18080$/ {found=1} END {exit !found}'; then
  die 'loopback acceptance port 18080 is already occupied'
fi

test_root=$(mktemp -d /tmp/gateway-rotation-rehearsal.XXXXXX)
suffix=$(printf '%s' "${test_root##*.}" | tr '[:upper:]' '[:lower:]')
compose_project=gateway-rotation-rehearsal-$suffix
validate_project
deployment_dir=$test_root/deploy
mkdir -m 700 "$deployment_dir"
existing_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing containers'
existing_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing volumes'
existing_networks=$(docker network ls -q --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing networks'
[ -z "$existing_containers$existing_volumes$existing_networks" ] || die 'generated project already has resources; refusing to adopt or clean them'
all_volume_names=$(docker volume ls -q) || die 'could not inspect exact volume names'
for expected_volume in "${compose_project}_data" "${compose_project}_caddy_data" "${compose_project}_caddy_config"; do
  ! grep -Fxq "$expected_volume" <<< "$all_volume_names" || die "exact disposable volume already exists: $expected_volume"
done
all_network_names=$(docker network ls --format '{{.Name}}') || die 'could not inspect exact network names'
! grep -Fxq "${compose_project}_internal" <<< "$all_network_names" || die 'exact disposable network already exists'
existing_image=$(docker image ls -q "${compose_project}-app:latest") || die 'could not inspect disposable image name'
[ -z "$existing_image" ] || die 'exact disposable app image already exists'

step 2 'Archive the committed revision and run the real Tunnel-mode installer'
git -C "$repo_dir" archive --format=tar "$final_revision" | tar -xf - -C "$deployment_dir"
[ ! -e "$deployment_dir/.git" ] || die 'release archive unexpectedly contains Git history'
[ -x "$deployment_dir/install.sh" ] || die 'release archive lost installer execute permission'
validate_project
started=1 # Arm teardown before the installer can create even a partial deployment.
if ! (cd "$deployment_dir" && COMPOSE_PROJECT_NAME=$compose_project ./install.sh \
  --cloudflare-tunnel --domain localhost --email rehearsal@example.test \
  --workspace-name 'Rotation Rehearsal' --admin-email owner@example.test --yes \
  > "$test_root/install.log" 2>&1); then
  die 'fresh installer failed (output withheld because it may contain generated secrets)'
fi

cs() {
  validate_project
  # Verify only the identity markers, without sourcing or printing any .env value.
  [ "$(grep -c '^COMPOSE_PROJECT_NAME=' "$deployment_dir/.env")" -eq 1 ] &&
    grep -Fxq "COMPOSE_PROJECT_NAME=$compose_project" "$deployment_dir/.env" &&
    [ "$(grep -c '^COMPOSE_FILE=' "$deployment_dir/.env")" -eq 1 ] &&
    grep -Fxq 'COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml' "$deployment_dir/.env" ||
    die 'recorded disposable project identity or ingress boundary changed'
  (cd "$deployment_dir" && scripts/compose.sh "$@")
}

app_state() {
  local cid
  cid=$(cs ps -aq app) || die 'could not identify the disposable app'
  [[ "$cid" =~ ^[a-f0-9]{12,64}$ ]] || die 'expected exactly one disposable app container'
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")" = "$compose_project" ] ||
    die 'app container belongs to a different project'
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$cid"
}

wait_healthy() {
  local deadline=$((SECONDS + 180)) snapshot state health restarts
  while [ "$SECONDS" -lt "$deadline" ]; do
    snapshot=$(app_state) || die 'could not inspect the disposable app state'
    read -r state health restarts <<< "$snapshot"
    [ "$restarts" -eq 0 ] || die 'app restarted during an expected clean start'
    if [ "$state" = running ] && [ "$health" = healthy ]; then
      printf '  app running, healthy, zero restarts\n'
      return
    fi
    sleep 2
  done
  die "app did not become healthy within 180 seconds (status=$state health=$health)"
}

recreate_app() {
  cs up -d --force-recreate app > "$test_root/recreate.log" 2>&1 || die 'could not recreate the disposable app'
}

check_coverage() {
  local expected=$1 output
  output=$(cs exec -T app npm run --silent check-key-coverage 2> "$test_root/coverage.err") ||
    die 'check-key-coverage did not exit 0'
  grep -Fxq "$expected" <<< "$output" || die "coverage did not list exactly '$expected'"
  printf '  coverage exit 0; %s\n' "$expected"
}

expect_refusal() {
  local domain=$1 deadline=$((SECONDS + 90)) snapshot state health restarts logs refusals
  local refusal="Refusing to start: $domain name encryption key version 1"
  while [ "$SECONDS" -lt "$deadline" ]; do
    snapshot=$(app_state) || die 'could not inspect the refusing app'
    read -r state health restarts <<< "$snapshot"
    [ "$health" != healthy ] || die 'app became healthy despite the missing old root'
    logs=$(cs logs --no-log-prefix app 2> "$test_root/refusal.err") || die 'could not read disposable app logs'
    refusals=$(grep -cF "$refusal" <<< "$logs" || true)
    if [ "$restarts" -ge 1 ] && [ "$refusals" -ge 1 ]; then
      printf '  refusal observed %s times; status=%s health=%s restarts=%s\n' "$refusals" "$state" "$health" "$restarts"
      printf '  %s\n' "$refusal"
      return
    fi
    sleep 2
  done
  die "no confirmed crash-loop refusal within 90 seconds (status=$state health=$health restarts=$restarts refusals=$refusals)"
}

# Roots remain in mode-600 files inside the mode-700 temporary directory. Never echo values.
edit_keys() {
  local domain=$1 action=$2
  validate_project
  python3 - "$deployment_dir/.env" "$test_root/$domain.old.key" "$domain" "$action" \
    > "$test_root/edit-keys.log" 2>&1 <<'PY' || die 'could not update disposable credential keys (details withheld)'
import json, pathlib, re, secrets, sys
env, saved = map(pathlib.Path, sys.argv[1:3])
domain, action = sys.argv[3:5]
assert domain == 'PROVIDER'
assert action in ('rotate', 'remove', 'restore')
lines = env.read_text().splitlines()
def get(name):
    values = [line[len(name)+1:] for line in lines if line.startswith(name + '=')]
    assert len(values) == 1, 'expected exactly one credential setting'
    return values[0]
def put(name, value):
    indices = [i for i, line in enumerate(lines) if line.startswith(name + '=')]
    assert len(indices) <= 1, 'duplicate credential setting'
    if indices:
        lines[indices[0]] = name + '=' + value
    else:
        lines.append(name + '=' + value)
prefix = domain + '_CREDENTIAL_'
if action == 'rotate':
    assert get(prefix + 'KEY_VERSION') == '1'
    old = get(prefix + 'KEY')
    assert re.fullmatch(r'[a-fA-F0-9]{64}', old), 'expected installer-generated root'
    with saved.open('x') as output:
        output.write(old)
    saved.chmod(0o600)
    put(prefix + 'PREVIOUS_KEYS', json.dumps({'1': old}, separators=(',', ':')))
    put(prefix + 'KEY', secrets.token_hex(32))
    put(prefix + 'KEY_VERSION', '2')
elif action == 'remove':
    assert get(prefix + 'KEY_VERSION') == '2'
    put(prefix + 'PREVIOUS_KEYS', '{}')
else:
    assert get(prefix + 'KEY_VERSION') == '2'
    old = saved.read_text()
    assert re.fullmatch(r'[a-fA-F0-9]{64}', old), 'invalid saved root'
    put(prefix + 'PREVIOUS_KEYS', json.dumps({'1': old}, separators=(',', ':')))
env.write_text('\n'.join(lines) + '\n')
env.chmod(0o600)
PY
}

check_rotation_result() {
  local command_name=$1 count_field=$2 result
  result=$(cs exec -T app npm run --silent "$command_name" 2> "$test_root/rotation.err") ||
    die "$command_name did not exit 0"
  printf '%s\n' "$result" | python3 -c '
import json, sys
result = json.load(sys.stdin)
assert result["status"] == "ok" and result["keyVersion"] == 2
assert result["workspaces"] == 1 and result[sys.argv[1]] == 1
' "$count_field" 2> "$test_root/rotation-result.err" || die "$command_name did not report one credential rotated to version 2 with status ok"
  printf '  %s: status: "ok", keyVersion: 2, %s: 1\n' "$command_name" "$count_field"
}

wait_healthy
step 3 'Provider: seed and verify one enabled encrypted credential at version 1'
# /app is read-only. Stdin modules need absolute imports because their base is the cwd.
cat > "$test_root/seed-provider.mjs" <<'JS'
import assert from 'node:assert/strict';
import Database from '/app/server/node_modules/better-sqlite3/lib/index.js';
import {config} from '/app/server/dist/config.js';
import {deriveProviderCredentialKey, setTenantProviderCredential} from '/app/server/dist/lib/providers/tenant-registry.js';
const db = new Database(process.env.DB_PATH);
try {
  const tenant = db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get();
  assert.ok(tenant, 'no installed tenant');
  assert.equal(config.providerCredentialKeyVersion, 1);
  setTenantProviderCredential(db, {tenantId: tenant.id, provider: 'openai',
    secret: 'placeholder-not-a-real-provider-key',
    key: deriveProviderCredentialKey(config.providerCredentialKey, 1), keyVersion: 1});
  const rows = db.prepare("SELECT tenant_id, provider_key, key_version FROM provider_config WHERE enabled=1 AND credential_source='encrypted' AND credential_ciphertext IS NOT NULL").all();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {tenant_id: tenant.id, provider_key: 'openai', key_version: 1});
} finally { db.close(); }
JS
cs exec -T app node --input-type=module - < "$test_root/seed-provider.mjs" \
  > "$test_root/seed-provider.log" 2>&1 || die 'provider seed or persisted-row assertion failed'
check_coverage 'enabled provider credentials: 1'

step 4 'Provider: retain root 1, set a new root at version 2, and recreate'
edit_keys PROVIDER rotate
recreate_app
wait_healthy
check_coverage 'enabled provider credentials: 1'
printf '  Version 1 is still stored; coverage exit 0 does not authorize removal.\n'

step 5 'Provider: remove the old root too early and prove the crash-loop refusal'
edit_keys PROVIDER remove
recreate_app
expect_refusal 'enabled provider credentials'

step 6 'Provider: restore the old root and require healthy recovery'
edit_keys PROVIDER restore
recreate_app
wait_healthy
check_coverage 'enabled provider credentials: 1'

step 7 'Provider: rotate the credential and require version 2 in the listing'
check_rotation_result rotate-provider-credentials credentialsRotated
check_coverage 'enabled provider credentials: 2'

step 8 'Provider: remove the old root after rotation and require a clean start'
edit_keys PROVIDER remove
recreate_app
wait_healthy
check_coverage 'enabled provider credentials: 2'

step 9 'Provider rotation passed; validating disposable cleanup'
acceptance_complete=1
