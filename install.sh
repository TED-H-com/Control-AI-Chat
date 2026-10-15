#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
domain=
acme_email=
workspace_name=
admin_email=
assume_yes=0
dry_run=0
force=0
cloudflare_tunnel_requested=0
cloudflare_tunnel=0
cloudflare_compose_files='docker-compose.yml:docker-compose.cloudflare-tunnel.yml'
cloudflare_origin_port=18080
env_file=$repo_dir/.env
env_tmp=

usage() {
  printf '%s\n' 'Usage: ./install.sh [--domain DOMAIN] [--email EMAIL] [--workspace-name NAME] [--admin-email EMAIL] [--cloudflare-tunnel] [--yes] [--dry-run] [--force]'
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
missing() { printf 'ERROR: missing required option: %s\n' "$1" >&2; exit 2; }
step() { printf '[%s] %s\n' "$1" "$2"; }
warning() { printf 'WARNING: %s\n' "$*" >&2; }
cleanup_temp_env() {
  if [ -n "$env_tmp" ]; then
    case "$env_tmp" in "$repo_dir"/.env.tmp.*) rm -f -- "$env_tmp" ;; esac
  fi
}
trap cleanup_temp_env EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain|--email|--workspace-name|--admin-email)
      [ "$#" -ge 2 ] || missing "$1"
      case "$1" in
        --domain) domain=$2 ;;
        --email) acme_email=$2 ;;
        --workspace-name) workspace_name=$2 ;;
        --admin-email) admin_email=$2 ;;
      esac
      shift 2
      ;;
    --cloudflare-tunnel) cloudflare_tunnel_requested=1; shift ;;
    --yes) assume_yes=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

collect() {
  local variable=$1 flag=$2 prompt=$3 value
  eval "value=\${$variable}"
  if [ -z "$value" ]; then
    [ "$assume_yes" -eq 0 ] || missing "$flag"
    [ -t 0 ] || missing "$flag"
    read -r -p "$prompt: " value
    [ -n "$value" ] || missing "$flag"
    printf -v "$variable" '%s' "$value"
  fi
}

collect domain --domain 'Application domain'
collect acme_email --email 'ACME email'
collect workspace_name --workspace-name 'Workspace name'
collect admin_email --admin-email 'Admin email'

validate_single_line() {
  local flag=$1 value=$2
  case "$value" in
    *$'\n'*|*$'\r'*) die "$flag must be a single line" ;;
  esac
}

validate_email() {
  local flag=$1 value=$2
  validate_single_line "$flag" "$value"
  # These values are written to Compose's .env syntax (ACME) or passed to bootstrap (admin).
  # A deliberately conservative operational-address subset avoids interpolation and quoting
  # semantics while covering normal mailbox, plus-tag, and subdomain addresses.
  [ "${#value}" -le 254 ] && [[ "$value" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] ||
    die "$flag must be a valid email address using ASCII mailbox and domain characters"
}

validate_domain() {
  local label
  validate_single_line --domain "$domain"
  [ "${#domain}" -le 253 ] || die '--domain must be at most 253 characters'
  [[ "$domain" != *[A-Z]* ]] ||
    die '--domain must use lowercase ASCII because browsers normalize Origin hostnames to lowercase'
  if [ "$domain" != localhost ]; then
    [[ "$domain" == *.* ]] || die '--domain must be a fully qualified domain name (or localhost for a local dry run)'
  fi
  [[ "$domain" != .* && "$domain" != *. && "$domain" != *..* ]] ||
    die '--domain contains an empty DNS label'
  IFS=. read -r -a domain_labels <<< "$domain"
  for label in "${domain_labels[@]}"; do
    [ "${#label}" -le 63 ] && [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] ||
      die "--domain contains an invalid DNS label: $label"
  done
}

validate_domain
validate_email --email "$acme_email"
validate_email --admin-email "$admin_email"
validate_single_line --workspace-name "$workspace_name"
[ "${#workspace_name}" -le 120 ] || die '--workspace-name must be at most 120 characters'
[[ "$workspace_name" != *[[:cntrl:]]* ]] || die '--workspace-name must not contain control characters'

# COMPOSE_FILE is executable deployment configuration, not a general user-supplied path. The
# installer accepts exactly one tracked overlay and records it in .env on first install. That makes
# every later safe-wrapper operation and an installer retry resolve the same loopback-only
# model instead of silently falling back to the public 80/443 base file.
requested_compose_file=${COMPOSE_FILE-}
unset COMPOSE_FILE
requested_compose_project=${COMPOSE_PROJECT_NAME-}
caller_compose_variables=()
while IFS= read -r variable; do
  case "$variable" in
    COMPOSE_FILE|COMPOSE_PROJECT_NAME) ;;
    COMPOSE_*) caller_compose_variables+=("$variable") ;;
  esac
