# Supported Deployment Standard — v0.1.x

This document is the normative deployment baseline for Control AI Chat v0.1.x.
Customer installations, partner-led installations, and support hand-offs MUST conform to it.
[`DEPLOY.md`](DEPLOY.md) supplies the operating procedure; cloud recipes
only translate this standard into provider-specific VM steps. If another deployment document is
ambiguous, this standard controls.

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` have their usual requirements meaning. A successful
installer exit is not, by itself, proof that a deployment is accepted.

## 1. Supported topology

| Boundary | v0.1.x requirement |
|---|---|
| Host | One customer-controlled Linux `amd64` or `arm64` host. Ubuntu Server 24.04 LTS is the reference operating system. Another Linux distribution is conforming only when it meets every requirement and passes every acceptance gate below. |
| Runtime | Docker Engine with the Docker Compose plugin and OpenSSL. A deployment consists of one application container and Caddy on one Compose host. Dedicated Tunnel mode additionally requires Docker Engine 28.0.0+, Docker Compose 2.24.4+, and Python 3 for merged-model validation. |
| Compute | 2 vCPU and 4 GB RAM is the supported **starting point**, not a throughput or capacity guarantee. The customer or implementation partner MUST load-test representative concurrency, prompt sizes, file-extraction volume, enabled detectors, sign-in flows, and provider latency before approving production sizing. |
| Application scale | Exactly one application process/container per deployment. Vertical sizing is supported. Active-active replicas, horizontal scaling, and shared-write multi-host operation are not. |
| Persistent data | The Compose `data` volume mounted at `/data` MUST use a real local filesystem on the host. SQLite, its WAL sidecars, and uploads remain together in this volume. |
| Public identity | One application hostname with public HTTPS. `APP_ORIGIN` MUST exactly equal the origin users type. Plain HTTP is not a usable login boundary because session cookies are `Secure` and `__Host-` prefixed. |

## 2. Storage and capacity

Before installation, **both** the repository checkout filesystem and Docker's root filesystem MUST
each report at least 10 GiB free. Check them separately even when they resolve to the same
filesystem:

```bash
checkout_free_kb=$(df -Pk . | awk 'NR == 2 { print $4 }')
docker_root=$(docker info --format '{{.DockerRootDir}}')
docker_free_kb=$(df -Pk "$docker_root" | awk 'NR == 2 { print $4 }')
printf 'checkout_free_kb=%s docker_root=%s docker_free_kb=%s\n' \
  "$checkout_free_kb" "$docker_root" "$docker_free_kb"
test "$checkout_free_kb" -ge 10485760
test "$docker_free_kb" -ge 10485760
```

Ten gibibytes is only an installation floor for checkout, image-build, and startup headroom. It is
not a production capacity claim. Before go-live, the customer or partner MUST record a capacity
plan covering at least:

- database growth and SQLite WAL/checkpoint headroom;
- retained uploads and extracted document content;
- image layers, build cache, logs, and Caddy state;
- temporary extraction, export, upgrade, and restore space;
- backup staging, off-host retention, alert thresholds, and expected growth over the chosen
  retention period.

The live SQLite database and WAL MUST NOT reside on NFS, SMB/CIFS, a FUSE object-store mount, or an
object-storage bucket. A remote block device is acceptable only when the guest mounts it as a
reliable local filesystem and the customer validates its durability and latency. Backups may and
SHOULD be copied to encrypted off-host or object storage after a consistent archive is created.

## 3. Stable deployment identity

The deployment directory and Compose project identity determine the named volumes. The operator
MUST therefore:

1. choose one stable, absolute deployment directory;
2. run installation from that directory and every upgrade, backup, restore, and routine Compose
   operation through its tracked `scripts/compose.sh` wrapper;
3. keep its mode-600 `.env` with the matching `data` volume and preserve the exact
   `COMPOSE_PROJECT_NAME` recorded there; never override it with a different `docker compose -p`;
4. upgrade a source archive in place or update the reviewed Git checkout in place, instead of
   launching from a differently named directory.

A Git deployment checkout MUST be clean, including untracked build-context files, before it is
built or accepted. Every repository-approved ignored artifact class MUST also be excluded by the
tracked `.dockerignore`; backups containing `.env` MUST be staged outside the checkout. Caller-level
`COMPOSE_*` variables or exported application settings MUST NOT replace values from the recorded
deployment `.env`. The tracked safe Compose wrapper enforces these boundaries for post-install
operations.

Starting the same files under a different directory or project name creates a different, empty
volume. It is a new deployment, not an upgrade.

## 4. Supported HTTPS ingress boundaries

Select exactly one of these boundaries before installation and record the choice in the hand-off.

### 4.1 Direct Caddy

- DNS A and/or AAAA records MUST point the application hostname to the host.
- Inbound TCP 80 and TCP 443 MUST reach Caddy. The shipped Compose file also publishes UDP 443 for
  HTTP/3; operators SHOULD allow it while that mapping is retained, but blocking UDP 443 does not
  prevent HTTPS over TCP.
- No application port may be publicly published. Caddy alone reaches `app:3010` on the internal
  Compose network.
- Caddy obtains and renews the public certificate. The ACME notification email MUST be valid and
  retained by the operator.

### 4.2 Dedicated outbound Cloudflare Tunnel

- A **new** Tunnel-mode installation MUST use `./install.sh --cloudflare-tunnel`. An existing
  direct-Caddy deployment MUST instead use the in-place ingress-migration procedure in `DEPLOY.md`;
  it MUST NOT rerun the installer or replace the matching `.env` and data volume. The tracked
  overlay publishes only Caddy HTTP on `127.0.0.1:18080`; this deployment publishes no host ports
  80 or 443. On a shared host, any unrelated public listener requires its own recorded firewall and
  ownership assessment.
- The tunnel MUST be locally managed, dedicated to this application, run as an unprivileged
  service with a dedicated credential, and route the application hostname to
  `http://127.0.0.1:18080` with that hostname as `httpHostHeader`.
