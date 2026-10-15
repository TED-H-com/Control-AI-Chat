# AI Chat Incident-Response Runbook

> Starting point only—adapt it to the operator's facts and have qualified counsel review it before use.

**Incident lead:** [role/contact]\
**Legal/privacy lead:** [role/contact]\
**Security/forensics lead:** [role/contact]\
**24-hour escalation:** [method]

## 1. Activation and priorities

Activate for suspected unauthorized access, disclosure, acquisition, alteration or loss; wrong-provider transmission; credential exposure; control bypass; malicious prompt/file/output; improper approval; model/provider incident; audit-chain concern; retention failure; or regulated-data entry.

Priorities are safety, containment, evidence integrity, legally directed investigation, accurate notice, recovery, and learning. Do not describe an event as a legally defined “breach” until counsel applies the relevant law. Do not delay containment while debating terminology.

## 2. First hour

1. Open incident ID [format], record reporter, time zone, discovery time, facts, and assumptions.
2. Protect people from imminent harm. Contact emergency services when appropriate.
3. Preserve volatile evidence before changing systems where feasible.
4. Contain narrowly: revoke exposed keys/sessions; disable the affected account/model/assistant or configured SMTP route; isolate the host; pause approvals or uploads; block indicators. Avoid destroying evidence.
5. Notify incident, legal/privacy, and relevant sector leads through approved channels. Limit sensitive content in tickets and chat.
6. Identify whether law enforcement, insurer, regulator, customer, collective-bargaining, government-contract, or other immediate notice clauses apply.
7. Issue a preliminary legal hold if litigation, investigation, claims, or notice evidence is reasonably foreseeable.

## 3. Preserve evidence

Record who collected what, when, how, source, hash, transfer, storage, and access.

- [ ] Export relevant audit records in CSV, JSON, or NDJSON. Record filters, row count, export ID, built-in SHA-256 digest, export time, requester, and download location. In this release, exports exclude content, cap at 100,000 rows, and expire after 24 hours; retrieve promptly and segment documented queries if necessary.
- [ ] Run and preserve audit hash-chain verification results. A valid chain supports integrity but does not prove completeness outside the application's event coverage.
- [ ] Preserve the SQLite database and uploads directory using forensically appropriate snapshots/copies; hash copies.
- [ ] Preserve relevant conversation/message IDs, accepted file originals and extracted text, redaction placeholder counts, approval payloads, detector/policy versions, assistant/project configuration, users/groups/roles, sessions, credential-link records, provider/endpoint configuration, and configured SMTP relay details. `Control AI Chat` retains no redacted original or token mapping; a redacted value cannot be recovered from it, so an original needed for response must come from a source kept outside the product.
- [ ] Preserve host, reverse-proxy, network, identity, endpoint, database, backup, email, and provider-side logs.
- [ ] Record provider request IDs, model/version, account/tier, region, retention/training setting, support case, and legal notices.
- [ ] Capture system time and time-zone offsets. Do not edit originals; analyze copies.
- [ ] Document unavailable, overwritten, encrypted, or unlogged evidence and attempts to restore or replace it.

Audit searches and opening events that contain cleansed prompts create audit events. Preserve them. Opening an ordinary conversation is not logged, so use any additional access logs and owner/custodian forensic procedures authorized by counsel.

## 4. Triage matrix

| Question | Record |
|---|---|
| What happened, when, and how discovered? | [facts/source] |
| Was data only accessed, actually acquired, altered, lost, or transmitted? | [evidence/uncertainty] |
| Which people, states/countries, organizations and contracts are implicated? | [counts/list] |
| Which exact fields/data types and combinations? | [data map] |
| Was data encrypted? At rest/in transit? Was the key or token accessible? | [algorithm/key facts] |
| Which model/provider/subprocessor/region/person received it? | [details] |
| Was it used for training, abuse review, support, or another purpose? | [provider evidence] |
| Were PHI, customer information, education records, CUI, export-controlled data, credentials, trade secrets, privilege, biometrics, or children's data involved? | [analysis] |
| Can copies be deleted or access revoked? Has deletion been confirmed? | [actions] |
| Did detection, warning, approval or role controls operate as configured? | [test] |
| Is misuse likely; is there reliable evidence of no acquisition; is harm analysis allowed? | [jurisdiction-specific analysis] |

Use parallel workstreams for containment, forensics, legal/regulatory, provider coordination, affected-business owners, communications, and recovery. Keep a decision log.

## 5. State breach-notification method

Do not use a generic 50-state deadline chart as the legal analysis. For every affected individual:

1. identify residence and any state with an additional connection;
2. retrieve the statute version in force at discovery and during the response;
3. test the exact “personal/private information” elements and combinations;
4. test “breach,” including whether access, acquisition, or both triggers it;
5. analyze encryption/redaction and whether a key or means of reading data was compromised;
6. apply permitted risk-of-harm or inadvertent-access determinations and documentation rules;
7. allocate duties between data owner/licensee and maintainer/service provider;
8. calendar individual, Attorney General/regulator, consumer-reporting-agency, and media thresholds/deadlines from the correct trigger;
9. satisfy content, method, language, substitute-notice, law-enforcement-delay, and record-retention rules; and
10. overlay sector, contract, insurance, litigation, privilege and international duties. Use the shortest defensible deadline while each analysis continues.