done < <(compgen -e)
if [ "${#caller_compose_variables[@]}" -ne 0 ]; then
  printf 'ERROR: unset unsupported caller Compose variables before installation:' >&2
  printf ' %s' "${caller_compose_variables[@]}" >&2
  printf '\n' >&2
  exit 1
fi
# Compose interpolation gives the caller's exported environment precedence over the deployment
# .env. Remove every deployment value that this installer owns so the validated/written file is
# the only source of runtime configuration. Keep Docker connection variables intact.
unset COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES
unset APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET AUDIT_KEY PROVIDER_CREDENTIAL_KEY
unset PROVIDER_CREDENTIAL_PREVIOUS_KEYS PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET
unset RETENTION_ENFORCEMENT_ENABLED NODE_ENV APP_VERSION VCS_REF
compose_marker=
compose_marker_count=0
compose_project_marker=
compose_project_marker_count=0
[ ! -L "$env_file" ] || die '.env must be a regular file, not a symbolic link'
[ ! -e "$env_file" ] || [ -f "$env_file" ] || die '.env must be a regular file'
if [ -e "$env_file" ]; then
  [ -r "$env_file" ] || die '.env exists but is not readable'
  compose_controls=$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_[A-Z0-9_]+[[:space:]]*[:=]' "$env_file" || true)
  noncanonical_compose_controls=$(printf '%s\n' "$compose_controls" |
    grep -Ev "^(COMPOSE_FILE=$cloudflare_compose_files|COMPOSE_PROJECT_NAME=[a-z0-9][a-z0-9_-]*)$" || true)
  [ -z "$noncanonical_compose_controls" ] ||
    die '.env contains a noncanonical or unsupported COMPOSE_ control; only exact KEY=value lines for COMPOSE_FILE and COMPOSE_PROJECT_NAME are accepted'
  compose_marker_count=$(grep -c '^COMPOSE_FILE=' "$env_file" || true)
  [ "$compose_marker_count" -le 1 ] || die '.env contains more than one COMPOSE_FILE entry; refusing ambiguous deployment configuration'
  if [ "$compose_marker_count" -eq 1 ]; then
    compose_marker=$(grep '^COMPOSE_FILE=' "$env_file")
    compose_marker=${compose_marker#COMPOSE_FILE=}
    [ "$compose_marker" = "$cloudflare_compose_files" ] ||
      die '.env contains an unsupported COMPOSE_FILE value; only the tracked Cloudflare Tunnel overlay is accepted'
  fi
  compose_project_marker_count=$(grep -c '^COMPOSE_PROJECT_NAME=' "$env_file" || true)
  [ "$compose_project_marker_count" -le 1 ] || die '.env contains more than one COMPOSE_PROJECT_NAME entry; refusing ambiguous deployment identity'
  if [ "$compose_project_marker_count" -eq 1 ]; then
    compose_project_marker=$(grep '^COMPOSE_PROJECT_NAME=' "$env_file")
    compose_project_marker=${compose_project_marker#COMPOSE_PROJECT_NAME=}
    [ -n "$compose_project_marker" ] || die '.env contains an empty COMPOSE_PROJECT_NAME; refusing ambiguous deployment identity'
  fi
fi
[ -z "$requested_compose_file" ] || [ "$requested_compose_file" = "$cloudflare_compose_files" ] ||
  die 'the COMPOSE_FILE environment variable may not select arbitrary files; use --cloudflare-tunnel for the tracked overlay'

default_compose_project=$(basename "$repo_dir" | tr '[:upper:]' '[:lower:]' | sed 's/^[^a-z0-9]*//; s/[^a-z0-9_-]//g')
[ -n "$default_compose_project" ] || die 'the deployment directory does not produce a valid default Compose project name'
if [ -n "$compose_project_marker" ]; then
  [ -z "$requested_compose_project" ] || [ "$requested_compose_project" = "$compose_project_marker" ] ||
    die 'COMPOSE_PROJECT_NAME in the environment conflicts with the deployment identity recorded in .env'
  compose_project=$compose_project_marker
elif [ -e "$env_file" ]; then
  die 'an existing .env without COMPOSE_PROJECT_NAME has an unrecorded deployment identity; identify the exact existing Compose project, take its matching backup, and record that identity as documented in docs/DEPLOY.md before installing or verifying'
else
  compose_project=${requested_compose_project:-$default_compose_project}
fi
validate_single_line COMPOSE_PROJECT_NAME "$compose_project"
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
  die 'COMPOSE_PROJECT_NAME must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, and underscores'
export COMPOSE_PROJECT_NAME=$compose_project

if [ "$compose_marker" = "$cloudflare_compose_files" ]; then
  cloudflare_tunnel=1
elif [ "$cloudflare_tunnel_requested" -eq 1 ]; then
  if [ -e "$env_file" ]; then
    die 'an existing standard .env cannot be converted in place to Cloudflare Tunnel mode; preserve its matching .env and data, do not use --force, and follow the ingress migration procedure in docs/DEPLOY.md'
  fi
  cloudflare_tunnel=1
elif [ -n "$requested_compose_file" ]; then
  die 'COMPOSE_FILE cannot enable the overlay by itself; pass --cloudflare-tunnel so the choice is persisted safely'
fi

if [ "$cloudflare_tunnel" -eq 1 ]; then
  export COMPOSE_FILE=$cloudflare_compose_files
else
  # Pin the base file for every installer-owned Compose command. Later operator commands still use
  # Compose's normal default, but this run cannot be redirected by dotenv control syntax.
  export COMPOSE_FILE=docker-compose.yml
fi
cd "$repo_dir"

if [ "$dry_run" -eq 1 ]; then
  if [ "$cloudflare_tunnel" -eq 1 ]; then
    step '1/6' "Would preflight Linux, Docker Compose 2.24.4+, loopback origin port $cloudflare_origin_port, disk space, OpenSSL, synchronized time, and DNS for $domain"
  else
    step '1/6' "Would preflight Linux, Docker, TCP ports 80/443, UDP port 443, disk space, OpenSSL, synchronized time, and DNS for $domain"
  fi
  if [ "$force" -eq 1 ]; then
    step '2/6' "Would overwrite .env with mode 600, fixed COMPOSE_PROJECT_NAME=$compose_project, and fresh secrets only if no project data volume or repository database exists (--force)"
  elif [ "$cloudflare_tunnel" -eq 1 ]; then
    step '2/6' "Would write a mode-600 .env with fresh secrets, fixed COMPOSE_PROJECT_NAME=$compose_project, and fixed COMPOSE_FILE=$cloudflare_compose_files"
  else
    step '2/6' "Would write a mode-600 .env with fresh secrets and fixed COMPOSE_PROJECT_NAME=$compose_project"
  fi
  if [ "$cloudflare_tunnel" -eq 1 ]; then
    step '3/6' "Would validate the merged loopback-only Compose model, build the image, and start Compose"
  else
    step '3/6' 'Would build the image and start Compose'
  fi
  step '4/6' 'Would wait up to 180 seconds, require full readiness, and compare source/applied migrations'
  step '5/6' "Would bootstrap workspace '$workspace_name' and admin $admin_email"
  step '6/6' "Would print https://$domain/login and operator notes"
  exit 0
fi

step '1/6' 'Preflight checks'
[ "$(uname -s)" = Linux ] || die 'preflight: Linux is required'
architecture=$(uname -m) || die 'preflight: could not determine the host architecture'
case "$architecture" in
  x86_64|aarch64|arm64) ;;
  *) die "preflight: unsupported architecture $architecture; x86_64, aarch64, or arm64 is required" ;;