- The installer prepares and validates **only the application-side loopback origin and persisted
  Compose overlay**. It does not sign in to Cloudflare, create or select an account, create a
  tunnel, issue/store its credential, create the runtime service, or change DNS. Those are
  separate human-approved actions in the customer's Cloudflare account.
- The tunnel MUST reach Caddy, never the application container directly. Public TLS terminates at
  Cloudflare; Caddy remains the security-header, streaming, and authenticated proxy boundary to
  the application.

An implementation partner MUST NOT reuse or modify a tunnel that carries unrelated applications
without an explicit customer-approved architecture exception; that exception is outside this
standard deployment profile.

## 5. Network and time prerequisites

The host MUST have working DNS resolution and synchronized time before installation and throughout
operation. Clock synchronization is required for TLS validation, session expiry, rate windows, and
trustworthy audit timestamps. Use the cloud time service, chrony, or
systemd-timesyncd and monitor loss of synchronization.

Permit only the egress the selected features require:

- DNS to the approved resolver and time synchronization to the approved time source;
- outbound HTTPS for image/source retrieval, configured model-provider APIs, and public-page
  fetches requested by an administrator while drafting an assistant;
- the configured SMTP relay port when SMTP is enabled;
- ACME traffic from Caddy in direct mode;
- in Tunnel mode, the outbound Cloudflare Tunnel transport required by the recorded,
  change-controlled `cloudflared` version and configuration (commonly TCP/UDP 7844, plus DNS and
  HTTPS control traffic).

Provider and SMTP destinations are customer configuration and SHOULD be narrowed
by hostname/IP policy where the surrounding network can maintain those allowlists. SSH or other
operator ingress MUST be restricted independently; it is not an application port.

## 6. Credential and responsibility boundary

- The customer owns and supplies every API-provider credential. Provider credentials are entered
  after installation through the administrator console, not placed in `.env`.
- The customer owns its domain, DNS, cloud account, SMTP destination, Cloudflare account and tunnel
  credential, and provider terms/licensing decisions.
- The installer creates the application secrets in a mode-600 `.env`. That file and the matching
  data volume form one recovery set. `AUDIT_KEY` is required to verify historical audit rows;
  provider current/previous keys are required to open stored provider credentials.
- An implementation partner may operate these resources only under the customer's explicit
  authorization and MUST transfer credentials through an approved secret channel. One-time
  bootstrap passwords MUST not be copied into tickets, documentation, command arguments, or Git.

## 7. Backup and recovery baseline

