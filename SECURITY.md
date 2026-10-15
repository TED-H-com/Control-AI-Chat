# Security Policy

## Supported versions

Only the latest release line receives security fixes. Older releases and unreleased development snapshots are not supported. Upgrade to the latest release before reporting a problem that may already have been fixed.

## Report a vulnerability privately

Use GitHub private vulnerability reporting for <https://github.com/TED-H-com/Control-AI-Chat>: open the repository's **Security** tab, choose **Report a vulnerability**, and submit the private advisory form. Do not disclose the issue in a public issue, discussion, pull request, or other public channel.

Include, where possible:

* the affected version or commit;
* the affected component and deployment assumptions;
* clear reproduction steps or a minimal proof of concept;
* the observed and expected result;
* the security impact and any prerequisites;
* relevant logs with secrets and personal data removed; and
* whether anyone else has been told about the issue.

Do not include live credentials, access tokens, personal data, or data taken from a system you were not authorized to test.

## Scope

This policy covers security vulnerabilities in the code in this repository. An operator's server, network, identity systems, deployment configuration, policies, keys, backups, and other operational choices are outside the maintainers' testing scope. Third-party AI-provider services, other third-party services, and vulnerabilities in an operator's separately deployed infrastructure are also out of scope; report those to their respective owners.

Do not test a deployment that you do not own or lack explicit permission to test. Do not degrade service, access more data than needed to demonstrate the issue, retain data, alter data, or attempt social engineering or physical intrusion.

## What to expect

Maintainers will make a best-effort attempt to acknowledge the report, assess it, keep the reporter informed when practical, and develop and publish a fix when warranted. Timing depends on severity, complexity, maintainer availability, and coordination with affected dependencies. This policy makes no response or remediation deadline.

Please allow a reasonable opportunity to investigate and coordinate a release before public disclosure. The maintainers will seek to agree on disclosure timing and credit with the reporter, but may publish sooner when necessary to protect users or later when a safe fix requires more work.

## Good-faith research

The maintainers will not pursue action against research performed in good faith on the project's own code when the researcher follows this policy, avoids harm, respects privacy, and gives the project a reasonable opportunity to address the report. This statement does not authorize access to or testing of anyone else's deployment, account, data, network, service, or property, and it cannot bind third parties or law-enforcement authorities.

## No bug bounty

The project does not operate a bug-bounty or paid-reward program. Submitting a report does not create a right to payment.

## Known security boundaries

TOTP codes are accepted for the current 30-second step and one step on either side. Accepted TOTP steps are not stored, so a code that remains within that window can satisfy a new sign-in challenge. Recovery codes and signed MFA sign-in challenges are single use. Replacing an authenticator requires a recently MFA-verified session. Disabling MFA does not end the user's other sessions.

Public sign-in is limited to 30 attempts per fixed minute per verified client address. Forgot-password and password-reset requests each have their own limiter with the same limit; they do not share the sign-in bucket. Each limiter is bounded to 10,000 address entries in process memory; once it is full, further addresses share one overflow bucket until the minute ends. Each limiter resets when the process restarts and gives users behind one NAT a shared bucket. A separate per-account boundary locks the account for 15 minutes beginning with the fifth failed password or MFA attempt.

The hash-chained audit log is not an external timestamp or an independently anchored ledger.

The software confers no compliance certification.
