#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
while IFS= read -r variable; do
  case "$variable" in COMPOSE_*) unset "$variable" ;; esac
done < <(compgen -e)
unset COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES APP_DOMAIN APP_ORIGIN ACME_EMAIL JWT_SECRET
unset AUDIT_KEY PROVIDER_CREDENTIAL_KEY PROVIDER_CREDENTIAL_PREVIOUS_KEYS
unset PROVIDER_CREDENTIAL_KEY_VERSION PROXY_SHARED_SECRET RETENTION_ENFORCEMENT_ENABLED
unset NODE_ENV APP_VERSION VCS_REF
mkdir -p "$test_dir/infra"
cp "$repo_dir/docker-compose.yml" "$repo_dir/docker-compose.cloudflare-tunnel.yml" \
  "$repo_dir/Dockerfile" "$test_dir/"
cp "$repo_dir/infra/Caddyfile" "$repo_dir/infra/Caddyfile.cloudflare-tunnel" \
  "$test_dir/infra/"

# These are inert test values. COMPOSE_FILE is intentionally read from .env, not supplied to the
# command, because persistence is what keeps later bare Compose commands from exposing 80/443.
cat > "$test_dir/.env" <<'ENV'
APP_DOMAIN=tunnel.example.test
APP_ORIGIN=https://tunnel.example.test
ACME_EMAIL=acme@example.test
COMPOSE_PROJECT_NAME=tunnel-compose-test
COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml
JWT_SECRET=test-only-jwt-secret
AUDIT_KEY=test-only-audit-key
PROVIDER_CREDENTIAL_KEY=test-only-provider-key
PROXY_SHARED_SECRET=test-only-proxy-secret
PROVIDER_CREDENTIAL_KEY_VERSION=1
RETENTION_ENFORCEMENT_ENABLED=true
NODE_ENV=production
ENV

compose_json=$(cd "$test_dir" && env -u COMPOSE_FILE docker compose config --no-env-resolution --format json)
printf '%s' "$compose_json" | VERIFY_TEST_DIR="$test_dir" node -e '
  const assert=require("node:assert/strict");
  let input="";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data",chunk=>{input+=chunk});
  process.stdin.on("end",()=>{
    const model=JSON.parse(input),services=model.services;
    assert.equal(model.name,"tunnel-compose-test");
    assert.deepEqual(Object.keys(services).sort(),["app","caddy"]);
    assert.equal(services.app.network_mode,undefined);
    assert.equal(services.caddy.network_mode,undefined);
    assert.deepEqual(Object.keys(services.app.networks),["internal"]);
    assert.deepEqual(Object.keys(services.caddy.networks),["internal"]);
    assert.deepEqual(Object.keys(model.networks),["internal"]);
    assert.equal(model.networks.internal.name,"tunnel-compose-test_internal");
    assert.notEqual(model.networks.internal.external,true);
    assert.notEqual(model.networks.internal.internal,true);
    assert.ok(model.networks.internal.driver===undefined||model.networks.internal.driver==="bridge");
    const publishers=Object.entries(services).filter(([,service])=>Array.isArray(service.ports));
    assert.deepEqual(publishers.map(([name])=>name),["caddy"]);
    assert.deepEqual(services.caddy.ports,[{
      mode:"ingress",host_ip:"127.0.0.1",target:80,published:"18080",protocol:"tcp",
    }]);
    assert.equal(services.app.ports,undefined);
    const caddyfile=services.caddy.volumes.find(volume=>volume.target==="/etc/caddy/Caddyfile");
    assert.equal(caddyfile.source,`${process.env.VERIFY_TEST_DIR}/infra/Caddyfile.cloudflare-tunnel`);
    assert.equal(caddyfile.read_only,true);
  });
'

# The persisted marker must fail closed if an upgrade or partial extraction omits the tracked
# overlay. Even the underlying Compose resolution must never fall back to the base file and publish
# 80/443; supported operator commands use scripts/compose.sh as an additional boundary.
mv "$test_dir/docker-compose.cloudflare-tunnel.yml" "$test_dir/docker-compose.cloudflare-tunnel.yml.missing"
if (cd "$test_dir" && env -u COMPOSE_FILE docker compose config --no-env-resolution >/dev/null 2>&1); then
  printf '%s\n' 'bare Compose accepted a missing persisted Tunnel overlay' >&2
  exit 1
fi
mv "$test_dir/docker-compose.cloudflare-tunnel.yml.missing" "$test_dir/docker-compose.cloudflare-tunnel.yml"

printf '%s\n' 'cloudflare tunnel Compose test: PASS'
