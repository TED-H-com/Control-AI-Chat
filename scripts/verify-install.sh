#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
insecure=0
password_stdin=0

usage() {
  printf '%s\n' \
    'Usage: scripts/verify-install.sh [--insecure] [--password-stdin] <https://base> <admin-email>' \
    '  --insecure        Accept a self-signed certificate on a non-production acceptance host.' \
    '  --password-stdin  Read the one-time password from standard input instead of a hidden prompt.'
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }
cleanup() {
  unset admin_password login_payload 2>/dev/null || true
  if [ -n "${tmp_dir:-}" ]; then
    case "$tmp_dir" in /tmp/gateway-verify.*) rm -rf -- "$tmp_dir" ;; esac
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --insecure) insecure=1; shift ;;
    --password-stdin) password_stdin=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) printf 'ERROR: unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) break ;;
  esac
done

[ "$#" -eq 2 ] || { usage >&2; exit 2; }
base=${1%/}
admin_email=$2
# Docker/Compose commands attach to standard input even with no TTY. Give the complete pre-login
# phase /dev/null as a compound-command input; Bash restores the verifier's original stdin before
# the password read, without exposing an extra inherited descriptor to child processes.
{
caller_compose_variables=()
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) caller_compose_variables+=("$variable") ;; esac
done < <(compgen -e)
if [ "${#caller_compose_variables[@]}" -ne 0 ]; then
  printf 'ERROR: unset caller Compose variables before verification:' >&2
  printf ' %s' "${caller_compose_variables[@]}" >&2
  printf '\n' >&2
  exit 1
fi
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE
unset COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET
unset AUDIT_KEY PROVIDER_CREDENTIAL_KEY PROVIDER_CREDENTIAL_PREVIOUS_KEYS
unset PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET RETENTION_ENFORCEMENT_ENABLED
unset NODE_ENV APP_VERSION VCS_REF
case "$base" in https://*) ;; *) die 'base URL must begin with https://' ;; esac
case "$admin_email" in *@*) ;; *) die 'administrator email is invalid' ;; esac