esac
command -v docker >/dev/null 2>&1 || die 'preflight: docker is not installed'
if ! docker_info_error=$(docker info 2>&1 >/dev/null); then
  if printf '%s\n' "$docker_info_error" | grep -qi 'permission denied' ||
     { command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet docker; }; then
    die 'preflight: Docker is running, but this user cannot access it; add the user to the docker group and start a new login shell, or re-run the installer under sudo'
  fi
  die 'preflight: the Docker daemon is not reachable'
fi
docker compose version >/dev/null 2>&1 || die 'preflight: the Docker Compose plugin is not available'
command -v openssl >/dev/null 2>&1 || die 'preflight: openssl is not installed'

require_clean_git_source() {
  local source_status
  [ ! -e "$repo_dir/.git" ] || command -v git >/dev/null 2>&1 ||
    die 'preflight: git is required to verify this deployment checkout'
  if [ -e "$repo_dir/.git" ]; then
    source_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null) ||
      die 'preflight: could not inspect the deployment checkout state'
    [ -z "$source_status" ] ||
      die 'preflight: the Git deployment checkout has tracked or untracked changes; build only an exact reviewed commit or use its history-free source archive'
  fi
}
require_clean_git_source

compose_version_at_least_2_24_4() {
  local value=${1#v} major minor patch
  value=${value%%-*}
  IFS=. read -r major minor patch <<< "$value"
  [[ ${major:-} =~ ^[0-9]+$ && ${minor:-} =~ ^[0-9]+$ && ${patch:-} =~ ^[0-9]+$ ]] || return 1
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && { [ "$minor" -gt 24 ] || { [ "$minor" -eq 24 ] && [ "$patch" -ge 4 ]; }; }; }
}

