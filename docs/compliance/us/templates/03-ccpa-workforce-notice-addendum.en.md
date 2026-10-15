# CCPA Workforce Notice at Collection Addendum

> Starting point only—adapt it to the operator's facts and have qualified counsel review it before use.

**Business:** [legal name and contact information]\
**Effective date / version:** [date / version]\
**Applies to:** [employees, applicants, contractors, owners, directors, officers, medical staff, emergency contacts and beneficiaries who are California residents]

This addendum supplements [workforce privacy notice]. It describes personal information collected through the organization's self-hosted `Control AI Chat` deployment. The organization—not the source-code maintainers—operates the system, selects AI providers or locally hosted models, and determines purposes and retention.

## Notice at collection

Complete each row using actual data flows. Delete categories not collected; do not use “including” lists to conceal materially different practices.

| CCPA category / examples in this deployment | Business or commercial purposes | Retention period or criteria |
|---|---|---|
| **Identifiers:** name, work email, user ID, IP address, account/session identifiers; identifiers entered in prompts or files | Authenticate users; operate sessions; attribute conversations and audit events; security; policy enforcement; incident response; legal obligations | [period or objective criteria] |
| **Cal. Civ. Code § 1798.80(e) records:** signature, address, telephone number, account, medical or insurance information if entered | Provide the approved chat workflow; apply send-time controls; protect information; investigate and respond | [period/criteria; separately address approval payloads] |
| **Protected-class characteristics:** age/date of birth, disability/medical facts, sex, race, religion, or other traits if entered or inferable | [state authorized purpose; prohibit employment-decision use unless reviewed] | [period/criteria] |
| **Commercial information:** organization purchasing, product, customer, or transaction material entered in a prompt or upload | Respond to authorized business requests; project/assistant operation; records and security | [period/criteria] |
| **Internet or electronic-network activity:** log-in, session, model and provider use, administrator-requested webpage retrieval, event and security logs | Operate, secure, troubleshoot and audit the deployment; enforce policy; manage cost | [period/criteria] |
| **Geolocation:** approximate location inferable from IP address [and any other actual collection] | Security, fraud prevention, access administration [actual purposes] | [period/criteria] |
| **Electronic or visual information:** accepted uploaded documents | Process authorized inputs; text extraction; security and policy review | [period/criteria] |
| **Professional or employment-related information:** role, group, department, job content, performance or disciplinary facts entered into chats | Access control; approved work assistance; records; investigations [do not add employment-decision purpose without review] | [period/criteria] |
| **Education information:** records or qualifications entered in prompts/files | [authorized recruiting/training purpose, if any] | [period/criteria] |
| **Inferences:** classifications, detector matches, suspected content types, usage or risk inferences | Route Allow/Flag/Redact/Substitute/Warn/Block/Require approval actions; security and compliance review | [period/criteria] |
| **Sensitive personal information:** SSN, driver's-license/passport numbers, account credentials, precise geolocation, racial/ethnic origin, religious beliefs, union membership, message contents where the business is not intended recipient, genetic/biometric data for identification, health, sex life or sexual orientation, as actually collected | [minimize; specify approved purpose; generally block unnecessary entry] | [short period/criteria] |

The system also processes prompt text, AI output, assistant instructions, project material, file names and extracted text, detector results, confirmations, approvals, redaction placeholder counts, audit records, usage and budget information, and administrative actions. Redaction keeps no original or token mapping, and a redacted value cannot be recovered from `Control AI Chat`; a user who needs the original must keep it outside the product. These data may fall into one or more categories above.

## Sources and disclosures

Personal information is collected directly from workforce users; from administrators, managers, HR, security, legal, or other authorized personnel; from uploaded records; and automatically from system operation.

The business may disclose personal information for the stated purposes to:

