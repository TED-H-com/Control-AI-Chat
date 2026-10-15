#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
env_file=$repo_dir/.env
cloudflare_compose_files='docker-compose.yml:docker-compose.cloudflare-tunnel.yml'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Compose gives exported variables precedence over the deployment .env. Routine operations must
# always use the identity and ingress boundary recorded at installation, never caller state.
caller_compose_variables=()
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) caller_compose_variables+=("$variable") ;; esac
done < <(compgen -e)
if [ "${#caller_compose_variables[@]}" -ne 0 ]; then
  printf 'ERROR: unset caller Compose variables before operating this deployment:' >&2
  printf ' %s' "${caller_compose_variables[@]}" >&2
  printf '\n' >&2
  exit 1
fi

# Remove application settings that Compose could otherwise interpolate ahead of .env. Docker
# connection and proxy variables deliberately remain available for local or remote Docker hosts.
unset APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET AUDIT_KEY PROVIDER_CREDENTIAL_KEY
unset PROVIDER_CREDENTIAL_PREVIOUS_KEYS PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET
unset RETENTION_ENFORCEMENT_ENABLED NODE_ENV APP_VERSION VCS_REF

[ -f "$env_file" ] || die 'the deployment .env is missing'
[ ! -L "$env_file" ] || die '.env must be a regular file, not a symbolic link'
[ "$(stat -c '%a' "$env_file")" = 600 ] || die '.env must have mode 600'

compose_controls=$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_[A-Z0-9_]+[[:space:]]*[:=]' "$env_file" || true)
noncanonical_compose_controls=$(printf '%s\n' "$compose_controls" |
  grep -Ev "^(COMPOSE_FILE=$cloudflare_compose_files|COMPOSE_PROJECT_NAME=[a-z0-9][a-z0-9_-]*)$" || true)
[ -z "$noncanonical_compose_controls" ] ||
  die '.env contains a noncanonical or unsupported COMPOSE_ control'

compose_project_count=$(grep -c '^COMPOSE_PROJECT_NAME=' "$env_file" || true)
[ "$compose_project_count" -eq 1 ] || die '.env must record exactly one COMPOSE_PROJECT_NAME'
compose_project=$(grep '^COMPOSE_PROJECT_NAME=' "$env_file")
compose_project=${compose_project#COMPOSE_PROJECT_NAME=}
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die '.env contains an invalid COMPOSE_PROJECT_NAME'

compose_file_count=$(grep -c '^COMPOSE_FILE=' "$env_file" || true)
[ "$compose_file_count" -le 1 ] || die '.env contains more than one COMPOSE_FILE entry'
if [ "$compose_file_count" -eq 1 ]; then
  [ "$(grep '^COMPOSE_FILE=' "$env_file")" = "COMPOSE_FILE=$cloudflare_compose_files" ] ||
    die '.env selects an unsupported Compose file set'
  export COMPOSE_FILE=$cloudflare_compose_files
else
  export COMPOSE_FILE=docker-compose.yml
fi
export COMPOSE_PROJECT_NAME=$compose_project

if [ -e "$repo_dir/.git" ]; then
  command -v git >/dev/null 2>&1 || die 'git is required to verify this deployment checkout'
  source_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null) ||
    die 'could not inspect the deployment checkout state'
  [ -z "$source_status" ] ||
    die 'the Git deployment checkout has tracked or untracked changes; operate only the exact reviewed release source'
fi

release_version=$(tr -d '[:space:]' < "$repo_dir/VERSION" 2>/dev/null) ||
  die 'VERSION is missing from this release source'
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'VERSION must contain one semantic version'
vcs_ref=v$release_version
if [ -e "$repo_dir/.git" ]; then
  vcs_ref=$(git -C "$repo_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) ||
    die 'this Git checkout does not have a resolvable HEAD commit'
fi
export APP_VERSION=$release_version VCS_REF=$vcs_ref

cd "$repo_dir"
exec docker compose "$@"