validate_cloudflare_compose() {
  [ "$COMPOSE_FILE" = "$cloudflare_compose_files" ] ||
    die 'preflight: Cloudflare Tunnel mode lost its fixed COMPOSE_FILE boundary'
  [ -f "$repo_dir/docker-compose.cloudflare-tunnel.yml" ] ||
    die 'preflight: docker-compose.cloudflare-tunnel.yml is missing'
  [ -f "$repo_dir/infra/Caddyfile.cloudflare-tunnel" ] ||
    die 'preflight: infra/Caddyfile.cloudflare-tunnel is missing'
  command -v python3 >/dev/null 2>&1 ||
    die 'preflight: --cloudflare-tunnel requires python3 to verify the merged Compose security boundary'
  if ! docker compose config --no-env-resolution --no-interpolate --no-path-resolution --format json | python3 -c '
import json, os, sys
try:
    model = json.load(sys.stdin)
    services = model["services"]
    project = os.environ["COMPOSE_PROJECT_NAME"]
    network = model["networks"]["internal"]
    private_network = (model.get("name") == project and set(services) == {"app", "caddy"}
                       and set(model["networks"]) == {"internal"}
                       and network.get("name") == project + "_internal"
                       and not network.get("external", False)
                       and not network.get("internal", False)
                       and network.get("driver") in (None, "bridge")
                       and not services["app"].get("network_mode")
                       and not services["caddy"].get("network_mode")
                       and set(services["app"].get("networks", {})) == {"internal"}
                       and set(services["caddy"].get("networks", {})) == {"internal"})
    publishers = [name for name, service in services.items() if service.get("ports")]
    ports = services["caddy"].get("ports")
    expected = [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 80,
                 "published": "18080", "protocol": "tcp"}]
    volumes = services["caddy"].get("volumes", [])
    caddyfiles = [item for item in volumes if item.get("target") == "/etc/caddy/Caddyfile"]
    safe = (private_network and publishers == ["caddy"] and ports == expected and len(caddyfiles) == 1
            and caddyfiles[0].get("read_only") is True
            and caddyfiles[0].get("source") == "./infra/Caddyfile.cloudflare-tunnel")
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    safe = False
raise SystemExit(0 if safe else 1)
'; then
    die 'preflight: merged Compose must publish only Caddy TCP 80 as 127.0.0.1:18080 with the tracked Tunnel Caddyfile read-only'
  fi
}

