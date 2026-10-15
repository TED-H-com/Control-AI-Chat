#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) unset "$variable" ;; esac
done < <(compgen -e)
mkdir -p "$test_dir/repo/server/src/scripts" "$test_dir/repo/server/src/lib/migrations" "$test_dir/repo/infra" "$test_dir/repo/scripts" "$test_dir/bin" "$test_dir/docker-root"
export FAKE_DOCKER_ROOT_DIR=$test_dir/docker-root
cp "$repo_dir/install.sh" "$test_dir/repo/install.sh"
cp "$repo_dir/scripts/compose.sh" "$test_dir/repo/scripts/compose.sh"
cp "$repo_dir/VERSION" "$test_dir/repo/VERSION"
export EXPECTED_APP_VERSION
EXPECTED_APP_VERSION=$(tr -d '[:space:]' < "$test_dir/repo/VERSION")
cp "$repo_dir/docker-compose.cloudflare-tunnel.yml" "$test_dir/repo/docker-compose.cloudflare-tunnel.yml"
cp "$repo_dir/infra/Caddyfile.cloudflare-tunnel" "$test_dir/repo/infra/Caddyfile.cloudflare-tunnel"
: > "$test_dir/repo/server/src/scripts/bootstrap.ts"
: > "$test_dir/repo/server/src/lib/migrations/001_test.ts"

cat > "$test_dir/bin/docker" <<'SH'
#!/usr/bin/env sh
if [ "${ASSERT_TUNNEL_COMPOSE:-0}" = 1 ]; then
  [ "${COMPOSE_FILE:-}" = 'docker-compose.yml:docker-compose.cloudflare-tunnel.yml' ] || {
    printf 'Tunnel command lost fixed COMPOSE_FILE: %s\n' "${COMPOSE_FILE:-<unset>}" >&2
    exit 1
  }
fi
case "$*" in
  info)
    case "${FAKE_DOCKER_INFO:-ok}" in
      permission) printf '%s\n' 'Got permission denied while trying to connect to the Docker daemon socket' >&2; exit 1 ;;
      down) printf '%s\n' 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
      *) exit 0 ;;
    esac ;;
  'info --format {{.DockerRootDir}}') printf '%s\n' "${FAKE_DOCKER_ROOT_DIR:?FAKE_DOCKER_ROOT_DIR is required}" ;;
  'version --format {{.Server.Version}}') printf '%s\n' "${FAKE_ENGINE_VERSION:-29.4.1}" ;;
  'compose version --short') printf '%s\n' "${FAKE_COMPOSE_VERSION:-v5.1.3}" ;;
  'compose version'|'compose up -d --no-build') exit 0 ;;
  'compose config --no-env-resolution --no-interpolate --no-path-resolution --format json')
    if [ "${FAKE_TUNNEL_CONFIG:-safe}" = unsafe ]; then
      printf '%s\n' '{"name":"tunnel-repo","networks":{"internal":{"name":"tunnel-repo_internal"}},"services":{"app":{"expose":["3010"],"networks":{"internal":null}},"caddy":{"networks":{"internal":null},"ports":[{"mode":"ingress","host_ip":"0.0.0.0","target":80,"published":"18080","protocol":"tcp"}],"volumes":[{"type":"bind","source":"./infra/Caddyfile.cloudflare-tunnel","target":"/etc/caddy/Caddyfile","read_only":true}]}}}'
    else
      printf '%s\n' '{"name":"tunnel-repo","networks":{"internal":{"name":"tunnel-repo_internal"}},"services":{"app":{"expose":["3010"],"networks":{"internal":null}},"caddy":{"networks":{"internal":null},"ports":[{"mode":"ingress","host_ip":"127.0.0.1","target":80,"published":"18080","protocol":"tcp"}],"volumes":[{"type":"bind","source":"./infra/Caddyfile.cloudflare-tunnel","target":"/etc/caddy/Caddyfile","read_only":true}]}}}'
    fi
    ;;
  'compose build')
    if [ "${ASSERT_CLEAN_COMPOSE_ENV:-0}" = 1 ]; then
      [ -z "${APP_ORIGIN+x}${APP_DOMAIN+x}${PROXY_SHARED_SECRET+x}${NODE_ENV+x}" ] || {
        printf '%s\n' 'deployment values leaked from the caller environment into Compose' >&2
        exit 1
      }
    fi
    [ "${APP_VERSION:-}" = "${EXPECTED_APP_VERSION:?EXPECTED_APP_VERSION is required}" ] || {
      printf 'unexpected APP_VERSION: %s\n' "${APP_VERSION:-<unset>}" >&2
      exit 1
    }
    [ "${VCS_REF:-}" = "${EXPECTED_VCS_REF:-v${EXPECTED_APP_VERSION}}" ] || {
      printf 'unexpected VCS_REF: %s\n' "${VCS_REF:-<unset>}" >&2
      exit 1
    }
    exit 0 ;;
  'volume ls --quiet --filter label=com.docker.compose.project=repo --filter label=com.docker.compose.volume=data')
    case "${FAKE_DATA_VOLUME:-0}" in
      1) printf '%s\n' 'repo_data' ;;
      multiple) printf '%s\n' 'repo_data' 'repo_data_duplicate' ;;
      error) exit 1 ;;
    esac
    exit 0 ;;
  'volume ls --quiet --filter label=com.docker.compose.project=custom-project --filter label=com.docker.compose.volume=data')
    case "${FAKE_DATA_VOLUME:-0}" in
      1) printf '%s\n' 'custom-project_data' ;;
      multiple) printf '%s\n' 'custom-project_data' 'custom-project_data_duplicate' ;;
      error) exit 1 ;;
    esac
    exit 0 ;;
  'volume ls --quiet --filter label=com.docker.compose.project=tunnel-repo --filter label=com.docker.compose.volume=data') exit 0 ;;
  'volume ls --quiet')
    [ "${FAKE_ALL_VOLUMES_ERROR:-0}" != 1 ] || exit 1
    [ -z "${FAKE_ALL_VOLUME_NAME:-}" ] || printf '%s\n' "$FAKE_ALL_VOLUME_NAME"
    ;;
  'compose config --images app')
    case "${FAKE_APP_IMAGE:-ok}" in
      error) exit 1 ;;
      multiple) printf '%s\n' 'repo-app' 'repo-app-duplicate' ;;
      *) printf '%s\n' 'repo-app' ;;
    esac
    ;;
  'image inspect repo-app') [ "${FAKE_IMAGE_INSPECT:-ok}" != error ] ;;
  'run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount type=volume,source=repo_data,target=/data,readonly --entrypoint node repo-app -e '*)
    case "${FAKE_VOLUME_STATE:-empty}" in
      empty) printf '%s' 'EMPTY' ;;
      nonempty) printf '%s' 'NONEMPTY' ;;
      error) exit 1 ;;
      unexpected) printf '%s' 'UNKNOWN' ;;
    esac
    ;;
  'compose exec -T app node -e '*)
    case "$*" in
      *'SELECT COUNT(*) AS count FROM schema_version'*) printf '%s\n' 1 ;;
      *) exit 0 ;;
    esac
    ;;
  'compose exec -T -e NPM_CONFIG_UPDATE_NOTIFIER=false app npm run bootstrap -- --workspace-name Test Workspace --admin-email admin@example.test')
    if [ "${FAKE_EXISTING:-0}" = 1 ]; then
      printf '%s\n' 'Workspace already exists: test-workspace'
    else
      printf '%s\n' 'Login URL: https://localhost/login' 'Email: admin@example.test' 'Password: one-time-test-password'
    fi
    exit 0 ;;
  'compose logs --tail 50 app') exit 0 ;;
  *) printf 'unexpected docker invocation: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod +x "$test_dir/bin/docker"