command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v docker >/dev/null 2>&1 || die 'docker is required'
docker info >/dev/null 2>&1 || die 'the Docker daemon is not reachable'
docker compose version >/dev/null 2>&1 || die 'the Docker Compose plugin is required'
if command -v timedatectl >/dev/null 2>&1; then
  [ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" = yes ] || die 'host time is not synchronized'
elif command -v chronyc >/dev/null 2>&1; then
  chronyc tracking 2>/dev/null | grep -Eq '^Leap status[[:space:]]*:[[:space:]]*Normal$' || die 'host time is not synchronized'
else
  die 'synchronized host time cannot be verified with timedatectl or chronyc'
fi
pass 'host time is synchronized'
[ -f "$repo_dir/.env" ] || die 'run this command from an installed deployment checkout containing .env'
[ ! -L "$repo_dir/.env" ] || die '.env must be a regular file, not a symbolic link'
[ "$(stat -c '%a' "$repo_dir/.env")" = 600 ] || die '.env must have mode 600'
pass '.env is mode 600'
compose_controls=$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_[A-Z0-9_]+[[:space:]]*[:=]' "$repo_dir/.env" || true)
noncanonical_compose_controls=$(printf '%s\n' "$compose_controls" |
  grep -Ev '^(COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml|COMPOSE_PROJECT_NAME=[a-z0-9][a-z0-9_-]*)$' || true)
[ -z "$noncanonical_compose_controls" ] ||
  die '.env contains a noncanonical or unsupported COMPOSE_ control; only exact KEY=value lines for COMPOSE_FILE and COMPOSE_PROJECT_NAME are accepted'
compose_file_count=$(grep -c '^COMPOSE_FILE=' "$repo_dir/.env" || true)
[ "$compose_file_count" -le 1 ] || die '.env contains more than one COMPOSE_FILE entry'
if [ "$compose_file_count" -eq 1 ]; then
  [ "$(grep '^COMPOSE_FILE=' "$repo_dir/.env")" = 'COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml' ] ||
    die '.env selects an unsupported Compose file set'
fi
compose_project_count=$(grep -c '^COMPOSE_PROJECT_NAME=' "$repo_dir/.env" || true)
[ "$compose_project_count" -eq 1 ] || die '.env must record exactly one COMPOSE_PROJECT_NAME before verification'
compose_project=$(grep '^COMPOSE_PROJECT_NAME=' "$repo_dir/.env")
compose_project=${compose_project#COMPOSE_PROJECT_NAME=}
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die '.env contains an invalid COMPOSE_PROJECT_NAME'
export COMPOSE_PROJECT_NAME=$compose_project
if [ "$compose_file_count" -eq 1 ]; then
  export COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml
else
  export COMPOSE_FILE=docker-compose.yml
fi
pass 'Compose identity is recorded in the deployment .env'
origin_count=$(grep -c '^APP_ORIGIN=' "$repo_dir/.env" || true)
[ "$origin_count" -eq 1 ] || die '.env must record exactly one APP_ORIGIN before verification'
recorded_origin=$(grep '^APP_ORIGIN=' "$repo_dir/.env")
recorded_origin=${recorded_origin#APP_ORIGIN=}
[ "$base" = "$recorded_origin" ] || die 'verification URL must exactly match APP_ORIGIN in .env'
pass 'verification URL exactly matches the recorded application origin'

trap cleanup EXIT

smoke_args=()
if [ "$insecure" -eq 1 ]; then smoke_args+=(--insecure); fi
"$repo_dir/scripts/smoke.sh" "${smoke_args[@]}" "$base"

cd "$repo_dir"
expected_migrations=$(find server/src/lib/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.ts' ! -name '*.test.ts' | wc -l)
applied_migrations=$(docker compose exec -T app node -e \
  "const Database=require('better-sqlite3');const db=new Database(process.env.DB_PATH,{readonly:true});console.log(db.prepare('SELECT COUNT(*) AS count FROM schema_version').get().count);db.close()")
[ "$applied_migrations" -eq "$expected_migrations" ] ||
  die "migration count differs: source=$expected_migrations database=$applied_migrations"
pass "all $expected_migrations source migrations are applied"

docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:3010/api/v1/health/ready").then(async response=>{const body=await response.json();const checks=new Map((body.checks||[]).map(item=>[item.name,item.ok]));const ok=response.ok&&["schema","integrity","chain"].every(name=>checks.get(name)===true);if(!ok)console.error(JSON.stringify(body));process.exit(ok?0:1)}).catch(error=>{console.error(error);process.exit(1)})' \
  || die 'internal readiness did not pass schema, integrity, and chain checks'
pass 'internal readiness reports schema, integrity, and chain ok'

compose_json=$(docker compose config --no-env-resolution --no-interpolate --no-path-resolution --format json)
ingress_mode=$(printf '%s' "$compose_json" | docker compose exec -T -e VERIFY_COMPOSE_PROJECT="$compose_project" app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
 const model=JSON.parse(input),services=model.services||{},app=services.app||{},caddy=services.caddy||{},project=process.env.VERIFY_COMPOSE_PROJECT;
 if(model.name!==project||JSON.stringify(Object.keys(services).sort())!==JSON.stringify(["app","caddy"]))throw new Error("Compose project or service set differs from the supported deployment");
 const serviceNetworks=service=>Object.keys(service.networks||{}).sort();
 if(app.network_mode||caddy.network_mode||JSON.stringify(serviceNetworks(app))!==JSON.stringify(["internal"])||JSON.stringify(serviceNetworks(caddy))!==JSON.stringify(["internal"]))throw new Error("services do not use only the private Compose network");
 const networks=model.networks||{},networkKeys=Object.keys(networks).sort(),internal=networks.internal||{};
 if(JSON.stringify(networkKeys)!==JSON.stringify(["internal"])||internal.name!==`${project}_internal`||internal.external===true||internal.internal===true||!([undefined,"bridge"].includes(internal.driver)))throw new Error("private Compose network identity or driver changed");
 if(Array.isArray(app.ports)&&app.ports.length)throw new Error("the app service publishes a host port");
 const publishers=Object.entries(services).filter(([,service])=>Array.isArray(service.ports)&&service.ports.length).map(([name])=>name);
 if(publishers.length!==1||publishers[0]!=="caddy")throw new Error("only Caddy may publish host ports");
 const ports=(caddy.ports||[]).map(port=>({host:port.host_ip||"0.0.0.0",published:String(port.published),target:Number(port.target),protocol:port.protocol||"tcp"}));
 const tunnel=ports.length===1&&ports[0].host==="127.0.0.1"&&ports[0].published==="18080"&&ports[0].target===80&&ports[0].protocol==="tcp";
 const keys=ports.map(port=>`${port.host}:${port.published}:${port.target}:${port.protocol}`).sort();
 const direct=JSON.stringify(keys)===JSON.stringify(["0.0.0.0:443:443:tcp","0.0.0.0:443:443:udp","0.0.0.0:80:80:tcp"]);
 if(!tunnel&&!direct)throw new Error("Caddy does not match a supported direct or Tunnel boundary");
 const caddyfiles=(caddy.volumes||[]).filter(volume=>volume.target==="/etc/caddy/Caddyfile");
 const expected=tunnel?"./infra/Caddyfile.cloudflare-tunnel":"./infra/Caddyfile";
 if(caddyfiles.length!==1||caddyfiles[0].type!=="bind"||caddyfiles[0].read_only!==true||caddyfiles[0].source!==expected)throw new Error("Caddyfile does not match the selected ingress boundary");
 process.stdout.write(tunnel?"tunnel":"direct");
});') || die 'merged Compose does not match a supported ingress boundary'
pass 'merged Compose keeps the app private and exposes only a supported Caddy boundary'

app_container=$(docker compose ps -q app)
caddy_container=$(docker compose ps -q caddy)
[ -n "$app_container" ] && [ -n "$caddy_container" ] || die 'app and Caddy containers must both be running'
project_containers=$(docker ps --no-trunc -aq --filter "label=com.docker.compose.project=$compose_project") ||
  die 'could not enumerate containers owned by this Compose project'
project_container_count=$(printf '%s\n' "$project_containers" | awk 'NF { count++ } END { print count + 0 }')
[ "$project_container_count" -eq 2 ] || die 'the Compose project must own exactly one application container and one Caddy container'
app_container_id=$(docker inspect --format '{{.Id}}' "$app_container") || die 'could not resolve the application container identity'
caddy_container_id=$(docker inspect --format '{{.Id}}' "$caddy_container") || die 'could not resolve the Caddy container identity'
# `--no-trunc` makes this comparable to Compose's full IDs without word-splitting IDs into another
# Docker command.
actual_container_ids=$(printf '%s\n' "$project_containers" | awk 'NF' | sort)
expected_container_ids=$(printf '%s\n%s\n' "$app_container_id" "$caddy_container_id" | sort)
[ "$actual_container_ids" = "$expected_container_ids" ] || die 'the Compose project has an orphan or unexpected service container'
[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}' "$app_container")" = "$compose_project:app" ] ||
  die 'application container Compose identity is incorrect'
[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}' "$caddy_container")" = "$compose_project:caddy" ] ||
  die 'Caddy container Compose identity is incorrect'
app_runtime=$(docker inspect --format '{"bindings":{{json .HostConfig.PortBindings}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}}}' "$app_container") ||
  die 'could not inspect the application runtime port boundary'
caddy_runtime=$(docker inspect --format '{"bindings":{{json .HostConfig.PortBindings}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}' "$caddy_container") ||
  die 'could not inspect the Caddy runtime port boundary'
printf '[%s,%s]' "$app_runtime" "$caddy_runtime" |
  docker compose exec -T -e VERIFY_INGRESS_MODE="$ingress_mode" -e VERIFY_COMPOSE_PROJECT="$compose_project" -e VERIFY_REPO_DIR="$repo_dir" app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
 const [app,caddy]=JSON.parse(input),mode=process.env.VERIFY_INGRESS_MODE,repo=process.env.VERIFY_REPO_DIR,network=`${process.env.VERIFY_COMPOSE_PROJECT}_internal`;
 const active=value=>Object.fromEntries(Object.entries(value||{}).filter(([,bindings])=>Array.isArray(bindings)&&bindings.length));
 for(const service of [app,caddy]){
   if(service.networkMode!==network||JSON.stringify(Object.keys(service.networks||{}).sort())!==JSON.stringify([network]))throw new Error("running service escaped the private Compose network");
 }
 const appBindings=active(app.bindings),appPorts=active(app.ports);
 if(Object.keys(appBindings).length||Object.keys(appPorts).length)throw new Error("the running app publishes a host port");
 const hostBindings=active(caddy.bindings),runtimePorts=active(caddy.ports);
 const expected=mode==="tunnel"?{"80/tcp":"18080"}:{"80/tcp":"80","443/tcp":"443","443/udp":"443"};
 const expectedKeys=Object.keys(expected).sort(),sameKeys=value=>JSON.stringify(Object.keys(value).sort())===JSON.stringify(expectedKeys);
 if(!sameKeys(hostBindings)||!sameKeys(runtimePorts))throw new Error("running Caddy ports differ from the selected boundary");
 for(const [containerPort,hostPort] of Object.entries(expected)){
   const requested=hostBindings[containerPort];
   if(requested.length!==1||String(requested[0].HostPort)!==hostPort)throw new Error("Caddy host binding differs from Compose");
   const requestedIp=String(requested[0].HostIp||"");
   if(mode==="tunnel"?requestedIp!=="127.0.0.1":!["","0.0.0.0"].includes(requestedIp))throw new Error("Caddy host binding uses an unexpected address");
   const actual=runtimePorts[containerPort];
   if(!actual.length||actual.some(binding=>String(binding.HostPort)!==hostPort))throw new Error("Caddy runtime publication differs from Compose");
   const actualIps=actual.map(binding=>String(binding.HostIp||""));
   if(mode==="tunnel"?(actual.length!==1||actualIps[0]!=="127.0.0.1"):actualIps.some(ip=>!["0.0.0.0","::"].includes(ip)))throw new Error("Caddy runtime publication uses an unexpected address");
 }
 const caddyfiles=(caddy.mounts||[]).filter(mount=>mount.Destination==="/etc/caddy/Caddyfile");
 const expectedCaddyfile=`${repo}/${mode==="tunnel"?"infra/Caddyfile.cloudflare-tunnel":"infra/Caddyfile"}`;
 if(caddyfiles.length!==1||caddyfiles[0].Type!=="bind"||caddyfiles[0].Source!==expectedCaddyfile||caddyfiles[0].RW!==false)throw new Error("running Caddyfile mount differs from the selected boundary");
});' || die 'running containers do not match the selected private ingress boundary'
network_runtime=$(docker network inspect --format '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}}}' "${compose_project}_internal") ||
  die 'could not inspect the private Compose runtime network'
printf '%s' "$network_runtime" | docker compose exec -T -e VERIFY_NETWORK_NAME="${compose_project}_internal" app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const network=JSON.parse(input);if(network.name!==process.env.VERIFY_NETWORK_NAME||network.driver!=="bridge"||network.scope!=="local"||network.internal!==false)process.exit(1);});' ||
  die 'running Compose network is not the expected local bridge'
