# Deploying Control AI Chat

[`SUPPORTED-DEPLOYMENT.md`](SUPPORTED-DEPLOYMENT.md) is the normative v0.1.x customer and
implementation-partner baseline. This guide is the operating procedure for that standard; a
successful installer exit is not a substitute for its acceptance gates.

## Requirements

- One Linux `amd64` or `arm64` host. Ubuntu Server 24.04 LTS is the reference OS.
- 2 vCPU and 4 GB RAM is the supported starting point, not a universal production capacity
  guarantee. Load-test representative concurrency, prompt sizes, detectors, and document extraction
  volume, then record the approved sizing envelope before go-live.
- At least 10 GiB free on both the repository checkout filesystem and Docker's root filesystem,
  checked separately even when they are the same filesystem. This is an installation floor, not a
  capacity plan; account for database/WAL growth, uploads, images, build cache, logs, temporary
  work, restores, and off-host backup staging as required by the deployment standard.
- Docker Engine with the Compose plugin and OpenSSL. The standard Caddy path needs inbound TCP
  ports 80 and 443. Its shipped host mapping also requires UDP 443 to be free and publishes it;
  allowing that port through the firewall for HTTP/3 is optional because HTTPS still works over
  TCP. The dedicated Cloudflare Tunnel path instead needs Docker Engine 28.0.0 or
  newer, Docker Compose 2.24.4 or newer, Python 3, and free loopback TCP port 18080; it opens no inbound
  web port. Add the deployment user to the `docker` group and start a new login shell after
  installing Docker, or run the installer with `sudo`.
- A domain. For standard Caddy, its A and/or AAAA record points to the host. For a dedicated,
  locally managed Cloudflare Tunnel, its DNS route points to that tunnel. Public HTTPS is required
  for the secure, host-only session cookie in either mode. Supply the hostname in lowercase ASCII;
  browsers normalize origin hostnames and the installer rejects uppercase input rather than
  creating an `APP_ORIGIN` mismatch.
- A repository checkout or release source archive extracted into a stable deployment directory,
  plus an email address for ACME certificate notices.