cat > "$test_dir/bin/git" <<'SH'
#!/usr/bin/env sh
case "$*" in
  '-C '*/repo' status --porcelain --untracked-files=all')
    [ "${FAKE_GIT_DIRTY:-0}" != 1 ] || printf '%s\n' ' M server/src/index.ts'
    ;;
  '-C '*/repo' rev-parse --verify HEAD^{commit}') printf '%s\n' "${FAKE_GIT_SHA:?FAKE_GIT_SHA is required}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod +x "$test_dir/bin/git"

cat > "$test_dir/bin/systemctl" <<'SH'
#!/usr/bin/env sh
[ "$*" = 'is-active --quiet docker' ] || { printf 'unexpected systemctl invocation: %s\n' "$*" >&2; exit 1; }
[ "${FAKE_DOCKER_ACTIVE:-0}" = 1 ]
SH
chmod +x "$test_dir/bin/systemctl"

cat > "$test_dir/bin/ss" <<'SH'
#!/usr/bin/env sh
case "$*" in
  -tln)
    printf '%s\n' 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port'
    if [ "${FAKE_BOUND_443:-0}" = 1 ]; then
      printf '%s\n' 'LISTEN 0      4096   *:443              *:*'
    elif [ "${FAKE_BOUND_80:-0}" = 1 ]; then
      printf '%s\n' 'LISTEN 0      4096   *:80               *:*'
    elif [ "${FAKE_BOUND_18080:-0}" = 1 ]; then
      printf '%s\n' 'LISTEN 0      4096   127.0.0.1:18080    0.0.0.0:*'
    else
      printf '%s\n' 'LISTEN 0      128    127.0.0.1:3010     0.0.0.0:*'
    fi
    ;;
  -uln)
    printf '%s\n' 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port'
    if [ "${FAKE_BOUND_UDP_443:-0}" = 1 ]; then
      printf '%s\n' 'UNCONN 0      0      *:443              *:*'
    else
      printf '%s\n' 'UNCONN 0      0      127.0.0.1:323      0.0.0.0:*'
    fi
    ;;
  *) printf 'unexpected ss invocation: %s\n' "$*" >&2; exit 1 ;;
esac
SH

cat > "$test_dir/bin/uname" <<'SH'
#!/usr/bin/env sh
case "$*" in
  -s) printf '%s\n' Linux ;;
  -m) printf '%s\n' "${FAKE_ARCH:-x86_64}" ;;
  *) printf 'unexpected uname invocation: %s\n' "$*" >&2; exit 1 ;;
esac
SH

