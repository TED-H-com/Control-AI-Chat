#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
test_root=
deployment_dir=
compose_project=
proxy_name=
proxy_started=0
started=0
acceptance_complete=0
final_revision=
final_architecture=

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '[%s/7] %s\n' "$1" "$2"; }

cleanup() {
  status=$?
  trap - EXIT
  set +e
  cleanup_failed=0
  unset admin_password install_output 2>/dev/null || true
  if [ "$proxy_started" -eq 1 ] && [ -n "$proxy_name" ]; then
    docker rm -f "$proxy_name" >/dev/null 2>&1 || { printf 'ERROR: cleanup could not remove the disposable TLS proxy\n' >&2; cleanup_failed=1; }
  fi
  if [ "$started" -eq 1 ] && [ -n "$deployment_dir" ] && [ -d "$deployment_dir" ]; then
    if [[ "$compose_project" =~ ^gateway-clean-e2e-[a-z0-9]+$ ]]; then
      (cd "$deployment_dir" && docker compose -p "$compose_project" -f docker-compose.yml -f docker-compose.cloudflare-tunnel.yml down -v --remove-orphans >/dev/null 2>&1) || {
        printf 'ERROR: cleanup could not stop the disposable Compose project\n' >&2
        cleanup_failed=1
      }
    else
      printf 'ERROR: cleanup refused an invalid disposable Compose project identity\n' >&2
      cleanup_failed=1
    fi
  fi
  if [[ "$compose_project" =~ ^gateway-clean-e2e-[a-z0-9]+$ ]]; then
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
      if [[ "$compose_project" =~ ^gateway-clean-e2e-[a-z0-9]+$ ]]; then
        docker image rm "${compose_project}-app:latest" >/dev/null 2>&1 || cleanup_failed=1
      fi
    fi
    remaining_image=$(docker image ls -q "${compose_project}-app:latest" 2>/dev/null) || cleanup_failed=1
    [ -z "$remaining_image" ] || cleanup_failed=1
  fi
  if [ -n "$test_root" ]; then
    case "$test_root" in
      /tmp/gateway-clean-e2e.*)
        rm -rf -- "$test_root" || { printf 'ERROR: cleanup could not remove its temporary directory\n' >&2; cleanup_failed=1; }
        ;;
      *) printf 'ERROR: cleanup refused an invalid temporary directory\n' >&2; cleanup_failed=1 ;;
    esac
  fi
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then
    printf 'ERROR: clean-install acceptance passed, but its cleanup failed\n' >&2
    exit 1
  fi
  if [ "$status" -eq 0 ] && [ "$acceptance_complete" -eq 1 ]; then
    printf 'clean-install-e2e: PASS revision=%s architecture=%s\n' "$final_revision" "$final_architecture"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Caller-level Compose settings must never redirect this destructive disposable test toward another
# deployment. A generated identity is also passed explicitly to every cleanup.
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) unset "$variable" ;; esac
done < <(compgen -e)
unset APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET
unset AUDIT_KEY PROVIDER_CREDENTIAL_KEY PROVIDER_CREDENTIAL_PREVIOUS_KEYS
unset PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET RETENTION_ENFORCEMENT_ENABLED
unset NODE_ENV APP_VERSION VCS_REF

[ "$(uname -s)" = Linux ] || die 'Linux is required'
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $(uname -m)" ;; esac
for command_name in docker git openssl curl tar sha256sum ss; do command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"; done
docker info >/dev/null 2>&1 || die 'the Docker daemon is not reachable'
docker compose version >/dev/null 2>&1 || die 'the Docker Compose plugin is required'
source_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null) || die 'could not inspect the release checkout state'
[ -z "$source_status" ] || die 'tracked and untracked changes must be committed before the clean release-archive gate'
if ss -H -tln | awk '$4 ~ /:18080$/ {found=1} END {exit !found}'; then
  die 'loopback acceptance port 18080 is already occupied'
fi
if ss -H -tln | awk '$4 == "127.0.0.1:443" || $4 == "[::1]:443" || $4 == "0.0.0.0:443" || $4 == "[::]:443" || $4 == "*:443" {found=1} END {exit !found}'; then
  die 'acceptance TLS port 443 is already bound on a wildcard or loopback address'
fi