### Confirmed examples—not a complete survey

**Florida, Fla. Stat. § 501.171.** Status: in force. Notice to the Department of Legal Affairs is required for a breach affecting 500 or more Florida individuals, as expeditiously as practicable and no later than 30 days after determination of the breach or reason to believe one occurred, subject to statutory delay/waiver. Individual notice is also due as expeditiously as practicable and no later than 30 days, subject to statutory exceptions. The definition excludes data encrypted, secured, or modified so it is unusable, but analyze key compromise and the actual text. [Official statute](https://leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.171.html).

**New York, N.Y. Gen. Bus. Law § 899-aa.** Status: in force. The law covers unauthorized access to or acquisition of computerized data compromising private information. Give affected-resident notice in the most expedient time possible, consistent with legitimate law-enforcement needs and measures to determine scope and restore integrity. Notify the Attorney General, Department of State and State Police; notify consumer-reporting agencies if more than 5,000 New York residents are notified. A documented no-likely-harm determination can avoid individual notice for an inadvertent authorized-person exposure; keep it five years and send it to the Attorney General within 10 days if more than 500 residents are affected. [New York Attorney General summary](https://ag.ny.gov/resources/organizations/data-breach-reporting/shield-act).

**California, Cal. Civ. Code § 1798.82.** Status: in force. A business owning or licensing covered computerized data must notify a California resident whose unencrypted personal information was, or is reasonably believed to have been, acquired by an unauthorized person, in the most expedient time possible and without unreasonable delay, subject to law-enforcement and restoration needs. A maintainer must notify the owner/licensee immediately after discovery. If a single breach notice goes to more than 500 California residents, submit a sample to the Attorney General. Confirm the current statutory text and required notice format for the event. [Official code](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1798.82.&lawCode=CIV).

## 6. HIPAA workstream

If unsecured PHI is involved, apply 45 C.F.R. §§ 164.400–414. Document whether an impermissible use/disclosure is presumed a breach and any four-factor low-probability-of-compromise assessment.

- Covered entity to individuals: without unreasonable delay and no later than 60 calendar days after discovery.
- Covered entity to HHS: for 500 or more individuals, without unreasonable delay and no later than 60 days; for fewer than 500, no later than 60 days after the end of the calendar year.
- Media: if more than 500 residents of a state or jurisdiction are affected, within the same outer 60-day period.
- Business associate to covered entity: without unreasonable delay and no later than 60 days, with available identities and notice information. Contract terms may be shorter.

[HHS Breach Notification Rule](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html).

## 7. GLBA / FTC Safeguards Rule workstream

For a financial institution covered by 16 C.F.R. Part 314, notify the FTC as soon as possible and no later than 30 days after discovering a “notification event” involving at least 500 consumers. A notification event is unauthorized acquisition of unencrypted customer information; encrypted information is treated as unencrypted if an unauthorized person accessed the key. Unauthorized access is presumed acquisition unless reliable evidence shows there has not been and could not reasonably have been acquisition. 16 C.F.R. §§ 314.2(m), 314.4(j). [FTC guidance](https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know).

Also analyze banking/insurance regulator rules, state GLBA analogues, customer notices, and service-provider contract duties.

## 8. Government-contract and export workstreams

- Review every affected contract and clause. DFARS 252.204-7012 defines “rapidly report” as within 72 hours of discovery for covered cyber incidents and requires preservation/protection of system images and monitoring/packet data for at least 90 days after the report.
- Notify the contracting officer or agency through the required secure channel; do not put controlled information in an ordinary ticket.
- For possible ITAR/EAR release, preserve recipients, citizenship/residency where lawfully available, location, technical classification, access method, end use, encryption/access-information facts, and licenses/exceptions. Contact export counsel immediately.

## 9. Communication and notification control

Counsel approves legal conclusions and notices. Use a single verified fact set. Clearly label known, estimated, and unknown facts; update recipients when material facts change. Coordinate law-enforcement delay in writing. Avoid unsupported assurances such as “no risk,” “fully secure,” or “no data left the organization.” Preserve every notice version, recipient list, send proof, regulator confirmation, and decision not to notify.

## 10. Recovery and closure

- [ ] Eradicate root cause; rotate keys; patch; correct roles/policies/endpoints; test restoration.
- [ ] Validate audit chain and core workflows after recovery.
- [ ] Reconcile provider deletion, backup, downstream copies, and configured SMTP mail and logs.
- [ ] Re-run detector and access tests, including false-negative and bypass cases.
- [ ] Lift containment in approved stages with monitoring.
- [ ] Complete cause/contributing-factor review without blaming the reporter.
- [ ] Track corrective actions, owner, due date, evidence and residual-risk approval.
- [ ] Update notices, training, provider terms, retention, and this runbook.
- [ ] Release legal holds only on written counsel authorization.
- [ ] Close with executive, legal/privacy, security, records, sector and business approval.