if [ "$cloudflare_tunnel" -eq 1 ]; then
  docker_engine_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    die 'preflight: could not determine the Docker Engine server version required for safe loopback publishing'
  docker_engine_major=${docker_engine_version#v}
  docker_engine_major=${docker_engine_major%%.*}
  [[ "$docker_engine_major" =~ ^[0-9]+$ ]] && [ "$docker_engine_major" -ge 28 ] ||
    die 'preflight: --cloudflare-tunnel requires Docker Engine 28.0.0 or newer so a localhost-published port is not reachable from the same L2 network'
  compose_version=$(docker compose version --short 2>/dev/null) ||
    die 'preflight: could not determine the Docker Compose version required by the Tunnel overlay'
  compose_version_at_least_2_24_4 "$compose_version" ||
    die 'preflight: --cloudflare-tunnel requires Docker Compose 2.24.4 or newer for !override'
  validate_cloudflare_compose
fi

bound_tcp_ports=
bound_udp_ports=
if command -v ss >/dev/null 2>&1; then
  ss_tcp_output=$(ss -tln 2>/dev/null) || die 'preflight: could not inspect listening TCP ports with ss'
  if [ "$cloudflare_tunnel" -eq 1 ]; then
    bound_tcp_ports=$(printf '%s\n' "$ss_tcp_output" | awk 'NR > 1 { endpoint=$4; sub(/^.*:/,"",endpoint); if (endpoint == "18080") print }')
  else
    bound_tcp_ports=$(printf '%s\n' "$ss_tcp_output" | awk 'NR > 1 { endpoint=$4; sub(/^.*:/,"",endpoint); if (endpoint == "80" || endpoint == "443") print }')
    ss_udp_output=$(ss -uln 2>/dev/null) || die 'preflight: could not inspect listening UDP ports with ss'
    bound_udp_ports=$(printf '%s\n' "$ss_udp_output" | awk 'NR > 1 { endpoint=$4; sub(/^.*:/,"",endpoint); if (endpoint == "443") print }')
  fi
elif [ -r /proc/net/tcp ]; then
  tcp_tables=/proc/net/tcp
  [ ! -r /proc/net/tcp6 ] || tcp_tables="$tcp_tables /proc/net/tcp6"
  if [ "$cloudflare_tunnel" -eq 1 ]; then
    bound_tcp_ports=$(awk 'NR > 1 && $4 == "0A" { split($2,a,":"); if (a[2] == "46A0") print $0 }' $tcp_tables)
  else
    bound_tcp_ports=$(awk 'NR > 1 && $4 == "0A" { split($2,a,":"); if (a[2] == "0050" || a[2] == "01BB") print $0 }' $tcp_tables)
    [ -r /proc/net/udp ] || die 'preflight: cannot check UDP port 443 (/proc/net/udp unavailable)'
    udp_tables=/proc/net/udp
    [ ! -r /proc/net/udp6 ] || udp_tables="$udp_tables /proc/net/udp6"
    bound_udp_ports=$(awk 'NR > 1 { split($2,a,":"); if (a[2] == "01BB") print $0 }' $udp_tables)
  fi
else
  if [ "$cloudflare_tunnel" -eq 1 ]; then
    die "preflight: cannot check loopback origin port $cloudflare_origin_port (ss and /proc/net/tcp unavailable)"
  else
    die 'preflight: cannot check TCP ports 80/443 and UDP port 443 (ss and /proc/net/tcp unavailable)'
  fi
fi
if [ "$cloudflare_tunnel" -eq 1 ]; then
  [ -z "$bound_tcp_ports" ] || die "preflight: loopback origin port $cloudflare_origin_port is already bound:"$'\n'"$bound_tcp_ports"
else
  [ -z "$bound_tcp_ports" ] || die "preflight: TCP port 80 or 443 is already bound:"$'\n'"$bound_tcp_ports"
  [ -z "$bound_udp_ports" ] || die "preflight: UDP port 443 is already bound:"$'\n'"$bound_udp_ports"
fi

filesystem_space() {
  local path=$1 output
  output=$(LC_ALL=C df -Pk "$path" 2>/dev/null) || return 1
  printf '%s\n' "$output" | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print $1 "|" $4 }'
}

repo_space=$(filesystem_space "$repo_dir")
[ -n "$repo_space" ] || die 'preflight: could not determine free disk space on the repository filesystem'
repo_filesystem=${repo_space%%|*}
repo_available_kb=${repo_space#*|}
[ "$repo_available_kb" -ge 10485760 ] || die 'preflight: at least 10 GiB free is required on the repository filesystem'

docker_root_dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) ||
  die 'preflight: could not determine DockerRootDir for the image-build disk-space check'
[ -n "$docker_root_dir" ] || die 'preflight: DockerRootDir is empty; cannot verify image-build disk space'
if docker_space=$(filesystem_space "$docker_root_dir") && [ -n "$docker_space" ]; then
  docker_filesystem=${docker_space%%|*}
  docker_available_kb=${docker_space#*|}
  if [ "$docker_available_kb" -lt 10485760 ]; then
    if [ "$docker_filesystem" = "$repo_filesystem" ]; then
      die 'preflight: at least 10 GiB free is required at DockerRootDir on the shared repository filesystem for the image build'
    fi
    die 'preflight: at least 10 GiB free is required on the distinct DockerRootDir filesystem for the image build'
  fi
elif [ -r "$docker_root_dir" ]; then
  die 'preflight: DockerRootDir is readable but its free disk space could not be determined'
else
  die "preflight: DockerRootDir $docker_root_dir is not readable; its free disk space cannot be verified"
fi

if command -v timedatectl >/dev/null 2>&1; then
  time_synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null) ||
    die 'preflight: timedatectl could not determine whether host time is synchronized'
  [ "$time_synchronized" = yes ] || die 'preflight: host time is not synchronized; TLS, identity, sessions, and audit timestamps require synchronized time'
