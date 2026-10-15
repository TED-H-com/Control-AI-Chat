#!/usr/bin/env bash
set -euo pipefail

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { printf '%s\n' 'Usage: scripts/smoke.sh [--insecure] <https://base>' >&2; exit 2; }
curl_tls=()
if [ "$1" = --insecure ]; then
  curl_tls=(-k)
  shift
fi
[ "$#" -eq 1 ] || { printf '%s\n' 'Usage: scripts/smoke.sh [--insecure] <https://base>' >&2; exit 2; }
base=${1%/}
case "$base" in https://*) ;; *) printf '%s\n' 'ERROR: base URL must begin with https://' >&2; exit 2 ;; esac
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
expected_version=${EXPECTED_VERSION:-}
if [ -z "$expected_version" ] && [ -f "$repo_dir/VERSION" ]; then
  expected_version=$(tr -d '[:space:]' < "$repo_dir/VERSION")
fi
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf '%s\n' 'ERROR: expected release version is unavailable; keep VERSION with the deployment or set EXPECTED_VERSION' >&2
  exit 2
}
escaped_version=${expected_version//./\\.}
failures=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }

tmp_dir=$(mktemp -d /tmp/gateway-smoke.XXXXXX)
cleanup() { case "$tmp_dir" in /tmp/gateway-smoke.*) rm -rf -- "$tmp_dir" ;; esac; }
trap cleanup EXIT

health_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -o "$tmp_dir/health" -w '%{http_code}' "$base/api/health" || true)
if [ "$health_code" = 200 ] && grep -Eq '"db"[[:space:]]*:[[:space:]]*"ok"' "$tmp_dir/health"; then pass 'health reports db ok'; else fail "health check (HTTP $health_code)"; fi
if [ "$health_code" = 200 ] && grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$escaped_version"'"' "$tmp_dir/health"; then pass "health reports release version $expected_version"; else fail "health release version $expected_version"; fi

ready_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -o "$tmp_dir/ready" -w '%{http_code}' "$base/api/v1/health/ready" || true)
ready=1
for check in schema integrity chain; do
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"'"$check"'"[[:space:]]*,[[:space:]]*"ok"[[:space:]]*:[[:space:]]*true' "$tmp_dir/ready" || ready=0
done
if [ "$ready_code" = 200 ] && [ "$ready" -eq 1 ]; then pass 'readiness reports schema, integrity, and chain ok'; else fail "readiness check (HTTP $ready_code)"; fi

login_meta=$(curl "${curl_tls[@]}" -sS --max-time 20 -o "$tmp_dir/login" -D "$tmp_dir/login.headers" -w '%{http_code} %{content_type}' "$base/login" || true)
case "$login_meta" in '200 text/html'*) pass 'login returns HTML' ;; *) fail "login response ($login_meta)" ;; esac
if grep -qi '^Strict-Transport-Security:' "$tmp_dir/login.headers"; then pass 'Strict-Transport-Security present'; else fail 'Strict-Transport-Security missing'; fi
if grep -qi '^X-Robots-Tag:.*noindex' "$tmp_dir/login.headers"; then pass 'X-Robots-Tag noindex present'; else fail 'X-Robots-Tag noindex missing'; fi

csrf_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -X POST -H 'Content-Type: application/json' --data '{}' -o "$tmp_dir/csrf" -w '%{http_code}' "$base/api/v1/auth/login" || true)
if [ "$csrf_code" = 403 ] && grep -q 'CSRF_REJECTED' "$tmp_dir/csrf"; then pass 'Origin-less login POST is rejected by CSRF guard'; else fail "CSRF guard (HTTP $csrf_code)"; fi

admin_models_code=$(curl "${curl_tls[@]}" -sS --max-time 20 -o "$tmp_dir/admin-models" -w '%{http_code}' "$base/api/v1/admin/models" || true)
if [ "$admin_models_code" = 401 ]; then pass 'anonymous /api/v1/admin/models is unauthorized'; else fail "anonymous /api/v1/admin/models (HTTP $admin_models_code)"; fi

[ "$failures" -eq 0 ] || exit 1
printf '%s\n' 'smoke: all checks passed'