pass 'running containers publish exactly the selected Caddy boundary and no application port'

expected_version=$(tr -d '[:space:]' < "$repo_dir/VERSION")
image_id=$(docker inspect --format '{{.Image}}' "$app_container")
image_version=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image_id")
image_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_id")
[ "$image_version" = "$expected_version" ] || die "image version differs: expected=$expected_version actual=$image_version"
expected_revision=v$expected_version
if [ -e "$repo_dir/.git" ]; then
  command -v git >/dev/null 2>&1 || die 'git is required to verify this checkout image revision'
  source_status=$(git -C "$repo_dir" status --porcelain --untracked-files=all 2>/dev/null) ||
    die 'could not inspect the deployment checkout state'
  [ -z "$source_status" ] || die 'deployment checkout has tracked or untracked changes and cannot prove image provenance'
  expected_revision=$(git -C "$repo_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) ||
    die 'could not resolve the checkout revision for image verification'
  [[ "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || die 'checkout revision is not a full Git object identity'
fi
[ "$image_revision" = "$expected_revision" ] || die 'application image source revision does not match this deployment source'
[ "$(docker inspect --format '{{.RestartCount}}' "$app_container")" -eq 0 ] || die 'application container restarted during acceptance'
[ "$(docker inspect --format '{{.RestartCount}}' "$caddy_container")" -eq 0 ] || die 'Caddy container restarted during acceptance'
pass "application image exactly identifies release $expected_version and its source revision"
pass 'application and Caddy have zero restarts'

tmp_dir=$(mktemp -d /tmp/gateway-verify.XXXXXX)
chmod 700 "$tmp_dir"
cookie_jar=$tmp_dir/cookies
login_body=$tmp_dir/login.json
me_body=$tmp_dir/me.json
audit_body=$tmp_dir/audit.json
} </dev/null

# A human may invoke the verifier through `bash -x`; disable tracing before any secret is read.
set +x
if [ "$password_stdin" -eq 1 ]; then
  IFS= read -r admin_password || die 'could not read the administrator password from standard input'
else
  [ -t 0 ] || die 'standard input is not a terminal; use --password-stdin for controlled automation'
  read -r -s -p 'One-time administrator password: ' admin_password
  printf '\n'
fi
[ -n "$admin_password" ] || die 'administrator password is empty'

login_payload=$(printf '%s\n%s' "$admin_email" "$admin_password" | docker compose exec -T app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const split=input.indexOf("\n");if(split<1)process.exit(1);process.stdout.write(JSON.stringify({email:input.slice(0,split),password:input.slice(split+1)}));});')
curl_tls=()
if [ "$insecure" -eq 1 ]; then curl_tls+=(-k); fi
login_code=$(printf '%s' "$login_payload" | curl "${curl_tls[@]}" -sS --max-time 20 -c "$cookie_jar" \
  -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- \
  -o "$login_body" -w '%{http_code}' "$base/api/v1/auth/login" || true)
unset admin_password login_payload
[ "$login_code" = 200 ] || die "administrator login failed with HTTP $login_code"
VERIFY_ADMIN_EMAIL=$admin_email docker compose exec -T -e VERIFY_ADMIN_EMAIL app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const body=JSON.parse(input);if(body.user?.email!==process.env.VERIFY_ADMIN_EMAIL||body.mfaRequired!==false)process.exit(1)});' < "$login_body" || die 'login response did not identify the expected administrator without an MFA challenge'
pass 'administrator login succeeds'

