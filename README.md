# Control AI Chat

[Project website](https://ted-h-com.github.io/Control-AI-Chat/?lang=en) · [繁體中文介紹](https://ted-h-com.github.io/Control-AI-Chat/?lang=zh-TW)

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

Governed AI chat that runs on your own infrastructure, using your own model credentials.

Your employees get one workspace for the supported model catalog. Your company controls which
configured models each group may use, what they cost, and what auditors see. Application content
stays on your infrastructure except for the outbound connections the selected features require:
configured model-provider API requests; SMTP delivery of setup and reset links to the user's own
address; a public-page fetch when an administrator asks the application to draft an assistant from
a URL; Caddy's ACME traffic in standard mode; and Cloudflare Tunnel traffic in Tunnel mode.

> **Bring your own model-provider credentials. They are encrypted in the deployment database and
> the API never returns them in full.**

## What it does

Every prompt is inspected before it reaches a provider, and every response is inspected before it
reaches the user.

```
browser → pre-flight gate → budget reservation → provider → post-flight gate → user
              │                    │                            │
              └────────────────────┴──── audit log (hash-chained) ┘
```

- **The gate** detects personal identifiers such as email addresses, phone numbers, payment card
  numbers, and national ID numbers; secrets such as API keys and private keys; source code;
  explicit classification headers such as `RESTRICTED` and `CONFIDENTIAL`; and prompt injection.
  It then applies an action: `Allow` → `Flag` → `Redact` → `Substitute` → `Warn` → `Block` →
  `Require approval`. Redaction is one-way: context-preserving placeholders continue to the
  provider and remain in the response; originals are not rehydrated.
- **The audit log** is append-only and hash-chained, so tampering is detectable rather than merely
  discouraged. Owners and compliance reviewers can export it as CSV, JSON, or NDJSON files. There
  is no external hash anchor, so an attacker who can rewrite the entire database and recompute the
  chain is outside that guarantee.
- **The budget engine** reserves spend before a provider call and settles actual usage afterward,
  including when the user closes the tab mid-answer. A settlement above its reservation is recorded
  for reconciliation rather than hidden.
- **Access control** is per group, over both models and providers, so a team can be given Anthropic
  but not OpenAI, or inexpensive models but not expensive ones.
- **Model access** uses APIs only. Built-in providers are OpenAI, Anthropic, Google, xAI, Venice,
  OpenRouter, and NVIDIA; administrators may also set a validated public HTTPS base URL.
- **Uploads** extract text from PDF, DOCX, XLSX, PPTX, plain-text, CSV, and Markdown files. Extracted
  text passes through the gate before it reaches a model.
- **Retention** runs in bounded hourly batches until each workspace's backlog is clear. Conversation
  titles, message text, and uploaded file content past the workspace window are destroyed, while
  their rows, timestamps, and audit events remain. On the Retention screen, an owner or compliance
  reviewer can place or release a legal hold for the whole workspace, a user, a conversation and its
  attached files, a project, or a date range in the workspace time zone. Administrators cannot place
  or release legal holds. Holds are re-checked inside the destructive statement, so a hold placed at
  the last moment still wins.

## Accounts and recovery

Sign-in uses local accounts: a password, optional TOTP multi-factor authentication, and lockout after
repeated failures.

- An owner or administrator creates a user on the Users screen. The console displays a one-time
  setup link that lasts seven days and emails it when SMTP is configured. The invitee sets a password
  on `/setup` and then signs in.
- An owner can create a 24-hour reset link for anyone else. An administrator can create one only for
  a member. Nobody can create their own link.
- When SMTP is configured, the sign-in page offers **Forgot password?** It gives the same response
  whether or not the address exists and sends an active user a one-hour reset link at most once per
  five minutes.
- Every setup or reset link is single-use. A new link replaces the user's open link of the same kind,
  and the server stores only a SHA-256 hash of its token. A reset ends all of the user's sessions;
  changing a password while signed in ends the user's other sessions.
- Only the owner can assign the compliance-reviewer role. The owner can manage every other account;
  an administrator can manage members and other administrators. Only the owner can suspend, remove,
  sign out, change the role of, or send a link to a compliance reviewer. Nobody can suspend, remove,
  change the role of, or send a link to the owner. Every user, including the owner, can sign out their
  own sessions, and nobody else can sign out the owner.

## What you need

- One Linux `amd64` or `arm64` host you control. Ubuntu Server 24.04 LTS is the reference OS.
  2 vCPU and 4 GB RAM is the supported starting point, not a universal capacity guarantee; size and
  load-test it for your concurrency and upload/extraction volume.
- At least 10 GiB free on both the checkout and Docker-root filesystems as an installation floor,
  followed by a documented capacity plan for database/WAL growth, uploads, images, temporary work,
  and off-host backups. SQLite and its WAL must stay on a real local filesystem.
- A domain name routed to it. **HTTPS is required**, not recommended: session cookies are issued
  with the `Secure` attribute and the `__Host-` prefix, so nobody can sign in over plain HTTP.
  Standard Caddy obtains a certificate automatically; the dedicated Cloudflare Tunnel mode uses
  Cloudflare edge TLS and keeps Caddy on host loopback.
- Synchronized host time and an exact clean release checkout, or a history-free source archive.
- Docker with the Compose plugin. Direct Caddy requires free host TCP 80/443 and UDP 443 mappings.
  Dedicated Tunnel mode requires Engine 28.0.0+, Compose 2.24.4+, Python 3, and free loopback TCP
  18080.
- At least one API-provider credential of your own.
- [Supported Deployment Standard](docs/SUPPORTED-DEPLOYMENT.md), the normative v0.1.x baseline and
  customer/implementation-partner acceptance checklist.
- [Message Dispatch and Routing Architecture](docs/DISPATCH.md) for developers.
- [Deployment guide](docs/DEPLOY.md) for installation, upgrades, backup, and operations.
- Cloud recipes for [Azure](docs/cloud/azure.md), [AWS](docs/cloud/aws.md),
  [Google Cloud](docs/cloud/gcp.md), [Oracle Cloud](docs/cloud/oracle.md), and
  [front-door proxies](docs/cloud/front-door.md).

Cloudflare and Vercel can sit in front of this as DNS, CDN, or TLS. A tracked
`install.sh --cloudflare-tunnel` mode is available when a dedicated locally managed Tunnel is the
safer front door for a shared VM. The installer prepares only the loopback app origin; the
customer-approved Cloudflare account, tunnel credential, service, and DNS remain manual. Cloudflare
and Vercel cannot **host** the application itself: the application keeps a file-backed database,
runs background workers on timers in a long-lived process, and holds decrypted policy state in
memory—none of which exists on an edge or serverless runtime.

## Repository layout

| Path | Contents |
|---|---|
| `server/` | API, gate, audit, providers, governance, identity |
| `web/` | Chat application and admin console |
| `infra/` | Reverse-proxy configuration |
| `scripts/` | Safe Compose operations, smoke/acceptance verification, and release qualification |

## Legal and project policies

[MIT License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[Privacy](PRIVACY.md) · [Disclaimer](DISCLAIMER.md) · [Trademarks](TRADEMARKS.md) ·
[Export notice](EXPORT.md) · [Compliance guides](docs/compliance/)

## Security posture

- Provider credentials are sealed with AES-256-GCM and bound to both the workspace and the
  provider, so a stolen ciphertext cannot be replayed into another slot. The full credential is
  never returned over HTTP; the console shows only the last four characters.
- The key protecting provider credentials is deliberately separate from the key rooting the audit
  chain, so you can rotate a leaked provider-credential key without destroying your audit history.
- Stored provider credentials are sealed under versioned keys. If an enabled credential uses a key
  version absent from the configured environment, the application refuses to start, so mistaken key
  removal fails closed instead of silently making stored credentials unreadable.
- Before removing an old key, an operator can run
  `scripts/compose.sh exec -T app npm run check-key-coverage`. It reads the database without writing
  and lists stored provider-key versions: exit 0 means every listed version is held, exit 1 means a
  stored version is missing from the configured keys, and exit 2 means the database or configuration
  could not be checked.
- The `PROVIDER_CREDENTIAL_KEY` rotation documented in
  [the deployment guide](docs/DEPLOY.md) can be rehearsed end to end with
  `scripts/rotation-rehearsal.sh` against a disposable install of committed `HEAD`, including the
  early-removal startup refusal and recovery from it.
- User- or model-generated code is never executed; code blocks are rendered as code. Attachments
  reach the model only as gate-checked extracted text.
- **We hold no certifications.** This software implements controls that support your compliance
  programme. It does not make you SOC 2, HIPAA, or ISO certified, and we will never claim it does.