test_root=$(mktemp -d /tmp/gateway-clean-e2e.XXXXXX)
deployment_dir=$test_root/$(basename "$test_root")
mkdir -m 700 "$deployment_dir"
e2e_suffix=${test_root##*.}
e2e_suffix=$(printf '%s' "$e2e_suffix" | tr '[:upper:]' '[:lower:]')
compose_project=gateway-clean-e2e-$e2e_suffix
[[ "$compose_project" =~ ^gateway-clean-e2e-[a-z0-9]+$ ]] || die 'generated an invalid disposable Compose project name'
export COMPOSE_PROJECT_NAME=$compose_project
proxy_name=$compose_project-tls
existing_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing containers for the disposable project'
existing_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing volumes for the disposable project'
existing_networks=$(docker network ls -q --filter "label=com.docker.compose.project=$compose_project") || die 'could not inspect existing networks for the disposable project'
[ -z "$existing_containers$existing_volumes$existing_networks" ] ||
  die 'generated Compose project already has Docker resources; refusing destructive acceptance cleanup'
all_volume_names=$(docker volume ls -q) || die 'could not inspect exact Docker volume names for the disposable project'
for expected_volume in "${compose_project}_data" "${compose_project}_caddy_data" "${compose_project}_caddy_config"; do
  ! printf '%s\n' "$all_volume_names" | grep -Fxq "$expected_volume" ||
    die "exact disposable volume name already exists without reliable project ownership: $expected_volume"
done

step 1 'Create a history-free archive from the exact committed revision'
git -C "$repo_dir" archive --format=tar HEAD | tar -xf - -C "$deployment_dir"
[ ! -e "$deployment_dir/.git" ] || die 'release archive unexpectedly contains Git history'
[ -x "$deployment_dir/install.sh" ] || die 'release archive lost installer execute permission'

step 2 'Run the real installer with fresh secrets and the loopback-only Tunnel profile'
# Keep the captured bootstrap password out of xtrace even if a maintainer launches this gate with
# `bash -x`. Tracing remains disabled for verification and recovery.
set +x
started=1
start_seconds=$SECONDS
if ! install_output=$(cd "$deployment_dir" && ./install.sh --cloudflare-tunnel --domain localhost \
  --email acceptance@example.test --workspace-name 'Clean Install Acceptance' \
  --admin-email owner@example.test --yes 2>&1); then
  printf '%s\n' "$install_output" | sed 's/^Password:.*/Password: [REDACTED]/' >&2
  die 'fresh installer failed'
fi
password_count=$(printf '%s\n' "$install_output" | grep -c '^Password: ' || true)
[ "$password_count" -eq 1 ] || die 'installer did not emit exactly one bootstrap password'
admin_password=$(printf '%s\n' "$install_output" | sed -n 's/^Password: //p')
[ -n "$admin_password" ] || die 'bootstrap password is empty'
! printf '%s\n' "$admin_password" | grep -Fq -f - "$deployment_dir/.env" || die 'bootstrap password was written to .env'
unset COMPOSE_PROJECT_NAME
printf 'Installer completed in %s seconds.\n' "$((SECONDS-start_seconds))"

step 3 'Add an isolated self-signed TLS front door for localhost acceptance only'
proxy_config=$test_root/Caddyfile.acceptance
printf '%s\n' \
  '{' \
  '  admin off' \
  '}' \
  'https://localhost {' \
  '  bind 127.0.0.1 ::1' \
  '  tls internal' \
  '  reverse_proxy 127.0.0.1:18080 {' \
  '    header_up Host localhost' \
  '  }' \
  '}' > "$proxy_config"
docker run -d --name "$proxy_name" --network host --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true --tmpfs /config --tmpfs /data \
  -v "$proxy_config:/etc/caddy/Caddyfile:ro" \
  'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648' >/dev/null
proxy_started=1
for _ in $(seq 1 30); do curl -kfsS --max-time 2 https://localhost/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -kfsS --max-time 2 https://localhost/api/health >/dev/null || die 'localhost TLS acceptance proxy did not become ready'

step 4 'Verify TLS, readiness, migrations, boundary, owner login, admin page, and audit chain'
printf '%s\n' "$admin_password" | (cd "$deployment_dir" && scripts/verify-install.sh --insecure --password-stdin https://localhost owner@example.test)

step 5 'Prove non-empty installs cannot be retried or forced with replacement secrets'
env_digest=$(sha256sum "$deployment_dir/.env" | awk '{print $1}')
(cd "$deployment_dir" && scripts/compose.sh down)
if (cd "$deployment_dir" && ./install.sh --cloudflare-tunnel --domain localhost --email acceptance@example.test \
  --workspace-name 'Clean Install Acceptance' --admin-email owner@example.test --yes > "$test_root/retry.out" 2> "$test_root/retry.err"); then
  die 'installer accepted a retry over non-empty deployment data'
fi
grep -Fq 'deployment data is present' "$test_root/retry.err" || die 'retry failed for an unexpected reason'
[ "$env_digest" = "$(sha256sum "$deployment_dir/.env" | awk '{print $1}')" ] || die 'failed retry changed .env'
if (cd "$deployment_dir" && ./install.sh --force --cloudflare-tunnel --domain localhost --email acceptance@example.test \
  --workspace-name 'Clean Install Acceptance' --admin-email owner@example.test --yes > "$test_root/force.out" 2> "$test_root/force.err"); then
  die 'installer accepted --force over an existing data volume'
fi
grep -Fq -- '--force: the current Compose project already has a data volume' "$test_root/force.err" || die '--force failed for an unexpected reason'
[ "$env_digest" = "$(sha256sum "$deployment_dir/.env" | awk '{print $1}')" ] || die 'failed --force changed .env'
(cd "$deployment_dir" && scripts/compose.sh up -d --no-build)
for _ in $(seq 1 60); do curl -kfsS --max-time 2 https://localhost/api/health >/dev/null 2>&1 && break; sleep 1; done

step 6 'Exercise the documented offline backup and destructive restore on this disposable project'
backup_dir=$test_root/backup
install -d -m 700 "$backup_dir"
case "$backup_dir/" in "$deployment_dir/"*) die 'backup staging unexpectedly landed inside the deployment source' ;; esac
install -m 600 "$deployment_dir/.env" "$backup_dir/deployment.env"
(
  cd "$deployment_dir"
  scripts/compose.sh stop app >/dev/null
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -C /data -czf - . > "$backup_dir/data.tar.gz"
  scripts/compose.sh start app >/dev/null
)
(cd "$backup_dir" && sha256sum deployment.env data.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
(
  cd "$deployment_dir"
  target_project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env)
  [ "$target_project" = "$compose_project" ] || die 'recorded project identity changed before restore'
  app_container=$(scripts/compose.sh ps -aq app)
  [ "$(printf '%s\n' "$app_container" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || die 'restore could not identify exactly one app container'
  actual_data_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{println .Name}}{{end}}{{end}}' "$app_container" | awk 'NF')
  [ "$actual_data_volume" = "${compose_project}_data" ] || die 'restore app container does not mount the exact disposable data volume'
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -tzf - < "$backup_dir/data.tar.gz" >/dev/null
  scripts/compose.sh stop app >/dev/null
  scripts/compose.sh run --rm --no-deps -T --entrypoint node app -e \
    'const fs=require("node:fs");for(const name of fs.readdirSync("/data"))fs.rmSync("/data/"+name,{recursive:true,force:true})'
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -C /data -xzf - < "$backup_dir/data.tar.gz"
  env_tmp=$(mktemp ./.env.tmp.XXXXXX)
  install -m 600 "$backup_dir/deployment.env" "$env_tmp"
  mv -f -- "$env_tmp" .env
  cmp -s .env "$backup_dir/deployment.env" || die 'restored deployment.env differs from the backup'
  scripts/compose.sh up -d >/dev/null
  restored_healthy=0
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if scripts/compose.sh exec -T app node -e \
      'fetch("http://127.0.0.1:3010/api/health").then(r=>r.json()).then(body=>process.exit(body.db==="ok"?0:1)).catch(()=>process.exit(1))' \
      >/dev/null 2>&1; then
      restored_healthy=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$restored_healthy" -eq 1 ] || die 'restored application did not report database health within 180 seconds'
)
for _ in $(seq 1 60); do curl -kfsS --max-time 2 https://localhost/api/health >/dev/null 2>&1 && break; sleep 1; done
printf '%s\n' "$admin_password" | (cd "$deployment_dir" && scripts/verify-install.sh --insecure --password-stdin https://localhost owner@example.test)

step 7 'Clean release-archive installation, safe retry, backup, and restore phases passed; validating cleanup'
final_revision=$(git -C "$repo_dir" rev-parse HEAD)
final_architecture=$(uname -m)
acceptance_complete=1