me_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -b "$cookie_jar" -o "$me_body" -w '%{http_code}' "$base/api/v1/auth/me" || true)
[ "$me_code" = 200 ] || die "authenticated identity failed with HTTP $me_code"
VERIFY_ADMIN_EMAIL=$admin_email docker compose exec -T -e VERIFY_ADMIN_EMAIL app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const body=JSON.parse(input),roles=body.membership?.roles;if(body.user?.email!==process.env.VERIFY_ADMIN_EMAIL||!Array.isArray(roles)||!roles.includes("owner"))process.exit(1)});' < "$me_body" || die 'authenticated identity is not the expected owner'
pass 'authenticated identity has the owner role'

admin_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -b "$cookie_jar" -o /dev/null -w '%{http_code}' "$base/admin" || true)
[ "$admin_code" = 200 ] || die "authenticated admin page failed with HTTP $admin_code"
pass 'authenticated admin page returns HTTP 200'

audit_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -b "$cookie_jar" -o "$audit_body" -w '%{http_code}' "$base/api/v1/audit/integrity" || true)
[ "$audit_code" = 200 ] || die "audit-integrity request failed with HTTP $audit_code"
docker compose exec -T app node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const body=JSON.parse(input);if(body.valid!==true||!Number.isSafeInteger(body.checkedRows)||body.checkedRows<1)process.exit(1)});' < "$audit_body" || die 'audit chain is invalid or contains no login event'
pass 'audit chain is valid and contains audited activity'

printf '%s\n' 'verify-install: all checks passed'