cat > "$test_dir/bin/df" <<'SH'
#!/usr/bin/env sh
[ "$1" = -Pk ] && [ "$#" -eq 2 ] || { printf 'unexpected df invocation: %s\n' "$*" >&2; exit 1; }
if [ "$2" = "${FAKE_DOCKER_ROOT_DIR:?FAKE_DOCKER_ROOT_DIR is required}" ]; then
  filesystem=${FAKE_DOCKER_FILESYSTEM:-repo-fs}
  available=${FAKE_DOCKER_AVAILABLE_KB:-20971520}
else
  filesystem=${FAKE_REPO_FILESYSTEM:-repo-fs}
  available=${FAKE_REPO_AVAILABLE_KB:-20971520}
fi
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
printf '%s %s %s %s %s %s\n' "$filesystem" 41943040 0 "$available" 0% "$2"
SH

cat > "$test_dir/bin/timedatectl" <<'SH'
#!/usr/bin/env sh
[ "$*" = 'show --property=NTPSynchronized --value' ] || { printf 'unexpected timedatectl invocation: %s\n' "$*" >&2; exit 1; }
printf '%s\n' "${FAKE_TIME_SYNC:-yes}"
SH

cat > "$test_dir/bin/getent" <<'SH'
#!/usr/bin/env sh
[ "$1" = hosts ] && [ "$#" -eq 2 ] || { printf 'unexpected getent invocation: %s\n' "$*" >&2; exit 1; }
[ "${FAKE_DNS_EMPTY:-0}" = 1 ] || printf '%s %s\n%s %s\n' '192.0.2.10' "$2" '2001:db8::10' "$2"
SH

cat > "$test_dir/bin/curl" <<'SH'
#!/usr/bin/env sh
printf 'unexpected installer curl invocation: %s\n' "$*" >&2
exit 99
SH

cat > "$test_dir/bin/dig" <<'SH'
#!/usr/bin/env sh
printf 'unexpected installer dig invocation: %s\n' "$*" >&2
exit 99
SH
chmod +x "$test_dir/bin/ss" "$test_dir/bin/uname" "$test_dir/bin/df" "$test_dir/bin/timedatectl" \
  "$test_dir/bin/getent" "$test_dir/bin/curl" "$test_dir/bin/dig"

PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >/dev/null
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'dry-run created .env' >&2; exit 1; }

for polluted_control in COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_PROFILES COMPOSE_PROJECT_DIRECTORY; do
  if env "$polluted_control=attacker.env" PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run \
    --domain localhost --email acme@example.test --workspace-name 'Test Workspace' \
    --admin-email admin@example.test >"$test_dir/$polluted_control.out" 2>"$test_dir/$polluted_control.err"; then
    printf 'installer accepted polluted %s\n' "$polluted_control" >&2; exit 1
  fi
  grep -Fq 'unset unsupported caller Compose variables' "$test_dir/$polluted_control.err"
  [ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'Compose pollution created .env' >&2; exit 1; }
done

: > "$test_dir/outside.env"
ln -s "$test_dir/outside.env" "$test_dir/repo/.env"
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/symlink.out" 2>"$test_dir/symlink.err"; then
  printf '%s\n' 'installer accepted a symlinked .env' >&2; exit 1
fi
grep -Fq '.env must be a regular file, not a symbolic link' "$test_dir/symlink.err"
[ ! -s "$test_dir/outside.env" ] || { printf '%s\n' 'installer wrote through a symlinked .env' >&2; exit 1; }
rm "$test_dir/repo/.env"

if COMPOSE_PROJECT_NAME=Invalid.Project PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/project-invalid.out" 2>"$test_dir/project-invalid.err"; then
  printf '%s\n' 'installer accepted an invalid Compose project name' >&2; exit 1
fi
grep -Fq 'COMPOSE_PROJECT_NAME must start with a lowercase letter or digit' "$test_dir/project-invalid.err"

set +e
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email acme@example.test --workspace-name 'Test Workspace' >"$test_dir/missing.out" 2>"$test_dir/missing.err"
missing_status=$?
set -e
[ "$missing_status" -eq 2 ]
grep -q -- '--admin-email' "$test_dir/missing.err"

set +e
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain $'localhost\nNODE_ENV=development' --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/domain-injection.out" 2>"$test_dir/domain-injection.err"
domain_injection_status=$?
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email $'acme@example.test\nAUDIT_KEY=attacker' --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/email-injection.out" 2>"$test_dir/email-injection.err"
email_injection_status=$?
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email 'acme+$JWT_SECRET@example.test' --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/email-interpolation.out" 2>"$test_dir/email-interpolation.err"
email_interpolation_status=$?
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain localhost --email acme@example.test --workspace-name $'Test\nNODE_ENV=development' --admin-email admin@example.test >"$test_dir/workspace-injection.out" 2>"$test_dir/workspace-injection.err"
workspace_injection_status=$?
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --dry-run --domain Private-Example.example.test --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/uppercase-domain.out" 2>"$test_dir/uppercase-domain.err"
uppercase_domain_status=$?
set -e
[ "$domain_injection_status" -eq 1 ]
[ "$email_injection_status" -eq 1 ]
[ "$email_interpolation_status" -eq 1 ]
[ "$workspace_injection_status" -eq 1 ]
[ "$uppercase_domain_status" -eq 1 ]
grep -Fq -- '--domain must be a single line' "$test_dir/domain-injection.err"
grep -Fq -- '--email must be a single line' "$test_dir/email-injection.err"
grep -Fq -- '--email must be a valid email address' "$test_dir/email-interpolation.err"
grep -Fq -- '--workspace-name must be a single line' "$test_dir/workspace-injection.err"
grep -Fq -- '--domain must use lowercase ASCII because browsers normalize Origin hostnames to lowercase' "$test_dir/uppercase-domain.err"
! grep -Fq '[1/6]' "$test_dir/uppercase-domain.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'invalid input created .env' >&2; exit 1; }