Before production use and before every upgrade, the operator MUST create a consistent offline
backup using [`DEPLOY.md`](DEPLOY.md#backup-and-restore). The recovery set MUST contain:

- the complete `/data` volume, including the SQLite database, `-wal`/`-shm` sidecars when present,
  and uploads;
- the matching complete mode-600 `.env`;
- checksums for both artifacts.

Backups MUST be encrypted, access-controlled, copied off the application host, and governed by the
customer's retention policy. Before hand-off, a restore MUST be exercised on a non-production host
and must pass database `quick_check`, readiness, the external HTTPS smoke test, an authenticated
page fetch, audit-chain verification, one retained attachment check when attachments exist, and
one configured provider check without replacing its credential when a provider is configured.

## 8. Acceptance gates

An installation is accepted only when evidence for every applicable gate is recorded:

1. **Platform:** Linux architecture, Docker/Compose, OpenSSL, time synchronization,
   the two independent free-space checks, and the selected ports pass preflight.
2. **Ingress:** DNS and public HTTPS resolve to the selected boundary; the project owns exactly one
   application container and one Caddy container on its local bridge network, and only Caddy is
   exposed. In Tunnel mode, the dedicated service is healthy, Caddy is bound only to
   `127.0.0.1:18080`, and this deployment publishes no public 80/443. Record and assess any
   unrelated shared-host listeners separately.
3. **Application health:** `/api/health` returns HTTP 200 with `"db":"ok"`.
4. **Readiness:** `/api/v1/health/ready` returns HTTP 200 with `schema`, `integrity`, and `chain`
   all `ok: true`.
5. **Schema:** the applied migration count exactly equals the source migration count.
6. **External boundary:** `scripts/smoke.sh https://<domain>` reports exactly eight `PASS:` lines
   and `smoke: all checks passed`; production acceptance MUST NOT use `--insecure`.
7. **Authentication and authorization:** the bootstrap owner can sign in, `/api/v1/auth/me`
   reports the intended workspace role, and `/admin` returns HTTP 200.
8. **Audit:** `/api/v1/audit/integrity` returns `valid: true` with `checkedRows` greater than zero.
9. **Recovery:** the backup set is complete and checksummed, an off-host copy exists, and the
   non-production restore exercise above is recorded.
10. **Sizing:** representative load-test inputs, results, bottlenecks, and the approved CPU, RAM,
    disk, retention, and concurrency envelope are recorded. Passing on 2 vCPU/4 GB establishes
    installability, not production capacity for every customer workload.

The hand-off MUST include the release/commit identity, login URL, owner email (but no
password), ingress choice, deployment directory, Compose project identity, Docker root, volume
names, capacity plan, backup location/retention owner, configured external dependencies, and the
acceptance evidence. Any failed or skipped gate is an explicit exception, not a successful install.

Run `scripts/verify-install.sh https://<domain> <owner-email>` to collect gates 3–8 plus
the Compose boundary, image identity, mode-600 environment, and restart checks without putting the
password in a command argument. For release/installer qualification on a disposable host,
`scripts/clean-install-e2e.sh` additionally proves a history-free clean install, safe retry
rejection, and the documented backup/restore path. Neither script replaces the workload-specific
capacity decision or production off-host backup ownership.

## 9. Explicitly unsupported in v0.1.x

The following require a different architecture and are not partner-selectable deployment variants:

- high availability, failover clustering, multiple active application replicas, or horizontal
  scaling;
- Kubernetes, Nomad, Swarm, or another orchestrator as a substitute for the shipped single-host
  Compose topology;
- Cloudflare Workers, Vercel, functions, or another edge/serverless runtime as the application
  host;
- SQLite or its WAL on NFS, SMB/CIFS, distributed/shared filesystems, FUSE object-store mounts, or
  object storage used as a database;
- replacing SQLite with PostgreSQL, a managed database, or another database without a separately
  engineered and qualified product version;
- exposing the Node application port directly or bypassing Caddy;
- treating the 10 GiB installation floor or 2 vCPU/4 GB starting point as an unconditional
  production sizing guarantee.

Customer-managed front doors may sit in front of the supported VM boundary only as documented in
[`cloud/front-door.md`](cloud/front-door.md). Exceptions need a reviewed design, test plan, and
support agreement; they do not become part of the v0.1.x standard merely because one test system
appears to start.
