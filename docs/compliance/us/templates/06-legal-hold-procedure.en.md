# Legal-Hold Procedure for `Control AI Chat`

> Starting point only—adapt it to the operator's facts and have qualified counsel review it before use.

**Procedure owner:** [legal / records role]\
**Technical owner:** [role]\
**Effective date / version:** [date/version]

## 1. Purpose

This procedure preserves potentially relevant electronically stored information (ESI) when litigation, an investigation, audit, claim, subpoena, or other proceeding is pending or reasonably anticipated. A hold suspends ordinary deletion only for the defined scope; it does not authorize broader access, collection, or disclosure.

Fed. R. Civ. P. 37(e) addresses ESI that should have been preserved in anticipation or conduct of litigation, is lost because reasonable preservation steps were not taken, and cannot be restored or replaced through additional discovery. If prejudice exists, a court may order measures no greater than necessary to cure it; presumptions, adverse-inference instructions, dismissal, or default under Rule 37(e)(2) require intent to deprive. [Current Federal Rules of Civil Procedure](https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure). State, agency, criminal, contractual, and professional rules may differ.

## 2. Trigger and authority

Anyone receiving or learning of a complaint, demand, credible threat, incident, investigation, audit, subpoena, preservation request, or reasonably foreseeable dispute shall notify [legal contact] immediately and shall not delete or alter related material.

Only [General Counsel / authorized delegate] may direct issuance or release of a legal hold. In `Control AI Chat`, Owners and Compliance reviewers can place and release holds. Admins cannot because both permission matrices withhold legal-hold management and the hold routes check that permission, so the role that configures retention cannot release the hold that stops deletion. Anyone with audit-read access can list holds. Keep policy authorization narrower than the software permission where appropriate.

## 3. Issue a hold

### 3.1 Define and document

Open hold ID [format] and record:

- matter, trigger, issue date, counsel, privilege/confidentiality marking;
- claims/issues, relevant period, jurisdictions and preservation standard;
- custodians, departments, projects, conversations, assistants, models/providers and data sources;
- search terms only as aids, not substitutes for custodian/source analysis;
- `Control AI Chat` scope selected and limitations;
- external sources: provider records, email, reverse proxy, identity, endpoint, database, uploads, backups, tickets, exports and personal devices/accounts where authorized;
- preservation method, collection method, review access, and release criteria.

### 3.2 Choose `Control AI Chat` scope

Use the narrowest scope that fully preserves the matter; combine holds where needed:

- **Entire workspace:** keeps all data covered by the application's hold logic.
- **User:** keeps conversations the person owns, files the person uploaded, and stored audit transcripts about the person. A suspended or removed user can still be held.
- **Conversation:** keeps its messages, attached files, and stored audit transcripts from that conversation.
- **Project:** keeps its conversations, files, and stored audit transcripts from that project.
- **Date range:** keeps every conversation active at any point in the range, files uploaded in the range, and stored audit transcripts recorded in the range. Both dates are included as whole days in the workspace time zone shown by the form.

Each scope also keeps corresponding terminal approval content. All held data remains stored after its ordinary retention period ends. Audit-event metadata is never purged online, so a hold changes nothing for that metadata. Provider, backup, host, exported, device, and SMTP mail copies remain outside an application hold and require separate preservation.

### 3.3 Apply and verify

1. An authorized Owner or Compliance reviewer selects the scope, target and, for a date-range hold, the inclusive dates shown in the form's workspace time zone.
2. The authorized person enters the required reason. The hold record stores the reason; the placement audit-event metadata stores only its length, not its text.
3. A second authorized person compares the saved hold with counsel's instruction.
4. Verify the placement audit event and preserve an audit export showing hold creation and relevant records. Record export filter, ID, SHA-256, row count, date/time and custodian.
5. Snapshot/collect the SQLite database and uploads when proportional; preserve configuration and provider evidence.
6. Run a controlled retention test against nonproduction or test records where feasible; never wait for scheduled deletion to discover scope error.
7. Record limitations, remediation and counsel acceptance.

## 4. Custodian notice

Send a written notice that states:

- the duty to preserve and effective date;
- subject matter and date range in understandable terms;
- sources and data types, including `Control AI Chat` conversations, prompts, outputs, assistants, projects, files, approvals, audit transcripts, audit events, exports, local copies, screenshots, email, provider/support records and devices; redacted originals are not stored by `Control AI Chat` and cannot be recovered from it, so a user who needs an original must keep it outside the product;
- suspension of deletion, editing, overwriting, account closure, key destruction, or unapproved migration;
- no instruction to create new substantive records or broadly copy sensitive material;
- how to identify additional custodians/sources and report loss;
- confidentiality, contact, acknowledgment deadline, reminder cadence and release-only-in-writing rule.

**Acknowledgment:** “I received this legal-hold notice, understand the preservation instructions, have disclosed relevant sources/custodians known to me, and will comply until written release.”

Track delivery, acknowledgment, follow-up, departures, role changes and exceptions. Interview key custodians. Coordinate with HR so accounts and devices are not deprovisioned or wiped before preservation.

## 5. Ongoing management

Review [quarterly] and on each material event. Confirm:

- custodians, claims, periods and data sources remain accurate;
- holds remain active and retention jobs have not deleted scoped records;
- backups remain available and restoration is tested;
- provider retention/deletion, legal demands, model changes and email flows are preserved;
- encryption keys needed to read held material remain protected and available;
- access remains least-privileged and audited;
- new deletion/privacy requests, incidents, migrations and employee departures are reconciled; and
- over-preservation is reduced when counsel can narrow scope.

The application does not edit an active hold's scope. Document every policy-level change, approver, time, reason, release and replacement hold, before/after scope, verification, and notice update.

## 6. Privacy deletion requests and schedule conflicts

On receiving a deletion request or scheduled-purge event that overlaps a hold:

1. authenticate and log the request without changing held records;
2. map each record to hold and non-hold purposes;
3. have counsel identify the applicable exception or preservation duty;
4. delete segregable non-held material where required and technically feasible;
5. restrict held material from ordinary use, access, and new purposes;
6. respond without revealing privileged strategy, stating the lawful extent of completion or retention as counsel approves;
7. preserve the request, analysis, decision, scope and eventual disposition; and
8. revisit the retained material when the hold is narrowed or released.

A hold is not a reason to retain unrelated information. Multiple holds must be checked before any release.

## 7. Collection and production

Collection is separate from preservation. Counsel defines proportional collection. Maintain chain of custody and hashes. Record software version, database schema, time zone, export filters, row cap, omitted content, and unsuccessful queries. The application's CSV/JSON/NDJSON audit export contains metadata rather than conversation content; collect messages/files through an authorized, documented method. Validate completeness against database counts and other logs.

Apply privilege, confidentiality, personal-data, protective-order, trade-secret, export-control and CUI review before disclosure. Redaction tokens are not recovery references: `Control AI Chat` keeps no original or mapping and has no restore or reveal feature. If an original is needed, it must come from a source kept outside the product.

## 8. Release

Only counsel may issue a written release after checking all overlapping matters, appeals, regulator requirements, contractual duties and limitation periods.

1. Record the release basis, scope, date and approver after checking overlapping holds.
2. An authorized Owner or Compliance reviewer enters the required release reason. Admins cannot release the hold.
3. Verify the release audit event. Its metadata records the release reason's length, not its text; update the hold register with the authorized reason and disposition.
4. Notify custodians and technical/records owners. Explain that held data returns to the normal deletion schedule, not necessarily immediate manual deletion.
5. Reconcile external holds on providers, backups, endpoints, email, forensic copies and exports.
6. Apply the ordinary schedule and outstanding valid privacy requests in a controlled cycle.
7. Preserve the hold file: trigger, notices, acknowledgments, scope, modifications, tests, collections, decisions and release.

## 9. Hold register

| Hold ID | Matter / counsel | Trigger and issue date | Scope | Custodians | Systems / external copies | Last review | Status / release |
|---|---|---|---|---|---|---|---|
| [ID] | [details] | [details] | [details] | [details] | [details] | [date] | [status] |