set +e
FAKE_ARCH=s390x PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/architecture.out" 2>"$test_dir/architecture.err"
architecture_status=$?
set -e
[ "$architecture_status" -eq 1 ]
grep -Fq 'unsupported architecture s390x; x86_64, aarch64, or arm64 is required' "$test_dir/architecture.err"
! grep -Fq '[3/6]' "$test_dir/architecture.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'architecture preflight created .env' >&2; exit 1; }

set +e
FAKE_BOUND_443=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/bound.out" 2>"$test_dir/bound.err"
bound_status=$?
set -e
[ "$bound_status" -eq 1 ]
grep -Fq 'port 80 or 443 is already bound' "$test_dir/bound.err"
grep -Fq 'LISTEN 0      4096   *:443              *:*' "$test_dir/bound.err"

set +e
FAKE_BOUND_80=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/bound-80.out" 2>"$test_dir/bound-80.err"
bound_80_status=$?
set -e
[ "$bound_80_status" -eq 1 ]
grep -Fq 'TCP port 80 or 443 is already bound' "$test_dir/bound-80.err"
grep -Fq 'LISTEN 0      4096   *:80               *:*' "$test_dir/bound-80.err"

set +e
FAKE_BOUND_UDP_443=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/bound-udp.out" 2>"$test_dir/bound-udp.err"
bound_udp_status=$?
set -e
[ "$bound_udp_status" -eq 1 ]
grep -Fq 'UDP port 443 is already bound' "$test_dir/bound-udp.err"
grep -Fq 'UNCONN 0      0      *:443              *:*' "$test_dir/bound-udp.err"
! grep -Fq '[2/6]' "$test_dir/bound-udp.out"

set +e
FAKE_REPO_AVAILABLE_KB=10485759 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/repo-disk.out" 2>"$test_dir/repo-disk.err"
repo_disk_status=$?
FAKE_DOCKER_AVAILABLE_KB=10485759 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/shared-docker-disk.out" 2>"$test_dir/shared-docker-disk.err"
shared_docker_disk_status=$?
FAKE_DOCKER_FILESYSTEM=docker-fs FAKE_DOCKER_AVAILABLE_KB=10485759 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/docker-disk.out" 2>"$test_dir/docker-disk.err"
docker_disk_status=$?
set -e
[ "$repo_disk_status" -eq 1 ]
[ "$shared_docker_disk_status" -eq 1 ]
[ "$docker_disk_status" -eq 1 ]
grep -Fq 'at least 10 GiB free is required on the repository filesystem' "$test_dir/repo-disk.err"
grep -Fq 'at least 10 GiB free is required at DockerRootDir on the shared repository filesystem' "$test_dir/shared-docker-disk.err"
grep -Fq 'at least 10 GiB free is required on the distinct DockerRootDir filesystem for the image build' "$test_dir/docker-disk.err"
! grep -Fq '[2/6]' "$test_dir/repo-disk.out"
! grep -Fq '[2/6]' "$test_dir/shared-docker-disk.out"
! grep -Fq '[2/6]' "$test_dir/docker-disk.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'disk preflight created .env' >&2; exit 1; }

set +e
FAKE_TIME_SYNC=no PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/time.out" 2>"$test_dir/time.err"
time_status=$?
set -e
[ "$time_status" -eq 1 ]
grep -Fq 'host time is not synchronized' "$test_dir/time.err"
! grep -Fq '[2/6]' "$test_dir/time.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'time preflight created .env' >&2; exit 1; }

set +e
FAKE_DATA_VOLUME=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/fresh-volume.out" 2>"$test_dir/fresh-volume.err"
fresh_volume_status=$?
set -e
[ "$fresh_volume_status" -eq 1 ]
grep -Fq 'fresh install: the current Compose project already has a data volume' "$test_dir/fresh-volume.err"
grep -Fq 'refusing to rotate deployment secrets over existing data' "$test_dir/fresh-volume.err"
! grep -Fq '[3/6]' "$test_dir/fresh-volume.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'fresh volume collision created .env' >&2; exit 1; }

set +e
FAKE_ALL_VOLUME_NAME=repo_data PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/fresh-unlabelled-volume.out" 2>"$test_dir/fresh-unlabelled-volume.err"
fresh_unlabelled_volume_status=$?
set -e
[ "$fresh_unlabelled_volume_status" -eq 1 ]
grep -Fq 'fresh install: the current Compose project already has a data volume' "$test_dir/fresh-unlabelled-volume.err"
! grep -Fq '[3/6]' "$test_dir/fresh-unlabelled-volume.out"
[ ! -e "$test_dir/repo/.env" ] || { printf '%s\n' 'unlabelled volume collision created .env' >&2; exit 1; }