elif command -v chronyc >/dev/null 2>&1; then
  chronyc tracking 2>/dev/null | grep -Eq '^Leap status[[:space:]]*:[[:space:]]*Normal$' ||
    die 'preflight: chrony does not report synchronized host time'
else
  die 'preflight: cannot verify synchronized host time; install/configure systemd-timesyncd or chrony before deployment'
fi

resolved=$(getent hosts "$domain" 2>/dev/null | awk '{ print $1 }' | sort -u || true)
if [ "$cloudflare_tunnel" -eq 1 ]; then
  [ -n "$resolved" ] || warning "DNS does not resolve $domain yet; create the dedicated Cloudflare Tunnel DNS route before public verification"
else
  [ -n "$resolved" ] || warning "DNS does not resolve $domain yet; Caddy will keep retrying certificate issuance once the record exists"
  if [ -n "$resolved" ]; then
    printf 'DNS for %s resolves to:\n%s\n' "$domain" "$resolved"
    printf '%s\n' 'Confirm these addresses point to this machine before continuing with public verification.'
  fi
fi

step '2/6' 'Generate and protect deployment secrets'
# A caller may invoke this installer through `bash -x`. Keep tracing disabled for every path that
# can create, retain, or print deployment secrets and the one-time bootstrap password.
set +x
discover_compose_data_volumes() {
  local context=$1 labeled_volumes all_volumes exact_volume expected_volume
  if ! labeled_volumes=$(docker volume ls --quiet \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter 'label=com.docker.compose.volume=data'); then
    die "$context: could not determine whether the Compose data volume exists; refusing to continue"
  fi
  if ! all_volumes=$(docker volume ls --quiet); then
    die "$context: could not inspect exact Docker volume names; refusing to continue"
  fi
  # Compose can adopt an already-existing name even when it has no Compose labels. Include the
  # exact implicit name so a stale/manual volume can never be mounted under freshly generated keys.
  expected_volume=${compose_project}_data
  exact_volume=$(printf '%s\n' "$all_volumes" | awk -v expected="$expected_volume" '$0 == expected { print }')
  compose_data_volumes=$(printf '%s\n%s\n' "$labeled_volumes" "$exact_volume" |
    awk 'NF && !seen[$0]++ { print }')
  compose_data_volume_count=$(printf '%s\n' "$compose_data_volumes" | awk 'NF { count++ } END { print count + 0 }')
}

# Every path that creates fresh audit and provider-encryption keys is a clean-install path.
# Even an empty-looking Compose data volume may belong to an interrupted install, so neither a
# first run nor --force rotates secrets while any matching volume or repository DB exists.
if [ ! -e "$env_file" ] || [ "$force" -eq 1 ]; then
  secret_context='fresh install'
  [ "$force" -ne 1 ] || secret_context=--force
  [ ! -e "$repo_dir/data/app.db" ] ||
    die "$secret_context: repository data/app.db exists; refusing to rotate deployment secrets over existing data; preserve the matching .env and follow docs/DEPLOY.md"
  discover_compose_data_volumes "$secret_context"
  [ "$compose_data_volume_count" -eq 0 ] ||
    die "$secret_context: the current Compose project already has a data volume; refusing to rotate deployment secrets over existing data; preserve the matching .env and follow docs/DEPLOY.md"
fi