- Working DNS resolution, synchronized host time, and the feature-specific egress listed in
  [`SUPPORTED-DEPLOYMENT.md`](SUPPORTED-DEPLOYMENT.md#5-network-and-time-prerequisites).

Cloud-specific starting points are available for [AWS](cloud/aws.md), [Azure](cloud/azure.md),
[Google Cloud](cloud/gcp.md), and [Oracle Cloud](cloud/oracle.md).

## The short path

From the repository root, run:

```bash
./install.sh
```

The installer prompts for the domain, ACME email, workspace name, and first owner email.
For unattended installation, pass all four flags with `--yes`; use `./install.sh --help` for the
complete syntax. Save the one-time owner password shown at the end.

### Dedicated Cloudflare Tunnel path

On a shared host where opening public 80/443 would broaden the origin attack surface, use the
tracked loopback-only overlay:

```bash
./install.sh --cloudflare-tunnel \
  --domain <app-domain> \
  --email <acme-email> \
  --workspace-name '<workspace-name>' \
  --admin-email <owner-email> \
  --yes
```

This mode publishes only `127.0.0.1:18080` and keeps the app itself on the internal Compose
network. The installer writes the fixed value
`COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml` into the mode-600 `.env`.
That marker lets the bundled safe Compose wrapper retain the same boundary; if the tracked overlay
is missing, Compose fails rather than falling back to public 80/443. Do not replace the marker with
an arbitrary path.

### Safe Compose operations

After installation, run every routine, migration, upgrade, backup, and restore Compose operation
through `scripts/compose.sh`, from any working directory:

```bash
/absolute/deployment/path/scripts/compose.sh ps
```

The wrapper rejects all caller-exported `COMPOSE_*` variables, removes caller application settings,
requires the mode-600 `.env` to contain exactly one recorded project identity and only the supported
ingress marker, rejects a dirty Git checkout, derives image version/source labels from the reviewed
release, and then invokes Compose from the stable deployment directory. This prevents a shell profile
or previous project from redirecting an operation to another Compose file, project, or data volume.
Do not replace it with bare `docker compose`, `docker compose -p`, or a copied ad-hoc wrapper in the
operating runbook.

The installer prepares and validates only the application-side loopback origin and persisted
Compose overlay. It does not sign in to Cloudflare, choose or create an account, create a tunnel,
issue or store its credential, install its runtime service, or change DNS. Those are separate,
human-approved actions in the customer's Cloudflare account. Create a dedicated locally managed
tunnel and DNS route, then run it with an ingress rule that reaches Caddy rather than the app:

```yaml
tunnel: <dedicated-tunnel-id>
credentials-file: /etc/cloudflared-control-ai-chat/credentials.json
ingress:
  - hostname: private.example.com
    service: http://127.0.0.1:18080
    originRequest:
      httpHostHeader: private.example.com
  - service: http_status:404
```

Use a separate credential and service from any tunnel carrying other applications. Make the
credential readable only by its dedicated unprivileged runtime user. Public TLS terminates at
Cloudflare; the encrypted tunnel ends on the VM, and Caddy still supplies the security headers,
streaming behavior, and authenticated `PROXY_SHARED_SECRET` boundary to the app. Never point the
tunnel directly at `app:3010`.

### Migrating an existing direct-Caddy deployment to a dedicated Tunnel

Do not rerun the installer with `--cloudflare-tunnel`, and do not use `--force` to change ingress.
The installer intentionally refuses this transition because `.env` and the existing data volume
are one recovery set; an installer-driven secret rewrite could destroy audit verification and
credential recovery.

Use a planned maintenance window:

1. Record the absolute deployment directory and effective Compose project name. Create and verify
   the offline backup below, including the matching complete `.env`, and copy it off-host.
2. Obtain explicit customer approval for the Cloudflare account, hostname, dedicated tunnel, DNS
   change, and credential handling. Create the dedicated tunnel configuration and unprivileged
   service, but do not reuse a tunnel that carries unrelated applications.
3. Confirm Docker Engine 28.0.0+, Docker Compose 2.24.4+, Python 3, free loopback TCP 18080, and the
   Tunnel egress described in the deployment standard.
4. From the unchanged deployment directory, stop the existing project while its original `.env`
   is still active:

   ```bash
   scripts/compose.sh down
   (
     set -euo pipefail
     test ! -L .env
     test -f .env
     test "$(stat -c '%a' .env)" = 600
     test -z "$(grep '^COMPOSE_FILE=' .env || true)"
     umask 077
     env_tmp=$(mktemp ./.env.tmp.XXXXXX)
     trap 'rm -f -- "$env_tmp"' EXIT
     install -m 600 .env "$env_tmp"
     printf '%s\n' 'COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml' >> "$env_tmp"
     mv -f -- "$env_tmp" .env
     trap - EXIT
   )
   ```

5. Run `scripts/compose.sh config` and inspect the fully merged model before startup. Caddy MUST be the
   only service with a published port, and that list MUST contain exactly
   `127.0.0.1:18080` TCP mapped to container port 80. The application MUST have no published port,
   and Caddy MUST mount `infra/Caddyfile.cloudflare-tunnel` read-only. If any check differs, restore
   the backed-up `.env` and stop; do not start the project.
6. Run `scripts/compose.sh up -d --build`, start the dedicated tunnel service, and publish its approved
   DNS route. Remove only this application's former public 80/443 and UDP 443 rules; do not alter an
   unrelated shared-host listener or firewall rule without its owner's approval.
7. Complete every acceptance gate in
   [`SUPPORTED-DEPLOYMENT.md`](SUPPORTED-DEPLOYMENT.md#8-acceptance-gates), including the public
   HTTPS smoke test. Confirm this deployment's Caddy listens only on `127.0.0.1:18080` and retain
   evidence that it publishes no application port or public 80/443. Record any unrelated listener
   on the shared host separately.

The reverse transition is also a planned ingress migration, not an installer retry. Restore direct
DNS and firewall reachability, then remove only the exact tracked `COMPOSE_FILE` line during
downtime with the same fail-closed, same-directory replacement pattern:

```bash
scripts/compose.sh down
(
  set -euo pipefail
  test ! -L .env
  test -f .env
  test "$(stat -c '%a' .env)" = 600
  marker='COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml'
  test "$(grep -Fxc "$marker" .env)" = 1
  test "$(grep -c '^COMPOSE_FILE=' .env)" = 1
  umask 077
  env_tmp=$(mktemp ./.env.tmp.XXXXXX)
  trap 'rm -f -- "$env_tmp"' EXIT
  awk -v marker="$marker" '$0 != marker { print }' .env > "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f -- "$env_tmp" .env
  trap - EXIT
)
scripts/compose.sh config
```

Inspect the direct Compose model before startup: only Caddy may publish ports, with exact TCP 80/443
and UDP 443 mappings, the app unpublished, and the direct Caddyfile read-only. Only after that manual
inspection passes, run `scripts/compose.sh up -d --build`, then complete the same acceptance gates.

## What the installer did

An operator doing the same work manually would:

1. Check Docker, the selected public or loopback ports, at least 10 GiB free on both the checkout and
   Docker-root filesystems, OpenSSL, synchronized host time, DNS, and an exact clean Git source when
   installing from a checkout. The operator separately verifies approved egress. Tunnel mode also
   validates the fully merged Compose model before creating secrets.
2. Create a mode-600 `.env` containing fixed `COMPOSE_PROJECT_NAME`, `APP_DOMAIN`, `APP_ORIGIN`,
   required `ACME_EMAIL` for
   certificate notices (Caddy refuses an empty `email` directive), fresh
   `JWT_SECRET`, `AUDIT_KEY`, `PROVIDER_CREDENTIAL_KEY`, and `PROXY_SHARED_SECRET` values;
   `PROVIDER_CREDENTIAL_KEY_VERSION=1`;
   `RETENTION_ENFORCEMENT_ENABLED=true`; and `NODE_ENV=production`.
   Tunnel mode also records the one supported `COMPOSE_FILE` pair.
3. Build the Node 24 application image, then start it with Caddy.
   Compose mounts the `data` volume at `/data`. In standard mode Caddy obtains and renews TLS;
   in dedicated Tunnel mode Cloudflare terminates public TLS and Caddy is reachable only through
   the loopback origin.
4. Wait until `/api/health` reports `db: "ok"`, require readiness checks for schema, SQLite
   integrity, and audit chain, and require the applied migration count to equal the release source.
5. Run the bootstrap command below. It is idempotent and does not change an existing workspace.

   ```bash
   scripts/compose.sh exec -T -e NPM_CONFIG_UPDATE_NOTIFIER=false app npm run bootstrap -- \
     --workspace-name '<workspace-name>' --admin-email '<owner-email>'
   ```

Provider credentials are entered later in the administrator console under Providers. They do not
belong in `.env` or another file.


## Acceptance verification

After public HTTPS is available, run the bundled verifier from the stable deployment directory. It
reads the owner password from a hidden prompt and does not accept it as a command-line
argument:

```bash
scripts/verify-install.sh "https://$APP_DOMAIN" '<owner-email>'
```

It verifies the mode-600 `.env`, recorded project identity and origin, the complete external smoke
boundary, source/applied migrations, schema/integrity/audit readiness, the merged Compose ingress
model, the exact running service/port/private-bridge boundary, exact image/source labels, zero
container restarts, owner login, `/admin`, and audited activity. `--insecure` is available only for
an isolated acceptance host with a self-signed certificate; never use it for production.

This command covers the online gates, not recovery or capacity qualification. Complete the
off-host backup/restore exercise and representative load test in
[`SUPPORTED-DEPLOYMENT.md`](SUPPORTED-DEPLOYMENT.md#8-acceptance-gates) before calling a production
deployment accepted.

Maintainers and implementation partners qualifying a release artifact from zero can run
`scripts/clean-install-e2e.sh` on a disposable Linux Docker host. It builds from a history-free
archive of the exact committed revision, runs the real Tunnel-mode installer, executes
`verify-install.sh`, proves retry/`--force` safety, and performs a destructive backup/restore drill
inside its disposable Compose project. It refuses tracked changes and removes its temporary
containers and three project volumes; do not aim it at an existing deployment or a host whose
loopback ports conflict.

Maintainers can also run `scripts/rotation-rehearsal.sh` for a destructive-but-disposable
rehearsal of provider credential-key rotation from committed `HEAD`, including the early-removal
refusal, the recovery from it, and a clean startup once the rotation has actually run.

## Lost access

In production, `APP_ORIGIN` is required at startup and is used to build setup and password-reset
links. Keep it set to the public origin users actually open.

When SMTP is configured, users can request a one-time password-reset link from the sign-in page.
The response does not reveal whether an address exists, and another email for the same user is not
sent for five minutes. The link expires after one hour.

With shell access and no working email, issue a link from the deployment directory:

```bash
scripts/compose.sh exec -T app npm run issue-password-link -- --workspace <slug> --email <address>
```

For an invited user this prints a setup link that expires after seven days; for an active user it
prints a password-reset link that expires after 24 hours. The command prints the link once and
records an audit event. Every setup or reset link is single-use, a newer link replaces an open link
of the same kind, and only a SHA-256 hash of its token is stored. Completing a reset ends all of
that user's sessions.

## Upgrading

Keep the deployment directory, the mode-600 `.env`, its recorded `COMPOSE_PROJECT_NAME`, and the matching data volume together for every upgrade. Never override the project identity with `docker compose -p`, and never start the upgraded source from a differently named directory.

Before changing the release source, create the complete offline backup described below and copy it off-host. Then update the reviewed Git checkout in place, or extract the source archive over the same deployment directory. For a Git checkout, select the reviewed release tag rather than an arbitrary branch head.

Build and start through the safe Compose wrapper, then verify readiness and the public boundary:

```bash
scripts/compose.sh build
scripts/compose.sh up -d --no-build
scripts/compose.sh exec -T app node -e \
  'fetch("http://127.0.0.1:3010/api/v1/health/ready").then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e);process.exit(1)})'
scripts/verify-install.sh https://<app-domain> <owner-email>
```

Database migrations run at application boot. Applied migrations are checksum-verified, so edited or corrupted migration history stops startup instead of silently changing the schema.

## Backup and restore

The Compose `data` volume contains `/data/app.db`, its SQLite WAL sidecars, and uploads. A usable
backup also needs the complete `.env`: `AUDIT_KEY` protects audit
verification and encrypted transcripts, while `PROVIDER_CREDENTIAL_KEY` and any
`PROVIDER_CREDENTIAL_PREVIOUS_KEYS` open provider ciphertext. Treat both the volume and complete
`.env` as production secret material.

The following offline backup is consistent and uses `tar` already present in the application image;
it does not require `sqlite3` on the host. Run it from the unchanged deployment directory. Set
`backup_root` to an absolute protected directory outside the source/deployment checkout so a future
image-build context can never receive the copied `.env`:

```bash
(
  set -euo pipefail
  deployment_dir=$(pwd -P)
  test ! -L .env
  test -f .env
  test "$(stat -c '%a' .env)" = 600
  test "$(grep -c '^COMPOSE_PROJECT_NAME=' .env || true)" = 1
  target_project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env)
  printf '%s\n' "$target_project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$'
  app_container=$(scripts/compose.sh ps -aq app)
  test "$(printf '%s\n' "$app_container" | awk 'NF { count++ } END { print count + 0 }')" = 1
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$app_container")" = "$target_project"
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$app_container")" = "$deployment_dir"
  test "$(docker inspect --format '{{.State.Running}}' "$app_container")" = true
  actual_data_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{println .Name}}{{end}}{{end}}' "$app_container" | awk 'NF')
  test "$actual_data_volume" = "${target_project}_data"
  test "$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$actual_data_volume")" = "$target_project"
  test "$(docker volume inspect --format '{{ index .Labels "com.docker.compose.volume" }}' "$actual_data_volume")" = data

  backup_root=/absolute/protected/control-ai-chat-backups
  case "$backup_root" in /*) ;; *) printf '%s\n' 'backup_root must be absolute' >&2; exit 1 ;; esac
  install -d -m 700 "$backup_root"
  backup_root=$(CDPATH= cd -- "$backup_root" && pwd -P)
  case "$backup_root/" in "$deployment_dir/"*) printf '%s\n' 'backup_root must be outside the deployment checkout' >&2; exit 1 ;; esac
  backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 700 "$backup_dir"
  install -m 600 .env "$backup_dir/deployment.env"
  trap 'scripts/compose.sh start app >/dev/null' EXIT
  scripts/compose.sh stop app
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -C /data -czf - . \
    > "$backup_dir/data.tar.gz"
  scripts/compose.sh start app >/dev/null
  trap - EXIT
  (cd "$backup_dir" && sha256sum deployment.env data.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS)
  printf 'Backup created: %s\n' "$backup_dir"
)
```

Keep the archive, environment file, and checksum together in encrypted off-host backup storage. Test
a restore on a non-production host. Restoring replaces the target deployment's complete data volume;
the explicit removal command below is destructive. It therefore rejects an in-checkout backup,
requires the backup and target to carry the same recorded project and ingress identity, and checks
that the running app actually mounts that project's exact named volume before deleting anything:

```bash
(
  set -euo pipefail
  backup_dir=/absolute/path/to/the/backup
  deployment_dir=$(pwd -P)
  case "$backup_dir" in /*) ;; *) printf '%s\n' 'backup_dir must be absolute' >&2; exit 1 ;; esac
  test ! -L "$backup_dir"
  test -d "$backup_dir"
  backup_dir=$(CDPATH= cd -- "$backup_dir" && pwd -P)
  case "$backup_dir/" in "$deployment_dir/"*) printf '%s\n' 'backup_dir must be outside the deployment checkout' >&2; exit 1 ;; esac
  test ! -L "$backup_dir/SHA256SUMS"
  test -f "$backup_dir/SHA256SUMS"
  test ! -L "$backup_dir/deployment.env"
  test -f "$backup_dir/deployment.env"
  test ! -L "$backup_dir/data.tar.gz"
  test -f "$backup_dir/data.tar.gz"
  awk '
    BEGIN { valid = 1 }
    NF != 2 || $1 !~ /^[0-9a-f]{64}$/ { valid = 0 }
    $2 != "deployment.env" && $2 != "data.tar.gz" { valid = 0 }
    seen[$2]++ { valid = 0 }
    END { exit !(valid && NR == 2 && seen["deployment.env"] == 1 && seen["data.tar.gz"] == 1) }
  ' "$backup_dir/SHA256SUMS"
  (cd "$backup_dir" && sha256sum --strict -c SHA256SUMS)

  test ! -L .env
  test -f .env
  test "$(stat -c '%a' .env)" = 600
  test "$(stat -c '%a' "$backup_dir/deployment.env")" = 600
  test "$(grep -c '^COMPOSE_PROJECT_NAME=' .env || true)" = 1
  test "$(grep -c '^COMPOSE_PROJECT_NAME=' "$backup_dir/deployment.env" || true)" = 1
  test "$(grep -c '^COMPOSE_FILE=' "$backup_dir/deployment.env" || true)" -le 1
  target_project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env)
  backup_project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$backup_dir/deployment.env")
  printf '%s\n' "$backup_project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$'
  test "$target_project" = "$backup_project"
  target_ingress=$(grep '^COMPOSE_FILE=' .env || true)
  backup_ingress=$(grep '^COMPOSE_FILE=' "$backup_dir/deployment.env" || true)
  test "$target_ingress" = "$backup_ingress"
  backup_compose_controls=$(grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_[A-Z0-9_]+[[:space:]]*[:=]' "$backup_dir/deployment.env" || true)
  test -z "$(printf '%s\n' "$backup_compose_controls" | grep -Ev '^(COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare-tunnel.yml|COMPOSE_PROJECT_NAME=[a-z0-9][a-z0-9_-]*)$' || true)"

  app_container=$(scripts/compose.sh ps -aq app)
  test "$(printf '%s\n' "$app_container" | awk 'NF { count++ } END { print count + 0 }')" = 1
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$app_container")" = "$target_project"
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$app_container")" = "$deployment_dir"
  actual_data_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{println .Name}}{{end}}{{end}}' "$app_container" | awk 'NF')
  test "$actual_data_volume" = "${target_project}_data"
  test "$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$actual_data_volume")" = "$target_project"
  test "$(docker volume inspect --format '{{ index .Labels "com.docker.compose.volume" }}' "$actual_data_volume")" = data
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -tzf - < "$backup_dir/data.tar.gz" >/dev/null

  scripts/compose.sh stop app
  scripts/compose.sh run --rm --no-deps -T --entrypoint node app -e \
    'const fs=require("node:fs");for(const name of fs.readdirSync("/data"))fs.rmSync("/data/"+name,{recursive:true,force:true})'
  scripts/compose.sh run --rm --no-deps -T --entrypoint tar app -C /data -xzf - \
    < "$backup_dir/data.tar.gz"
  umask 077
  env_tmp=$(mktemp ./.env.tmp.XXXXXX)
  trap 'rm -f -- "$env_tmp"' EXIT
  install -m 600 "$backup_dir/deployment.env" "$env_tmp"
  mv -f -- "$env_tmp" .env
  trap - EXIT
  scripts/compose.sh up -d
  restored_healthy=0
  attempt=0
  while test "$attempt" -lt 180; do
    if scripts/compose.sh exec -T app node -e \
      'fetch("http://127.0.0.1:3010/api/health").then(r=>r.json()).then(body=>process.exit(body.db==="ok"?0:1)).catch(()=>process.exit(1))' \
      >/dev/null 2>&1; then
      restored_healthy=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  test "$restored_healthy" = 1
  scripts/compose.sh exec -T app node --input-type=module -e \
    'import Database from "better-sqlite3";const db=new Database(process.env.DB_PATH,{readonly:true});const result=db.pragma("quick_check",{simple:true});console.log(result);db.close();if(result!=="ok")process.exit(1)'
  scripts/compose.sh exec -T app node -e \
    'fetch("http://127.0.0.1:3010/api/v1/health/ready").then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e);process.exit(1)})'
)
```

After restore, run the HTTPS smoke test, open a previously uploaded attachment, verify one configured
provider without replacing its credential, and inspect the audit-integrity status in the admin
console. Protect and expire database, filesystem, and hypervisor snapshots under the same retention
policy.

## Rotating `PROVIDER_CREDENTIAL_KEY`

1. Generate a new root with `openssl rand -hex 32`.
2. In `.env`, move the current key into `PROVIDER_CREDENTIAL_PREVIOUS_KEYS` as a JSON mapping from
   its current version to its value, set the new root, and increment
   `PROVIDER_CREDENTIAL_KEY_VERSION`.
3. Recreate the app container: `scripts/compose.sh up -d --force-recreate app`.
4. Run `scripts/compose.sh exec -T app npm run rotate-provider-credentials`. Optionally append
   `-- --tenant <workspace-id>` to rotate one workspace.
5. Confirm the command reports `status: "ok"` and the new version. After every credential has
   moved to that version and old backups have expired, remove the old root from the previous-key
   map and recreate the app container again.

Within each workspace, a missing old key fails loudly and rolls back that workspace's rotation,
leaving its existing ciphertext intact. Workspaces already completed earlier in the run stay rotated.

Before removing the old root, run
`scripts/compose.sh exec -T app npm run check-key-coverage`. It reads the database without writing
and lists the stored provider-key versions. Confirm the old version is absent from the
listing; exit 0 means all listed versions are currently held, not that rotation is complete. Exit 1
means a stored version is missing from the configured keys; exit 2 means the database or
configuration could not be checked. An empty listing means no covered rows were found.

If an enabled provider credential is still on the removed version, the app refuses to start and
prints `Refusing to start: enabled provider credentials name encryption key version <N>, which this process does not hold. Add version <N> to PROVIDER_CREDENTIAL_PREVIOUS_KEYS (JSON object of version to root key), or set PROVIDER_CREDENTIAL_KEY_VERSION=<N> if version <N> is the current key.`
`<N>` is the missing version. Put the removed root back into the previous-key map and recreate the
app container, then finish the rotation before retrying the removal. This is a refusal to start,
not data loss: no ciphertext has been touched.

For local or staging hosts using a self-signed or internal-CA certificate, run
`scripts/smoke.sh --insecure https://host` (never use `--insecure` for production checks).

If `scripts/compose.sh ps` shows Caddy restarting with `wrong argument count or unexpected line
ending after 'email'`, `ACME_EMAIL` is empty. Set it to the address that should receive
certificate notices, then recreate Caddy.

## Putting Cloudflare or another proxy in front

Keep the VM and Caddy as the application origin. With public Caddy 80/443, configure the outer
proxy for **Full (strict)** TLS so it validates Caddy's certificate. On a shared host, the dedicated
locally managed Tunnel path documented above instead terminates public TLS at Cloudflare and
reaches its Caddy origin only at `127.0.0.1:18080`. In both cases, disable buffering for
`text/event-stream`, or streamed chat output arrives as a late block. Allow the connection to
remain open for long generations. The usual first-byte timeout is cleared because the server emits
`run.status` before calling the model.

The bundled Caddy configuration authenticates its `{client_ip}` assertion to the app and overwrites
the internal headers, so a public request cannot directly select an audit IP. With no outer proxy,
Caddy resolves `{client_ip}` to the direct socket peer. With an outer proxy, add that proxy's
**current published CIDRs only** to the global block and enable right-to-left strict parsing. Do
this only for a public reverse-proxy path; the loopback Tunnel mode intentionally uses the tunnel
peer as its fail-safe attribution and shared login-rate-limit bucket:

```caddyfile
{
	email {$ACME_EMAIL}
	servers {
		trusted_proxies static <trusted-proxy-cidr> <another-trusted-proxy-cidr>
		trusted_proxies_strict
	}
}
```

Do not use `private_ranges` merely for convenience, and do not trust arbitrary public
`X-Forwarded-For` values. Restrict origin-network ingress to the chosen proxy where practical, keep
its CIDR list current, run `caddy validate` after each change, and verify that two external clients
receive independent login rate-limit buckets. Without this configuration, the outer proxy address
is safely used instead, but all of its users share one 30-attempt-per-minute login bucket and audit
attribution cannot distinguish them.

## Unsupported reference: running without Docker

This appendix is implementation reference only. A non-Docker installation is **not** a conforming
v0.1.x customer or partner deployment, is not accepted by `scripts/verify-install.sh`, and requires
an explicit architecture and support exception. For development or evaluation, install Node.js 24 and Caddy. Build the web and server packages, provide the production variables from `.env.example`, and
give the service a single writable data directory for the SQLite database and uploads.
The app still requires `PROXY_SHARED_SECRET`; expose that same value to Caddy's environment so its
source-IP assertion can be authenticated, and never place the Node listener on a public interface.

[`infra/control-ai-chat.service.example`](../infra/control-ai-chat.service.example) is a generic
systemd starting point. It uses `Restart=always`, `EnvironmentFile=`, and a hardened
`ProtectSystem=strict` block. Replace every angle-bracket placeholder, install the unit, and point
Caddy at the configured Node port. Adapt `infra/Caddyfile` by replacing its container
upstream with the local Node listener; retain its TLS, headers, streaming flush, and timeout rules.