set +e
FAKE_DOCKER_INFO=permission PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/permission.out" 2>"$test_dir/permission.err"
permission_status=$?
FAKE_DOCKER_INFO=down PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/down.out" 2>"$test_dir/down.err"
down_status=$?
set -e
[ "$permission_status" -eq 1 ]
[ "$down_status" -eq 1 ]
grep -Fqi 'docker group' "$test_dir/permission.err"
! grep -Fq 'Docker daemon is not reachable' "$test_dir/permission.err"
grep -Fq 'Docker daemon is not reachable' "$test_dir/down.err"
! cmp -s "$test_dir/permission.err" "$test_dir/down.err"

ASSERT_CLEAN_COMPOSE_ENV=1 APP_ORIGIN=https://attacker.example APP_DOMAIN=attacker.example \
  PROXY_SHARED_SECRET=attacker \
  NODE_ENV=development PATH="$test_dir/bin:$PATH" \
  "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test \
  --workspace-name 'Test Workspace' --admin-email admin@example.test > "$test_dir/output"
grep -q '^Password: one-time-test-password$' "$test_dir/output"
[ "$(grep -c '^Password: one-time-test-password$' "$test_dir/output")" -eq 1 ]
grep -Fq 'DNS for localhost resolves to:' "$test_dir/output"
grep -Fxq '192.0.2.10' "$test_dir/output"
grep -Fxq '2001:db8::10' "$test_dir/output"
grep -Fq 'Confirm these addresses point to this machine before continuing with public verification.' "$test_dir/output"
grep -q '^NODE_ENV=production$' "$test_dir/repo/.env"
grep -q '^PROVIDER_CREDENTIAL_KEY_VERSION=1$' "$test_dir/repo/.env"
grep -Fxq 'COMPOSE_PROJECT_NAME=repo' "$test_dir/repo/.env"
[ "$(stat -c '%a' "$test_dir/repo/.env")" = 600 ]
! find "$test_dir/repo" -maxdepth 1 -name '.env.tmp.*' -print -quit | grep -q . || { printf '%s\n' 'installer left a temporary secret file' >&2; exit 1; }
PATH="$test_dir/bin:$PATH" "$test_dir/repo/scripts/compose.sh" version >/dev/null
if COMPOSE_PROFILES=attacker PATH="$test_dir/bin:$PATH" "$test_dir/repo/scripts/compose.sh" version >"$test_dir/compose-wrapper-polluted.out" 2>"$test_dir/compose-wrapper-polluted.err"; then
  printf '%s\n' 'safe Compose wrapper accepted caller COMPOSE_PROFILES' >&2; exit 1
fi
grep -Fq 'unset caller Compose variables' "$test_dir/compose-wrapper-polluted.err"

checkout_sha=0123456789abcdef0123456789abcdef01234567
mkdir "$test_dir/repo/.git"
if FAKE_GIT_DIRTY=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/dirty-source.out" 2>"$test_dir/dirty-source.err"; then
  printf '%s\n' 'installer accepted a dirty Git deployment source' >&2; exit 1
fi
grep -Fq 'Git deployment checkout has tracked or untracked changes' "$test_dir/dirty-source.err"
! grep -Fq '[2/6]' "$test_dir/dirty-source.out"
EXPECTED_VCS_REF=$checkout_sha FAKE_GIT_SHA=$checkout_sha PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/checkout.out"
rmdir "$test_dir/repo/.git"

audit_key_before=$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")
provider_key_before=$(grep '^PROVIDER_CREDENTIAL_KEY=' "$test_dir/repo/.env")
PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/rerun.out"
audit_key_after=$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")
[ "$audit_key_before" = "$audit_key_after" ]
[ "$provider_key_before" = "$(grep '^PROVIDER_CREDENTIAL_KEY=' "$test_dir/repo/.env")" ]
grep -Fq 'existing secrets were kept' "$test_dir/rerun.out"

if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain changed.example.test --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/domain-mismatch.out" 2>"$test_dir/domain-mismatch.err"; then
  printf '%s\n' 'installer accepted a --domain that differs from existing APP_DOMAIN' >&2
  exit 1
