# Cloudflare, Vercel, and other front doors

This page is subordinate to the normative
[`Supported Deployment Standard`](../SUPPORTED-DEPLOYMENT.md). A front door does not change the
single-host, local-filesystem, one-application-process support boundary.

Cloudflare and Vercel can provide DNS, CDN, and TLS in front of the VM. Neither can run the
application itself. Control AI Chat requires a long-lived Node process, background workers,
in-memory policy state, and a file-backed SQLite database with its WAL sidecars.

Use the VM and Caddy as the origin. Two supported boundaries are described in
[`docs/DEPLOY.md`](../DEPLOY.md#putting-cloudflare-or-another-proxy-in-front): public Caddy with
Full (strict) origin TLS, or a dedicated locally managed Cloudflare Tunnel with Caddy published
only on host loopback. The Tunnel path is selected with `install.sh --cloudflare-tunnel`; its
persisted Compose marker prevents later commands from silently reopening public 80/443.

That installer option prepares and validates only the application-side Caddy origin at
`127.0.0.1:18080`. It does not authenticate to Cloudflare, create or select an account, create a
tunnel, issue/store its credential, install the `cloudflared` service, or change DNS. The customer
must approve those actions and the account/credential boundary before a partner performs them.

For a public Caddy origin, apply all three proxy settings:

1. Set origin TLS to **Full (strict)** so the outer proxy validates Caddy's certificate.
2. Disable buffering for `text/event-stream` so chat events stream immediately.
3. Permit long-running responses. The normal first-byte timeout is cleared because `run.status`
   is emitted before the model is called.

Restrict origin ingress to the proxy's published networks only if you also retain a safe path for
ACME validation and operational access.

For the dedicated Tunnel path, create a separate tunnel credential and runtime service rather than
editing a tunnel shared by other applications. Route it to `http://127.0.0.1:18080` with the
application hostname as `httpHostHeader`. Do not route directly to the app container: Caddy owns
the authenticated client-IP assertion, security headers, and streaming transport boundary.

The host needs synchronized time plus approved DNS/HTTPS egress and the Cloudflare Tunnel
transport required by its recorded, change-controlled configuration (commonly TCP/UDP 7844).
Confirm this deployment publishes only loopback TCP 18080, assess unrelated shared-host listeners
separately, and complete every
[acceptance gate](../SUPPORTED-DEPLOYMENT.md#8-acceptance-gates) before hand-off.