- AI providers selected by the business, unless the workflow uses a model wholly hosted within the business-controlled boundary;
- infrastructure, backup, and security recipients configured by the business, plus the configured SMTP relay and the workforce user's own address for account setup and password recovery;
- authorized owners, administrators, compliance reviewers, security, HR, legal, records, audit, and management personnel according to role and need;
- professional advisers, auditors, regulators, courts, law enforcement, and transaction parties where authorized or required; and
- [other actual categories].

The source-code maintainers do not host this deployment and do not receive deployment data merely because the business uses the software.

## Sale, sharing, and sensitive-personal-information use

The business [does / does not] sell workforce personal information as “sale” is defined by the CCPA. The business [does / does not] share workforce personal information for cross-context behavioral advertising as “sharing” is defined by the CCPA.

If either answer is “does,” identify the categories, recipients, purposes, opt-out methods, and required links: [details]. Do not state “does not” merely because no money changes hands.

The business [does / does not] use or disclose sensitive personal information outside the purposes permitted without a right to limit under Cal. Civ. Code § 1798.121 and 11 C.C.R. § 7027(m). If it does, provide a “Limit the Use of My Sensitive Personal Information” method or an applicable alternative: [link/method].

## Rights and requests

Subject to exceptions and verification, California residents may have rights to know/access, correct, delete, opt out of sale/sharing, limit certain sensitive-personal-information use, receive portable information, and receive equal treatment for exercising CCPA rights. Submit requests through:

- Web: [URL]
- Toll-free number: [number, if required]
- Email / workforce channel: [address/channel]

Authorized-agent process: [process]. Verification process: [process proportionate to the request]. Appeals or questions: [contact]. The business will not retaliate for exercise of CCPA rights.

## Retention and deletion

The business does not retain a category longer than reasonably necessary and proportionate to the disclosed purposes, subject to legal obligations, security needs, disputes, and legal holds. Document actual production settings. In this release, conversations, messages, and files default to 90 days and can be set from 1 through 3,650 days; violation transcripts are fixed at 365 days, terminal approval content at 30 days, and audit events remain online indefinitely. Do not copy those periods into this notice unless they match the live deployment and the business can justify them.

Legal holds may suspend deletion. A conversation-scoped hold protects the conversation's messages and attached files. Backups, exports, provider copies, and account mail through the configured SMTP relay require separate periods and deletion procedures. Credential-link rows (the user, purpose, issuer, timestamps and token hash) have no deletion path in this release and are kept indefinitely, including after a user is deprovisioned.

## Automated decisionmaking

`Control AI Chat` is approved for [describe assistance]. It [is not / is] used to make a significant decision concerning workforce members. If it is used for a significant decision, add the notices, access/opt-out procedures and exceptions required by 11 C.C.R. §§ 7220–7231 by January 1, 2027, and coordinate employment-law requirements. Do not characterize routine send-time content controls as employment evaluation unless that is their actual use.

## When this addendum is needed

The CCPA generally applies to a for-profit entity doing business in California that meets at least one statutory route, including current thresholds of at least $26.625 million in preceding-year gross annual revenue, buying/selling/sharing personal information of 100,000 or more California residents or households, or deriving at least 50% of annual revenue from selling or sharing California residents' personal information. Controlled entities and joint ventures can also be covered; nonprofits and government agencies generally are not. Confirm statutory exceptions and annual threshold adjustments. [CPPA FAQ](https://cppa.ca.gov/faq).

The workforce and B2B exemptions expired December 31, 2022. Covered businesses have applied the CCPA to those records since January 1, 2023. A notice at collection must be available at or before collection and include categories, purposes, sale/sharing information, retention period or criteria, and required privacy-policy/rights links. 11 C.C.R. § 7012. Provider contracts should be assessed under 11 C.C.R. § 7051. [Current statute and regulations](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf).

## Change record

| Date | Change | New collection/purpose/recipient? | Notice timing and approver |
|---|---|---|---|
| [date] | [description] | [yes/no] | [details] |
