# Project Privacy Notice

This notice describes the public Control AI Chat project and this release (v0.1.x). It is not an operator's privacy notice.

## The maintainers do not receive deployment data

The maintainers publish source code. They do not operate a Control AI Chat service, host deployments, provide a relay, or receive prompts, uploaded files, conversations, account data, audit records, or configuration from an operator's deployment. There is no project account to which a deployment reports.

Each operator installs the software on its own server and determines what personal data to collect, which model endpoints to configure, who may use the deployment, and how long data is retained. The operator is responsible for its own privacy notice, lawful basis, contracts, security, rights handling, retention, and other legal obligations.

## Verified outbound connections

The running application in this release makes outbound connections only for:

* chat and assistant-drafting requests to AI model endpoints configured by the operator;
* an HTTP(S) page that an administrator expressly submits when asking the software to draft a policy from a web page, with private- and special-network, DNS, redirect, size, port, and timeout safeguards; the fetched text may then be included in a configured model request; and
* the operator's SMTP relay, when configured, to send account-setup and password-reset mail to the user's own address.

Without an SMTP relay, the application sends no mail and does not offer self-service password reset on the sign-in page.

The installer performs no public-address lookup. Building or installing dependencies may contact the package and container registries configured for the operator's tooling.

The source review found no project telemetry, remote product-usage analytics, crash reporting, or automatic update check. Code named analytics performs local administrative reporting over the deployment's own SQLite database and does not send those reports to the maintainers. Operators should review the release they actually deploy and any local modifications.

## Data sent to connected services

Prompts, extractable text from permitted uploads, conversation context, assistant instructions, or fetched web-page text may be sent to the selected model endpoint as needed for the requested operation. When SMTP is configured, account mail to the user's address contains the workspace name, a one-time link and an expiry shown in the user's language and the workspace time zone, with the zone named. The admin console also formats displayed dates in that zone and names it. SQLite data and uploaded files otherwise remain on the operator's server. Each external recipient processes data under the operator's arrangement with that recipient.

## Account setup, recovery, and privileged access

Mail is sent in three cases: an invitation setup link; a reset link created for a user by an Owner or Admin; and a reset link that the user requests through “Forgot password?”. Setup links last 7 days, Owner/Admin reset links 24 hours, and self-service reset links 1 hour. Each link is single use. A new link supersedes the user's open link of the same kind, and self-service mail is sent at most once every 5 minutes per user.

The server stores only the token's SHA-256 hash. It does not put the token in application logs or audit events. Credential-link rows (the user, purpose, issuer, timestamps and token hash) are kept indefinitely: the release has no path that deletes them, and deprovisioning a user does not remove them. “Forgot password?” gives the same response whether the address exists. If it matches, the final audit log records `identity.password_reset_requested`, including the verified client IP address and user agent. Sign-in, forgot-password and reset are each limited to 30 requests per minute per verified client address. A reset ends all of the user's sessions; changing a password ends the user's other sessions. An operator with shell access can print a one-time link with `issue-password-link`; issuance is audited with a system actor.

Only the Owner can assign the Compliance reviewer role. An Owner may create a reset link for anyone except themselves; an Admin may create one only for a Member. Any account action—suspension, re-enablement, deprovisioning, forced sign-out, role change, or setup/reset link—requires the actor to hold every permission held by the target. Thus the Owner manages everyone else; an Admin manages Members and other Admins; only the Owner manages a Compliance reviewer's account; and nobody can suspend, remove, demote, or issue a link for the Owner. Only the Owner can sign out the Owner's sessions. Both permission matrices withhold legal-hold management from Admins; the governance matrix also withholds audit-transcript reading, and the relevant routes check those permissions. This keeps Admins from releasing legal holds or reading audit transcripts.

The setup or reset link is also displayed to its issuer. An Owner or Admin who resets a Member could therefore set that Member's password and read the Member's conversations. When SMTP is configured the Member receives the reset mail; completing the reset ends every existing session; and the audit log records link issuance and password completion. Enable TOTP for Compliance reviewers and Admins. A password reset does not remove TOTP, so the link alone cannot sign in to an account that uses it.

## Browser storage and third-party content

The web app's Content-Security-Policy limits scripts, styles, fonts, images, and connections to the deployment's own origin, except that images may also use data: and blob: sources. Fonts are bundled; the web app loads no third-party browser resource.

The server sets two strictly necessary authentication cookies: __Host-session for the access session (10 minutes) and __Host-refresh for refresh and rotation (up to 30 days). Both use Path=/, HttpOnly, Secure, and SameSite=Lax; logout expires both immediately.

The web app writes four user-preference keys to localStorage: app.appearance.v2 (color mode, density, and update time), app.locale.v1 (language), app.chat.effort (reasoning-effort choice), and app.metadata (whether message metadata is shown). None of these cookies or keys is used for tracking or analytics.

## Project interactions

Issues, pull requests, discussions, commits, and other activity on the source-hosting platform are governed by that platform's [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Public contributions and DCO sign-offs form part of the public project record.

Private security reports are used only to handle and fix the reported security issue, including receiving, assessing, reproducing, coordinating, remedying, and disclosing it. Do not include personal data or secrets beyond what is necessary. See [SECURITY.md](SECURITY.md).