if [ -e "$env_file" ] && [ "$force" -ne 1 ]; then
  for required_variable in APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET AUDIT_KEY PROVIDER_CREDENTIAL_KEY PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET NODE_ENV; do
    grep -Eq "^${required_variable}=.+" "$env_file" || die ".env exists but is missing required variable $required_variable"
  done
  [ "$(grep '^APP_DOMAIN=' "$env_file")" = "APP_DOMAIN=$domain" ] ||
    die 'retry: --domain does not exactly match APP_DOMAIN in the existing .env; refusing to start with a different public address'
  [ "$(grep '^APP_ORIGIN=' "$env_file")" = "APP_ORIGIN=https://$domain" ] ||
    die 'retry: --domain does not exactly match APP_ORIGIN in the existing .env; refusing because the printed login URL and CSRF origin would disagree'
  [ "$(grep '^ACME_EMAIL=' "$env_file")" = "ACME_EMAIL=$acme_email" ] ||
    die 'retry: --email does not exactly match ACME_EMAIL in the existing .env; refusing to start with different certificate contact details'
  discover_compose_data_volumes 'retry'
  [ "$compose_data_volume_count" -le 1 ] ||
    die 'retry: more than one Compose data volume matched this project; refusing because the deployment state is ambiguous'
  if [ -e "$repo_dir/data/app.db" ]; then
    die '.env already exists and deployment data is present; installer retry is limited to interrupted installs before data exists; preserve this matching .env and data, then use the operating or upgrade procedure in docs/DEPLOY.md'
  fi
  if [ "$compose_data_volume_count" -eq 1 ]; then
    compose_data_volume=$(printf '%s\n' "$compose_data_volumes" | awk 'NF { print; exit }')
    if ! app_images=$(docker compose config --images app); then
      die 'retry: could not resolve the existing application image used to inspect the Compose data volume; refusing to continue'
    fi
    app_image_count=$(printf '%s\n' "$app_images" | awk 'NF { count++ } END { print count + 0 }')
    [ "$app_image_count" -eq 1 ] ||
      die 'retry: could not resolve exactly one application image to inspect the Compose data volume; refusing to continue'
    app_image=$(printf '%s\n' "$app_images" | awk 'NF { print; exit }')
    docker image inspect "$app_image" >/dev/null 2>&1 ||
      die 'retry: the application image needed to inspect the Compose data volume is unavailable; refusing to continue'
    if ! volume_state=$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --mount "type=volume,source=$compose_data_volume,target=/data,readonly" \
      --entrypoint node "$app_image" -e \
      'const fs=require("node:fs"),allowed=new Set(["uploads"]),names=fs.readdirSync("/data");const empty=names.every(name=>{if(!allowed.has(name))return false;const path="/data/"+name,stat=fs.lstatSync(path);return stat.isDirectory()&&!stat.isSymbolicLink()&&fs.readdirSync(path).length===0});process.stdout.write(empty?"EMPTY":"NONEMPTY")'); then
      die 'retry: could not safely inspect the Compose data volume; refusing to continue with an existing .env'
    fi
    case "$volume_state" in
      EMPTY) printf '%s\n' 'Existing Compose data volume contains no deployment data; it is safe to retry with the existing secrets.' ;;
      NONEMPTY) die '.env already exists and deployment data is present; installer retry is limited to interrupted installs before data exists; preserve this matching .env and data, then use the operating or upgrade procedure in docs/DEPLOY.md' ;;
      *) die 'retry: the Compose data-volume inspection returned an unexpected result; refusing to continue' ;;
    esac
  fi
  chmod 600 "$env_file"
  printf '%s\n' 'Existing .env is complete; existing secrets were kept.'
else
  old_umask=$(umask)
  umask 077
  jwt_secret=$(openssl rand -hex 48) || die 'secrets: could not generate JWT_SECRET'
  audit_key=$(openssl rand -hex 32) || die 'secrets: could not generate AUDIT_KEY'
  provider_key=$(openssl rand -hex 32) || die 'secrets: could not generate PROVIDER_CREDENTIAL_KEY'
  proxy_secret=$(openssl rand -hex 32) || die 'secrets: could not generate PROXY_SHARED_SECRET'
  env_tmp=$(mktemp "$repo_dir/.env.tmp.XXXXXX") || die 'secrets: could not create a protected temporary .env in the deployment directory'
  chmod 600 "$env_tmp"
  {
    printf 'APP_DOMAIN=%s\n' "$domain"
    printf 'APP_ORIGIN=https://%s\n' "$domain"
    printf 'ACME_EMAIL=%s\n' "$acme_email"
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$compose_project"
    if [ "$cloudflare_tunnel" -eq 1 ]; then
      printf 'COMPOSE_FILE=%s\n' "$cloudflare_compose_files"
    fi
    printf 'JWT_SECRET=%s\n' "$jwt_secret"
    printf 'AUDIT_KEY=%s\n' "$audit_key"
    printf 'PROVIDER_CREDENTIAL_KEY=%s\n' "$provider_key"
    printf 'PROXY_SHARED_SECRET=%s\n' "$proxy_secret"
    printf '%s\n' 'PROVIDER_CREDENTIAL_KEY_VERSION=1' 'RETENTION_ENFORCEMENT_ENABLED=true' 'NODE_ENV=production'
  } > "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f -- "$env_tmp" "$env_file"
  env_tmp=
  umask "$old_umask"