fi
! grep -Fq '[3/6]' "$test_dir/domain-mismatch.out"
[ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
grep -Fq -- '--domain does not exactly match APP_DOMAIN' "$test_dir/domain-mismatch.err"

cp "$test_dir/repo/.env" "$test_dir/original.env"
sed 's|^APP_ORIGIN=.*|APP_ORIGIN=https://changed.example.test|' "$test_dir/original.env" > "$test_dir/repo/.env"
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/origin-mismatch.out" 2>"$test_dir/origin-mismatch.err"; then
  printf '%s\n' 'installer accepted an APP_ORIGIN that differs from --domain' >&2
  exit 1
fi
! grep -Fq '[3/6]' "$test_dir/origin-mismatch.out"
[ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
grep -Fq -- '--domain does not exactly match APP_ORIGIN' "$test_dir/origin-mismatch.err"
cp "$test_dir/original.env" "$test_dir/repo/.env"

if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email changed@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/acme-mismatch.out" 2>"$test_dir/acme-mismatch.err"; then
  printf '%s\n' 'installer accepted an --email that differs from existing ACME_EMAIL' >&2
  exit 1
fi
! grep -Fq '[3/6]' "$test_dir/acme-mismatch.out"
[ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
grep -Fq -- '--email does not exactly match ACME_EMAIL' "$test_dir/acme-mismatch.err"

FAKE_DATA_VOLUME=1 FAKE_VOLUME_STATE=empty PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/empty-volume.out"
[ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
grep -Fq 'data volume contains no deployment data' "$test_dir/empty-volume.out"
grep -Fq 'existing secrets were kept' "$test_dir/empty-volume.out"

for volume_state in nonempty error unexpected; do
  if FAKE_DATA_VOLUME=1 FAKE_VOLUME_STATE="$volume_state" PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/volume-$volume_state.out" 2>"$test_dir/volume-$volume_state.err"; then
    printf 'installer accepted a Compose data volume in state %s\n' "$volume_state" >&2
    exit 1
  fi
  ! grep -Fq '[3/6]' "$test_dir/volume-$volume_state.out"
  [ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
done
grep -Fq 'deployment data is present' "$test_dir/volume-nonempty.err"
grep -Fq 'could not safely inspect' "$test_dir/volume-error.err"
grep -Fq 'unexpected result' "$test_dir/volume-unexpected.err"

for discovery_state in error multiple; do
  if FAKE_DATA_VOLUME="$discovery_state" PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/discovery-$discovery_state.out" 2>"$test_dir/discovery-$discovery_state.err"; then
    printf 'installer accepted ambiguous volume discovery state %s\n' "$discovery_state" >&2
    exit 1
  fi
  ! grep -Fq '[3/6]' "$test_dir/discovery-$discovery_state.out"
  [ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
done
grep -Fq 'could not determine whether the Compose data volume exists' "$test_dir/discovery-error.err"
grep -Fq 'more than one Compose data volume matched' "$test_dir/discovery-multiple.err"

for image_state in error multiple; do
  if FAKE_DATA_VOLUME=1 FAKE_APP_IMAGE="$image_state" PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/image-$image_state.out" 2>"$test_dir/image-$image_state.err"; then
    printf 'installer accepted ambiguous application image state %s\n' "$image_state" >&2
    exit 1
  fi
  ! grep -Fq '[3/6]' "$test_dir/image-$image_state.out"
  [ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
done
grep -Fq 'could not resolve the existing application image' "$test_dir/image-error.err"
grep -Fq 'could not resolve exactly one application image' "$test_dir/image-multiple.err"

if FAKE_DATA_VOLUME=1 FAKE_IMAGE_INSPECT=error PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/image-unavailable.out" 2>"$test_dir/image-unavailable.err"; then
  printf '%s\n' 'installer accepted an unavailable application image' >&2
  exit 1
fi
! grep -Fq '[3/6]' "$test_dir/image-unavailable.out"
[ "$audit_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
grep -Fq 'application image needed to inspect' "$test_dir/image-unavailable.err"

cp "$test_dir/repo/.env" "$test_dir/complete.env"
grep -v '^PROVIDER_CREDENTIAL_KEY=' "$test_dir/complete.env" > "$test_dir/repo/.env"
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/incomplete.out" 2>"$test_dir/incomplete.err"; then
  printf '%s\n' 'installer accepted an incomplete existing .env' >&2; exit 1
fi
grep -Fq '.env exists but is missing required variable PROVIDER_CREDENTIAL_KEY' "$test_dir/incomplete.err"
cp "$test_dir/complete.env" "$test_dir/repo/.env"

grep -v '^COMPOSE_PROJECT_NAME=' "$test_dir/complete.env" > "$test_dir/repo/.env"
for legacy_mode in normal force; do
  legacy_args=(--yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test)
  [ "$legacy_mode" != force ] || legacy_args+=(--force)
  if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" "${legacy_args[@]}" >"$test_dir/legacy-$legacy_mode.out" 2>"$test_dir/legacy-$legacy_mode.err"; then
    printf 'installer accepted %s use with an unrecorded legacy project identity\n' "$legacy_mode" >&2; exit 1
  fi
  grep -Fq 'existing .env without COMPOSE_PROJECT_NAME has an unrecorded deployment identity' "$test_dir/legacy-$legacy_mode.err"
  grep -Fq 'docs/DEPLOY.md' "$test_dir/legacy-$legacy_mode.err"
done
cp "$test_dir/complete.env" "$test_dir/repo/.env"

printf '%s\n' 'COMPOSE_ENV_FILES=attacker.env' >> "$test_dir/repo/.env"
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/env-compose-control.out" 2>"$test_dir/env-compose-control.err"; then
  printf '%s\n' 'installer accepted an unsupported COMPOSE_ control from .env' >&2; exit 1
fi
grep -Fq 'contains a noncanonical or unsupported COMPOSE_ control' "$test_dir/env-compose-control.err"
cp "$test_dir/complete.env" "$test_dir/repo/.env"

for compose_syntax in colon spaced export; do
  cp "$test_dir/complete.env" "$test_dir/repo/.env"
  case "$compose_syntax" in
    colon) printf '%s\n' 'COMPOSE_FILE: ../attacker.yml' >> "$test_dir/repo/.env" ;;
    spaced) printf '%s\n' ' COMPOSE_ENV_FILES = attacker.env' >> "$test_dir/repo/.env" ;;
    export) printf '%s\n' 'export COMPOSE_DISABLE_ENV_FILE=1' >> "$test_dir/repo/.env" ;;
  esac
  if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/compose-syntax-$compose_syntax.out" 2>"$test_dir/compose-syntax-$compose_syntax.err"; then
    printf 'installer accepted Compose dotenv syntax variant %s\n' "$compose_syntax" >&2; exit 1
  fi
  grep -Fq 'contains a noncanonical or unsupported COMPOSE_ control' "$test_dir/compose-syntax-$compose_syntax.err"
done
cp "$test_dir/complete.env" "$test_dir/repo/.env"

FAKE_DNS_EMPTY=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain pending.example.test --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/dns.out" 2>"$test_dir/dns.err"
grep -Fq 'WARNING: DNS does not resolve pending.example.test yet; Caddy will keep retrying certificate issuance once the record exists' "$test_dir/dns.err"
grep -q '^Installation complete$' "$test_dir/dns.out" || grep -q '^\[6/6\] Installation complete$' "$test_dir/dns.out"
cp "$test_dir/complete.env" "$test_dir/repo/.env"

mkdir -p "$test_dir/repo/data"
: > "$test_dir/repo/data/app.db"
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/protected.out" 2>"$test_dir/protected.err"; then
  printf '%s\n' 'installer continued with deployment data present' >&2; exit 1
fi
grep -Fq 'installer retry is limited to interrupted installs before data exists' "$test_dir/protected.err"
grep -Fq 'docs/DEPLOY.md' "$test_dir/protected.err"

force_key_before=$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")
if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/force-db.out" 2>"$test_dir/force-db.err"; then
  printf '%s\n' 'installer accepted --force over repository deployment data' >&2; exit 1
fi
grep -Fq -- '--force: repository data/app.db exists' "$test_dir/force-db.err"
grep -Fq 'refusing to rotate deployment secrets over existing data' "$test_dir/force-db.err"
[ "$force_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
! grep -Fq '[3/6]' "$test_dir/force-db.out"
rm "$test_dir/repo/data/app.db"
rmdir "$test_dir/repo/data"

if FAKE_DATA_VOLUME=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/force-volume.out" 2>"$test_dir/force-volume.err"; then
  printf '%s\n' 'installer accepted --force with an existing Compose data volume' >&2; exit 1
fi
grep -Fq -- '--force: the current Compose project already has a data volume' "$test_dir/force-volume.err"
grep -Fq 'refusing to rotate deployment secrets over existing data' "$test_dir/force-volume.err"
[ "$force_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
! grep -Fq '[3/6]' "$test_dir/force-volume.out"

if FAKE_DATA_VOLUME=error PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/force-discovery.out" 2>"$test_dir/force-discovery.err"; then
  printf '%s\n' 'installer accepted --force when volume discovery failed' >&2; exit 1
fi
grep -Fq -- '--force: could not determine whether the Compose data volume exists' "$test_dir/force-discovery.err"
[ "$force_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
! grep -Fq '[3/6]' "$test_dir/force-discovery.out"

cp "$test_dir/repo/.env" "$test_dir/default-project.env"
sed 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=custom-project/' "$test_dir/default-project.env" > "$test_dir/repo/.env"
custom_key_before=$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")
if FAKE_DATA_VOLUME=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/custom-project.out" 2>"$test_dir/custom-project.err"; then
  printf '%s\n' 'installer missed the data volume named by COMPOSE_PROJECT_NAME in .env' >&2; exit 1
fi
grep -Fq -- '--force: the current Compose project already has a data volume' "$test_dir/custom-project.err"
[ "$custom_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
if COMPOSE_PROJECT_NAME=different-project PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test >"$test_dir/project-conflict.out" 2>"$test_dir/project-conflict.err"; then
  printf '%s\n' 'installer accepted a project-name override that conflicts with .env' >&2; exit 1
fi
grep -Fq 'conflicts with the deployment identity recorded in .env' "$test_dir/project-conflict.err"
[ "$custom_key_before" = "$(grep '^AUDIT_KEY=' "$test_dir/repo/.env")" ]
cp "$test_dir/default-project.env" "$test_dir/repo/.env"

FAKE_EXISTING=1 PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" --yes --force --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test > "$test_dir/existing.out"
grep -q '^Workspace already exists: test-workspace$' "$test_dir/existing.out"
grep -q 'existing administrator credentials were left unchanged' "$test_dir/existing.out"

for conversion_mode in normal force; do
  conversion_args=(--yes --cloudflare-tunnel --domain localhost --email acme@example.test --workspace-name 'Test Workspace' --admin-email admin@example.test)
  [ "$conversion_mode" != force ] || conversion_args+=(--force)
  if PATH="$test_dir/bin:$PATH" "$test_dir/repo/install.sh" "${conversion_args[@]}" >"$test_dir/conversion-$conversion_mode.out" 2>"$test_dir/conversion-$conversion_mode.err"; then
    printf 'installer accepted in-place standard-to-Tunnel conversion in %s mode\n' "$conversion_mode" >&2
    exit 1
  fi
  grep -Fq 'an existing standard .env cannot be converted in place to Cloudflare Tunnel mode' "$test_dir/conversion-$conversion_mode.err"
  grep -Fq 'do not use --force' "$test_dir/conversion-$conversion_mode.err"
  grep -Fq 'docs/DEPLOY.md' "$test_dir/conversion-$conversion_mode.err"
  ! grep -Fq '[1/6]' "$test_dir/conversion-$conversion_mode.out"
done

# The Tunnel mode is a separately persisted deployment boundary. Exercise it from outside the
# checkout so relative COMPOSE_FILE handling cannot accidentally depend on the caller's cwd.
mkdir -p "$test_dir/tunnel-repo/server/src/scripts" "$test_dir/tunnel-repo/server/src/lib/migrations" "$test_dir/tunnel-repo/infra"
cp "$repo_dir/install.sh" "$test_dir/tunnel-repo/install.sh"
cp "$repo_dir/VERSION" "$test_dir/tunnel-repo/VERSION"
cp "$repo_dir/docker-compose.cloudflare-tunnel.yml" "$test_dir/tunnel-repo/docker-compose.cloudflare-tunnel.yml"
cp "$repo_dir/infra/Caddyfile.cloudflare-tunnel" "$test_dir/tunnel-repo/infra/Caddyfile.cloudflare-tunnel"
: > "$test_dir/tunnel-repo/server/src/scripts/bootstrap.ts"
: > "$test_dir/tunnel-repo/server/src/lib/migrations/001_test.ts"

(cd "$test_dir" && ASSERT_TUNNEL_COMPOSE=1 PATH="$test_dir/bin:$PATH" "$test_dir/tunnel-repo/install.sh" \
  --yes --cloudflare-tunnel --domain localhost --email acme@example.test \
  --workspace-name 'Test Workspace' --admin-email admin@example.test > "$test_dir/tunnel.out")
grep -Fxq 'COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml' "$test_dir/tunnel-repo/.env"
[ "$(grep -c '^COMPOSE_FILE=' "$test_dir/tunnel-repo/.env")" -eq 1 ]
[ "$(stat -c '%a' "$test_dir/tunnel-repo/.env")" = 600 ]
grep -Fq 'no host 80/443 port is published' "$test_dir/tunnel.out"

# A normal retry, with no mode flag and no COMPOSE_FILE in the caller, must recover the persisted
# overlay rather than reverting to the public base Compose file.
(cd "$test_dir" && ASSERT_TUNNEL_COMPOSE=1 PATH="$test_dir/bin:$PATH" "$test_dir/tunnel-repo/install.sh" \
  --yes --domain localhost --email acme@example.test --workspace-name 'Test Workspace' \
  --admin-email admin@example.test > "$test_dir/tunnel-rerun.out")
grep -Fq 'existing secrets were kept' "$test_dir/tunnel-rerun.out"

for case_name in old-engine old-compose bound-origin unsafe-compose; do
  case "$case_name" in
    old-engine) case_env=(FAKE_ENGINE_VERSION=27.5.1); expected='requires Docker Engine 28.0.0 or newer' ;;
    old-compose) case_env=(FAKE_COMPOSE_VERSION=v2.24.3); expected='requires Docker Compose 2.24.4 or newer' ;;
    bound-origin) case_env=(FAKE_BOUND_18080=1); expected='loopback origin port 18080 is already bound' ;;
    unsafe-compose) case_env=(FAKE_TUNNEL_CONFIG=unsafe); expected='merged Compose must publish only Caddy TCP 80 as 127.0.0.1:18080' ;;
  esac
  if (cd "$test_dir" && env "${case_env[@]}" ASSERT_TUNNEL_COMPOSE=1 PATH="$test_dir/bin:$PATH" \
    "$test_dir/tunnel-repo/install.sh" --yes --domain localhost --email acme@example.test \
    --workspace-name 'Test Workspace' --admin-email admin@example.test \
    > "$test_dir/$case_name.out" 2> "$test_dir/$case_name.err"); then
    printf 'Tunnel installer accepted unsafe case: %s\n' "$case_name" >&2
    exit 1
  fi
  grep -Fq "$expected" "$test_dir/$case_name.err"
  ! grep -Fq '[3/6]' "$test_dir/$case_name.out"
done

if (cd "$test_dir" && COMPOSE_FILE=attacker.yml PATH="$test_dir/bin:$PATH" \
  "$test_dir/tunnel-repo/install.sh" --yes --domain localhost --email acme@example.test \
  --workspace-name 'Test Workspace' --admin-email admin@example.test \
  > "$test_dir/arbitrary-compose.out" 2> "$test_dir/arbitrary-compose.err"); then
  printf '%s\n' 'Tunnel installer accepted an arbitrary COMPOSE_FILE' >&2
  exit 1
fi
grep -Fq 'may not select arbitrary files' "$test_dir/arbitrary-compose.err"
printf '%s\n' 'install shim test: PASS'