fi

step '3/6' 'Build and start the application'
require_clean_git_source
release_version=$(tr -d '[:space:]' < "$repo_dir/VERSION" 2>/dev/null) ||
  die 'build: VERSION is missing from this release source'
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die 'build: VERSION must contain one semantic version'
vcs_ref=v$release_version
if [ -e "$repo_dir/.git" ] && command -v git >/dev/null 2>&1; then
  vcs_ref=$(git -C "$repo_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) ||
    die 'build: this Git checkout does not have a resolvable HEAD commit'
fi
APP_VERSION=$release_version VCS_REF=$vcs_ref docker compose build || die 'build: docker compose build failed'
docker compose up -d --no-build || die 'start: docker compose up failed'

step '4/6' 'Wait for database health and verify readiness'
healthy=0
attempt=0
while [ "$attempt" -lt 180 ]; do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3010/api/health').then(r=>r.json()).then(body=>process.exit(body.db==='ok'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  printf '%s\n' 'ERROR: health: database did not report ok within 180 seconds' >&2
  docker compose logs --tail 50 app >&2 || true
  exit 1
fi
docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:3010/api/v1/health/ready").then(async response=>{const body=await response.json();const checks=new Map((body.checks||[]).map(item=>[item.name,item.ok]));const ok=response.ok&&["schema","integrity","chain"].every(name=>checks.get(name)===true);if(!ok)console.error(JSON.stringify(body));process.exit(ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})' ||
  die 'readiness: schema, SQLite integrity, or audit-chain verification failed'
expected_migrations=$(find "$repo_dir/server/src/lib/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.ts' ! -name '*.test.ts' | wc -l)
applied_migrations=$(docker compose exec -T app node -e \
  "const Database=require('better-sqlite3');const db=new Database(process.env.DB_PATH,{readonly:true});console.log(db.prepare('SELECT COUNT(*) AS count FROM schema_version').get().count);db.close()") ||
  die 'readiness: could not read the applied migration count'
[ "$applied_migrations" -eq "$expected_migrations" ] ||
  die "readiness: source migration count $expected_migrations differs from applied count $applied_migrations"
printf 'Readiness: schema, integrity, audit chain, and %s migrations passed.\n' "$expected_migrations"

step '5/6' 'Bootstrap the first workspace administrator'
bootstrap_output=$(docker compose exec -T -e NPM_CONFIG_UPDATE_NOTIFIER=false app npm run bootstrap -- --workspace-name "$workspace_name" --admin-email "$admin_email") || die 'bootstrap: workspace creation failed'
printf '%s\n' "$bootstrap_output"
if printf '%s\n' "$bootstrap_output" | grep -q '^Workspace already exists:'; then
  printf '%s\n' 'Bootstrap: the workspace already exists; existing administrator credentials were left unchanged.'
else
  printf '%s\n' 'The password above is shown once and is not stored anywhere.'
fi

step '6/6' 'Installation complete'
printf 'Login: https://%s/login\n' "$domain"
printf 'Admin email: %s\n' "$admin_email"
if [ "$cloudflare_tunnel" -eq 1 ]; then
  printf '%s\n' "Ingress: dedicated Cloudflare Tunnel to Caddy at 127.0.0.1:$cloudflare_origin_port; no host 80/443 port is published." \
    'Public TLS terminates at Cloudflare; the encrypted Tunnel ends at the host and Caddy retains the authenticated proxy boundary to the app.' \
    "Compose profile: .env pins COMPOSE_FILE=$cloudflare_compose_files; use scripts/compose.sh for post-install operations."
fi
printf '%s\n' 'Data volume: the Compose data volume named data, mounted at /data in the app container.' \
  'Back up the complete data volume together with the matching complete mode-600 .env; test a restore. See docs/DEPLOY.md.' \
  'AUDIT_KEY is required for audit history; current and previous provider keys are required for stored provider credentials.' \
  'Add model credentials in the console under Providers; no provider key belongs in any file.'
printf 'Verify handoff: scripts/verify-install.sh https://%s %s\n' "$domain" "$admin_email"
