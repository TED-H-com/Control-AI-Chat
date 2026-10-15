# United States Operator Compliance Guide

> General information as of September 28, 2026. This guide is not legal advice and does not create a lawyer-client relationship. Laws and official guidance change. Consult qualified counsel in every relevant jurisdiction before relying on this guide. Report suspected errors to the project maintainers through the project's public issue channel without including personal or confidential information.

## 1. Purpose, product boundaries, and roles

This guide is for an organization that installs and operates `Control AI Chat` on its own server. The maintainers publish MIT-licensed source code. They do not operate a service, host an instance, choose recipients, or receive deployment data. The operator decides why and how the system is used, what is collected, which provider or locally hosted model receives content, who may review records, and how long records are kept.

`Control AI Chat` stores its SQLite database and upload directory on the operator's server. The operator must provide backups, tested restoration, disk encryption, host hardening, TLS termination, network controls, patching, and physical security. Provider API keys are encrypted at rest with AES-256-GCM under an environment-supplied key; key custody and rotation remain operator duties.

The operator may use an external AI-provider account or a compatible model endpoint on infrastructure it controls. A locally controlled model can keep prompts within the operator's infrastructure, but the administrator-requested web fetch, SMTP account mail, backups, logs, and administrator workflows must also be controlled as intended.

Depending on the facts, the operator may be an employer, a CCPA “business,” a HIPAA covered entity or business associate, a GLBA financial institution, an educational institution, or a government contractor. A hosted AI provider may be a CCPA service provider or contractor, another regime's processor, or a HIPAA business associate only if the legal definition and contract requirements are actually met. A label in a contract is not enough.

## 2. What the software does—and does not do

- Send-time checks inspect prompts and extracted upload text before model transmission, and the same gate inspects model responses. Accepted uploads are plain text, CSV, Markdown, PDF, DOCX, XLSX, and PPTX. Images are refused, and a PDF without a text layer fails extraction, so its content is not sent. There is no OCR.
- Pattern-based detectors cover the product's PII category keys (including Taiwan and Japan identifiers, phone, address, and date formats), credentials, prompt injection, source code, keywords, Protected terms, classification labels, semantic classification, and institution names. They miss content and generate false positives. They are one layer of an operator's program, not proof of compliance.
- Actions are, from weakest to strongest: Allow, Flag, Redact, Substitute (code action `mask`), Warn, Block, and Require approval. The strongest matching action wins. Redact replaces each match with a token and keeps no original or token mapping in memory or in the database. Its audit metadata records the number of inserted placeholders and no mapping ID. There is no restore or reveal feature. A user who needs the original must keep it outside `Control AI Chat`. Substitute is also irreversible. Approval payloads are encrypted while held.
- Four roles separate administration from review. Admins configure policy but cannot decide approvals, export audit evidence, read audit transcripts, place or release legal holds, or assign the Compliance reviewer role. Only the Owner can assign that role. The tenant and governance matrices both exclude approval decision, audit export, and legal-hold management from Admins; the governance matrix also excludes transcript reading and Compliance-role assignment, and the relevant routes check their required permission. Compliance reviewers can perform review and hold tasks but cannot change policy. Owners retain broad authority. Anyone with audit-read access can list holds. Groups constrain model access, and budgets can cap usage.
- The append-only audit log uses a hash chain. Export formats are CSV, JSON, and NDJSON; exports omit content, are capped at 100,000 rows, include a SHA-256 digest, and expire after 24 hours. Searching the audit log records `admin.audit_searched`; opening an event that contains a cleansed prompt records `admin.transcript_viewed`. Opening an ordinary conversation is not logged.
- Conversations, messages, and files use a 1-to-3,650-day organization setting (90-day default); violation transcripts are fixed at 365 days and terminal approval content at 30 days. Audit events remain online indefinitely and can be deleted only by the operator offline.
- Runtime outbound connections are limited to configured model endpoints, a protected webpage fetch an administrator expressly requests to draft a policy, and—when configured—the operator's SMTP relay for account mail to the user's own address. No telemetry, external analytics, crash reporting, or update check was found in this release.

### 2.1 Account setup, recovery, and privileged access

With SMTP configured, the application sends a user's own address an invitation setup link, an Owner/Admin-created reset link, or a self-service link requested through “Forgot password?”. Each message contains the workspace name, the one-time link, and its expiry in the user's language and the workspace time zone, with the zone named. The admin console also formats displayed dates in that zone and names it. Without SMTP, no mail is sent and the sign-in page offers no self-service reset. Setup links last 7 days, Owner/Admin reset links 24 hours, and self-service reset links 1 hour. Each is single use; a new link supersedes the user's open link of the same kind; and self-service mail is sent at most once every 5 minutes per user.

The server stores only the token's SHA-256 hash and does not put the token in application logs or audit events. Credential-link rows (the user, purpose, issuer, timestamps and token hash) are kept indefinitely: the release has no path that deletes them, and deprovisioning a user does not remove them. Cover them in the offline deletion procedure. Forgot-password gives the same answer whether the address exists; if it matches, the final audit log records `identity.password_reset_requested` with the verified client IP address and user agent. Sign-in, forgot-password, and reset are each limited to 30 requests per minute per verified client address. A reset ends all of the user's sessions; an ordinary password change ends the user's other sessions. An operator with shell access can print a one-time link with `issue-password-link`, audited with a system actor.

An Owner can create a reset link for anyone except themselves. An Admin can create one only for a Member. Any account action—suspension, re-enablement, deprovisioning, forced sign-out, role change, or setup/reset link—requires the actor to hold every permission held by the target. The Owner therefore manages everyone else; an Admin manages Members and other Admins; only the Owner manages a Compliance reviewer's account; and nobody can suspend, remove, demote, or issue a link for the Owner. Only the Owner can sign out the Owner's sessions.

The setup or reset link also appears on the issuer's screen. An Owner or Admin who resets a Member could set the Member's password and read the Member's conversations. The Member receives reset mail when SMTP is configured, reset completion ends all existing sessions, and the audit log records both link issuance and password completion. Enable TOTP for Compliance reviewers and Admins. A reset does not remove TOTP, so the link alone cannot sign in to an account that uses it.

## 3. Law map

This is a deployment triage map, not an exhaustive list.

| Instrument | Status on 2026-09-28 | Enforcement / owner | Why it may matter |
|---|---|---|---|
| FTC Act § 5, 15 U.S.C. § 45 | In force | Federal Trade Commission; state and private routes vary by other law | Deceptive statements about AI, privacy, accuracy, security, or retention and unfair data practices can create exposure. |
| Electronic Communications Privacy Act, 18 U.S.C. §§ 2510–2523, and Stored Communications Act, 18 U.S.C. §§ 2701–2713 | In force | DOJ and statutory civil remedies | Interception, access, consent, provider, and ordinary-course questions make workforce monitoring fact-specific. |
| Executive Order 14179 | In force; signed January 23, 2025; published January 31, 2025 | Executive branch | Directs federal AI policy and revoked Executive Order 14110; it does not regulate an ordinary private deployment by itself. [90 Fed. Reg. 8,741](https://www.federalregister.gov/documents/2025/01/31/2025-02172/removing-barriers-to-american-leadership-in-artificial-intelligence) |
| OMB Memoranda M-25-21 and M-25-22 | Binding executive-branch policy dated April 3, 2025, not generally applicable private-sector law | OMB and federal agencies | Relevant to federal agency use and acquisition, and potentially contract requirements. [M-25-21](https://www.whitehouse.gov/wp-content/uploads/2025/02/M-25-21-Accelerating-Federal-Use-of-AI-through-Innovation-Governance-and-Public-Trust.pdf); [M-25-22](https://www.whitehouse.gov/wp-content/uploads/2025/02/M-25-22-Driving-Efficient-Acquisition-of-Artificial-Intelligence-in-Government.pdf) |
| Executive Order 14365 | In force; signed December 11, 2025; published December 16, 2025 | Executive branch | Directs federal work toward a national AI framework. It does not itself preempt state law. [90 Fed. Reg. 58,499](https://www.federalregister.gov/documents/2025/12/16/2025-23092/ensuring-a-national-policy-framework-for-artificial-intelligence) |
| FTC proposed AI accuracy policy statement | Proposed, non-binding as of the stated date | FTC | Would address AI-output accuracy representations; do not treat it as final policy. [FTC proposal](https://www.ftc.gov/system/files/ftc_gov/pdf/ai-policy-statement_0.pdf) |
| California Consumer Privacy Act (CCPA), Cal. Civ. Code §§ 1798.100–1798.199.100 | In force; workforce/B2B exemptions expired December 31, 2022 | California Privacy Protection Agency and Attorney General | Covers workforce personal information when the operator meets the statutory definition of business; requires notices, rights handling, security, contracts, and purpose/retention discipline. [CPPA FAQ](https://cppa.ca.gov/faq) |
| California 2025 CCPA regulations | Effective January 1, 2026; duties phased | CPPA and Attorney General | Risk-assessment compliance began January 1, 2026; ADMT significant-decision duties begin January 1, 2027; first submissions/audit certifications phase from 2028. [CPPA finalization notice](https://cppa.ca.gov/announcements/2025/20250923.html) |
| New York Civil Rights Law § 52-c | In force | New York Attorney General | Prior notice, acknowledgment for new hires, and conspicuous posting for covered electronic monitoring. [Official enactment](https://www.nysenate.gov/legislation/bills/2021/A430) |
| Conn. Gen. Stat. § 31-48d | In force | Connecticut Labor Commissioner | Prior written notice of monitoring types; conspicuous posting constitutes notice, subject to a misconduct exception. [Official statute](https://www.cga.ct.gov/current/pub/chap_557.htm#sec_31-48d) |
| Del. Code tit. 19, § 705 | In force | Delaware Department of Labor | Daily electronic notice or one-time written/electronic notice acknowledged by the employee. [Official statute](https://delcode.delaware.gov/title19/c007/sc01/index.html#705) |
| Colorado Artificial Intelligence Act, as replaced by S.B. 26-189 | Enacted May 14, 2026; operative January 1, 2027; proposed rules pending | Colorado Attorney General exclusively | Applies to covered automated decisionmaking materially influencing consequential decisions. Internal general-purpose chat is not automatically covered; employment-decision use can be. [S.B. 26-189](https://www.leg.colorado.gov/bills/SB26-189); [Attorney General status page](https://coag.gov/ai/) |
| Illinois Human Rights Act, 775 ILCS 5/2-102(L) | In force January 1, 2026 | Illinois Department of Human Rights / Human Rights Commission | Prohibits discriminatory-effect AI use and ZIP-code proxies in specified employment decisions and requires notice. [Official statute](https://ilga.gov/legislation/ILCS/details?ActID=2266&ActName=Illinois+Human+Rights+Act.&ChapAct=775+ILCS+5%2F&Chapter=&ChapterID=64&MajorTopic=&SeqEnd=1800000&SeqStart=600000) |
| Illinois proposed 56 Ill. Admin. Code 2520 amendments | Proposed, non-binding; final adoption not confirmed | Illinois Department of Human Rights / JCAR | Would specify notices and records. Latest official source found still calls it proposed. [JCAR Flinn Report](https://ilga.gov/documents/commission/jcar/flinn/20260515_May%2015%2C%202026%20-%20Issue%2020.pdf) |
| New York City Local Law 144 | In force; effective January 1, 2023; enforced since July 5, 2023 | NYC Department of Consumer and Worker Protection | AEDTs used in hiring/promotion need a recent independent bias audit, published summary, and advance notices. [Official page](https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page) |
| California Fair Employment and Housing Act automated-decision regulations | In force October 1, 2025 | California Civil Rights Department | Clarify that automated systems can produce unlawful employment discrimination; require specified records for four years. [Approval notice](https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2025/06/Notice-of-Approval-regulations-automated-employment-decision-systems.pdf) |
| Title VII, ADA, and federal employment regulations | In force | EEOC; DOJ in specified ADA matters; private claimants | AI-assisted decisions can create disparate-treatment, disparate-impact, accessibility, accommodation, and medical-inquiry exposure. |
| Utah Artificial Intelligence Policy Act, as amended | In force; current repeal date July 1, 2027 | Utah Division of Consumer Protection / relevant regulators | Consumer disclosure obligations are context-specific; ordinary internal staff use generally is not a consumer transaction. [S.B. 226](https://le.utah.gov/Session/2025/bills/enrolled/SB0226.pdf); [S.B. 332](https://le.utah.gov/Session/2025/bills/enrolled/SB0332.pdf) |
| Texas Responsible Artificial Intelligence Governance Act, H.B. 149 | In force January 1, 2026 | Texas Attorney General exclusively, plus licensing agencies after a violation | Broad deployer prohibitions apply; disclosure rules principally target government agencies and health-care providers. [Enrolled H.B. 149](https://capitol.texas.gov/tlodocs/89R/billtext/html/HB00149F.HTM) |
| Colorado H.B. 26-1263, Conversational Artificial Intelligence Service Operator Requirements | Enacted and effective August 12, 2026; principal duties begin January 1, 2027 | Colorado Attorney General | Applies to operators of covered services accessible to the general public; a staff-only deployment generally falls outside that definition. [Official bill page](https://www.leg.colorado.gov/bills/hb26-1263) |
| California S.B. 53, Transparency in Frontier Artificial Intelligence Act | In force January 1, 2026 | California Attorney General and other specified state mechanisms | Focuses on developers of frontier models and large frontier developers, not ordinary downstream chat operators. [Official bill record](https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260SB53) |
| HIPAA Privacy, Security, and Breach Notification Rules | In force | HHS Office for Civil Rights; DOJ for criminal provisions | PHI workflows can require minimum necessary controls, a BAA, security safeguards, and breach notices. |
| GLBA Safeguards Rule, 16 C.F.R. Part 314 | In force | FTC and other functional regulators within their jurisdictions | Covered financial institutions must govern service providers and report qualifying 500-consumer notification events within 30 days. |
| FERPA, 20 U.S.C. § 1232g and 34 C.F.R. Part 99 | In force | U.S. Department of Education | Schools need consent or an exception, direct control, purpose/redisclosure restrictions, and legitimate-interest access controls. |
| DTSA, 18 U.S.C. §§ 1833, 1836, 1839 | In force | Private civil litigants; DOJ for federal crimes | Reasonable secrecy measures and the whistleblower-immunity notice affect trade-secret protection and remedies. |
| FAR 52.204-21 and DFARS 252.204-7012 | In force/current clauses; applicable when incorporated or prescribed | Contracting agencies and contractual remedies | Federal/defense information can trigger safeguarding, reporting, preservation, and flow-down duties. |
| EAR and ITAR | In force | Commerce Department BIS; State Department DDTC; DOJ | Prompts/files can transmit or release controlled technology or technical data to foreign destinations/persons. |
| Fed. R. Civ. P. 37(e) | In force; current Civil Rules last amended in 2025 | Federal courts | Governs remedial measures when ESI that should have been preserved is lost. |
| NIST CSF 2.0; AI RMF 1.0; NIST AI 600-1 | Voluntary, non-binding frameworks | NIST | Useful for documenting cybersecurity and AI-risk outcomes; not certifications or legal safe harbors by themselves. [CSF 2.0](https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20); [AI RMF](https://www.nist.gov/itl/ai-risk-management-framework); [GenAI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) |

## 4. Pre-deployment checklist

1. **Name accountable owners.** Assign executive, privacy, security, HR, legal, records, export-control, and sector-regulatory owners. Keep policy administration separate from approval and audit review where staffing permits.
2. **Map use cases and people.** Identify jurisdictions, workforce groups, data categories, model endpoints, administrators, reviewers, recipients, and any consequential-decision use. Prohibit employment-decision use pending counsel and impact review.
3. **Classify data before configuration.** Include PHI, account data, SSNs, student records, trade secrets, CUI, export-controlled technical data, privileged material, and contractual confidentiality.
4. **Choose architecture and providers.** For each model, decide local versus hosted processing. Complete the [provider checklist](templates/04-ai-provider-due-diligence.en.md), including training use, retention, subprocessors, location, deletion, security evidence, incident terms, and sector contracts.
5. **Establish lawful monitoring.** Determine federal and state interception/access rules; issue the [monitoring notice](templates/02-electronic-monitoring-notice.en.md), secure required acknowledgments, and post where required before monitoring begins.
6. **Publish privacy notices.** Determine CCPA applicability and use the [workforce addendum](templates/03-ccpa-workforce-notice-addendum.en.md) where appropriate. Coordinate applicant, contractor, customer, and sector notices.
7. **Configure least privilege.** Limit owner accounts, separate administrators and compliance reviewers, require MFA for privileged roles, constrain models by group, and periodically review sessions and accounts.
8. **Set controls and test them.** Begin with the settings in Section 15. Test true positives, misses, false positives, precedence, irreversible Redact token replacement, file extraction and rejection, approval releases, and bypass paths. Treat detectors as fallible.
9. **Set retention and legal holds.** Document each record class, business/legal purpose, deletion period, backup treatment, and exception. Reconcile legal holds with deletion requests using the [legal-hold procedure](templates/06-legal-hold-procedure.en.md).
10. **Train users and reviewers.** Adopt the [acceptable-use policy](templates/01-workforce-ai-acceptable-use-policy.en.md), teach prohibited inputs and human review, and rehearse escalation.
11. **Prepare response and evidence.** Complete the [incident runbook](templates/05-incident-response-runbook.en.md); test audit export, hash-chain verification, evidence custody, notices, and restoration.
12. **Review periodically and on change.** Reassess when adding a model, provider, use case, detector, jurisdiction, data class, or consequential-decision workflow.

## 5. Federal baseline

### 5.1 FTC Act

The United States has no single generally applicable federal privacy statute equivalent to a comprehensive national privacy code. Sector and state laws overlap. Section 5 of the FTC Act prohibits unfair or deceptive acts or practices. Align public and workforce statements with actual operation: do not overstate detector accuracy, confidentiality, deletion, “zero retention,” local processing, human review, or security. The FTC has warned AI companies to honor privacy and confidentiality commitments and has enforced unsupported AI-accuracy claims. [FTC confidentiality statement](https://www.ftc.gov/policy/advocacy-research/tech-at-ftc/2024/01/ai-companies-uphold-your-privacy-confidentiality-commitments); [FTC AI enforcement collection](https://www.ftc.gov/industry/technology/artificial-intelligence).

### 5.2 Electronic communications

Under 18 U.S.C. § 2511(2)(d), interception is generally not unlawful where a party has given prior consent, unless done to commit a criminal or tortious act. The “ordinary course of business” equipment exclusion in 18 U.S.C. § 2510(5)(a) and Stored Communications Act provider/user-authorization exceptions in 18 U.S.C. § 2701(c) are fact-dependent. They are not blanket employer permissions. Whether inspection occurs contemporaneously or after storage, who provides the service, whose account is used, and the scope of consent matter. Use explicit advance notice and acknowledgment, narrow review to stated purposes, restrict reviewers, and obtain state-specific advice. [18 U.S.C. § 2510](https://uscode.house.gov/view.xhtml?req=%28title%3A18+section%3A2510%29); [§ 2511](https://uscode.house.gov/view.xhtml?req=%28title%3A18+section%3A2511%29); [§ 2701](https://uscode.house.gov/view.xhtml?req=%28title%3A18+section%3A2701%29).

### 5.3 Federal AI policy and preemption

Executive Orders 14179 and 14365 direct executive-branch policy. OMB M-25-21 and M-25-22 govern federal agency use/acquisition and may flow into procurement, but do not generally bind private operators outside those relationships. Executive Order 14365 directs federal agencies to pursue a national framework and challenge certain state laws; it does not itself displace state statutes. DOJ established the directed AI Litigation Task Force on January 9, 2026. [Attorney General memorandum](https://www.justice.gov/ag/media/1422986/dl). The FTC's July 2026 policy statement remained proposed in the official materials reviewed. No comprehensive congressional AI preemption statute was confirmed as enacted by the status date. Continue state-by-state analysis.

## 6. State comprehensive privacy laws

### 6.1 California

The CCPA's employee/applicant/independent-contractor and B2B exemptions expired December 31, 2022, so covered workforce and B2B personal information has been within scope since January 1, 2023. The law generally covers a for-profit entity doing business in California that meets a statutory route; the current monetary route is at least $26.625 million in preceding-year gross annual revenue, alongside separate 100,000-consumer/household and 50%-revenue routes. Confirm affiliates and exceptions. Use the [workforce notice addendum](templates/03-ccpa-workforce-notice-addendum.en.md).

The CPPA adopted the cybersecurity-audit, risk-assessment, ADMT, insurance, and update regulations on July 24, 2025; the Office of Administrative Law approved and filed them September 22, 2025; they became effective January 1, 2026. Risk-assessment compliance began then, with initial attestation and summary information due April 1, 2028. ADMT requirements for significant decisions begin January 1, 2027. First cybersecurity-audit certifications are due April 1, 2028, 2029, or 2030 based on the specified revenue bands. Determine whether the operator's processing meets each triggering threshold; self-hosting does not remove the duties.

### 6.2 Other comprehensive statutes

Do not assume every state law treats workforce data like California. For example, the Virginia Consumer Data Protection Act defines “consumer” to exclude a person acting in a commercial or employment context and separately exempts specified workforce data. Va. Code §§ 59.1-575–576. The Texas Data Privacy and Security Act likewise excludes an individual acting in a commercial or employment context from “consumer.” Tex. Bus. & Com. Code § 541.001(7). [Virginia code](https://law.lis.virginia.gov/vacodefull/title59.1/chapter53/); [Texas code](https://statutes.capitol.texas.gov/Docs/BC/pdf/BC.541.pdf). Analyze non-workforce data separately; users may paste customer or other covered data into workforce chats.

## 7. Workforce monitoring

Provide notice before enabling inspection and retain evidence of delivery and acknowledgment.

- **New York:** for employees hired on or after May 7, 2022, written or electronic notice upon hiring and written/electronic acknowledgment; conspicuous posting. The notice must advise that telephone, email, and internet access or usage may be monitored at any and all times and by any lawful means. The transition deadline for then-existing employees has passed.
- **Connecticut:** prior written notice of the monitoring types; a conspicuous posting constitutes notice. Section 31-48d permits monitoring without prior notice on reasonable grounds to believe an employee is violating law, violating legal rights, or creating a hostile workplace, when monitoring may produce evidence. Counsel should control use of the exception.
- **Delaware:** either an electronic notice each day monitoring occurs, acknowledged by the employee, or a one-time written/electronic notice acknowledged by the employee. The statute has a narrow maintenance/protection exception where monitoring is not targeted at a particular individual.

Use the [combined notice](templates/02-electronic-monitoring-notice.en.md), but local counsel must assess labor agreements, state constitutional/privacy torts, recording law, biometric law, off-duty conduct, and special categories. In `Control AI Chat`, grant reviewers only the records needed for review and document purpose. Audit searches and opening events with cleansed prompts are recorded; opening an ordinary conversation is not. Do not promise a complete conversation-view trail.

## 8. AI in employment decisions

Do not use chat output to hire, reject, promote, set pay, schedule, discipline, terminate, or otherwise make consequential employment decisions without a documented legal, HR, privacy, accessibility, validation, and bias review. A human rubber stamp does not necessarily remove automated-decision risk.

- **Colorado:** S.B. 26-189 replaced the earlier framework in 2026. Beginning January 1, 2027, it regulates developers and deployers of covered automated decisionmaking systems that make or materially influence consequential decisions. It includes notices, records, post-adverse information within 30 days, access/correction, and human-review mechanisms, with Attorney General enforcement. Proposed rules filed August 11, 2026 remained pending on the status date. A pre-replacement federal court stay and related litigation status require counsel review.
- **Illinois:** 775 ILCS 5/2-102(L), effective January 1, 2026, prohibits using AI in listed employment activities when it has the effect of discrimination on a protected class or uses ZIP codes as a proxy, and requires employee notice. The statute is in force even though the implementing rules located were proposed.
- **New York City:** an employer or employment agency may not use an automated employment decision tool in the city unless it had an independent bias audit within the preceding year, posted the audit summary and distribution data, and gave required notices at least 10 business days before use. 6 RCNY § 5-300 et seq. Counsel should determine whether a chat-assisted workflow “substantially assists or replaces” discretionary decisionmaking.
- **California:** effective October 1, 2025, Civil Rights Council regulations clarify FEHA coverage of automated-decision systems and require covered records, including data bearing on adverse impact, to be retained for at least four years. The employer remains responsible for discriminatory selection criteria and agent conduct.
- **Federal:** Title VII recognizes disparate-impact claims and a business-necessity defense framework, 42 U.S.C. § 2000e-2(k). The ADA prohibits discrimination and limits disability-related inquiries and medical examinations, 42 U.S.C. § 12112. Validate job relatedness, accessibility and accommodations; test outcomes; preserve versions and input variables; and provide meaningful human escalation. [Title VII](https://uscode.house.gov/view.xhtml?req=%28title%3A42+section%3A2000e-2%29); [ADA](https://uscode.house.gov/view.xhtml?req=%28title%3A42+section%3A12112%29).

## 9. Other state AI statutes

### Utah

The Utah Artificial Intelligence Policy Act remains in force, with its current repeal date July 1, 2027. Under the 2025 amendment, a supplier using generative AI in a consumer transaction must disclose that use when the individual clearly and unambiguously asks; a person in a regulated occupation must make a prominent disclosure at the outset of a high-risk interaction. An internal staff chat ordinarily is neither interaction with a consumer nor provision of a regulated service, but a workflow used with clients or patients may be. Do not rely on the system interface alone for disclosures.

### Texas

H.B. 149 took effect January 1, 2026. Its subtitle reaches persons doing business, producing a service used by residents, or developing/deploying an AI system in Texas. It prohibits intentional AI-enabled incitement of self-harm, harm, or crime; intentional unlawful discrimination; and specified constitutional, biometric, and explicit-content conduct. General consumer-interaction disclosure is directed to government agencies; health-care providers have a first-service disclosure rule. The Attorney General has exclusive Chapter 552 authority, a 60-day cure process, and statutory civil-penalty ranges. An internal deployment is not exempt merely because it is internal, though many consumer-facing provisions will not fit.

### Colorado conversational AI services

Colorado H.B. 26-1263 became effective August 12, 2026, but its principal duties begin January 1, 2027. It addresses developers of an AI service that is accessible to the general public and offered to a consumer, including required disclosures and protocols concerning minors and self-harm content. A deployment technically limited to an operator's staff generally is not a service offered to consumers; reassess if clients, patients, students, or the public can use it. The operator ordinarily is a deployer, not the model/service developer targeted by the Act, but it should not assume that status if it offers or materially develops the service.

### Laws aimed at model developers

California S.B. 53 primarily regulates frontier developers and “large frontier developers,” not an organization merely deploying `Control AI Chat` with a third-party or local model. The operator should still assess whether it is training or materially modifying a model at the covered compute level. Do not import developer obligations into an ordinary deployment, and do not use downstream status to ignore other privacy, employment, sector, or contract duties.

## 10. Sector regimes

### HIPAA

If a hosted provider creates, receives, maintains, or transmits PHI for a covered entity or business associate, analyze business-associate status under 45 C.F.R. § 160.103 and obtain a compliant business associate agreement under §§ 164.502(e) and 164.504(e) before disclosure. A provider's general security terms or “no training” option is not a BAA. Apply minimum necessary rules. If no acceptable BAA is available, block PHI or use a properly controlled self-hosted model and confirm that every ancillary flow remains inside the approved boundary. [HHS business-associate guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html).

### GLBA Safeguards Rule

A covered financial institution must maintain a written information-security program. Under 16 C.F.R. § 314.4(f), it must select service providers capable of appropriate safeguards, contractually require them, and periodically assess them. Apply the [provider checklist](templates/04-ai-provider-due-diligence.en.md). Incident notice is addressed in Section 13.

### FERPA

Schools should not place personally identifiable information from education records into a hosted model without consent or a valid exception. For the school-official exception, the outside party must perform an outsourced institutional function, remain under the school's direct control for use and maintenance, meet annual-notice criteria, use data only for authorized purposes, and not redisclose without authority. Apply reasonable access controls so officials see only records in which they have legitimate educational interests. [Department of Education cloud guidance](https://studentprivacy.ed.gov/resources/cloud-computing-faq); [access-control FAQ](https://studentprivacy.ed.gov/faq/what-must-educational-agencies-or-institutions-do-ensure-only-school-officials-legitimate).

### Government contracts, CUI, and export controls

Read the contract before deployment. FAR 52.204-21 applies baseline safeguards when Federal Contract Information resides in or transits a covered contractor information system. DFARS 252.204-7012 can require NIST SP 800-171 controls, incident reporting within 72 hours, evidence preservation, and flow-downs for covered defense information. [FAR clause](https://www.acquisition.gov/far/52.204-21); [DFARS clause](https://www.acquisition.gov/dfars/252.204-7012-safeguarding-covered-defense-information-and-cyber-incident-reporting.).

Do not send ITAR technical data or EAR-controlled technology/source code to a provider, location, or person until export counsel classifies the item, parties, destination, end use, licenses, and exceptions. Under EAR §§ 734.13 and 734.15, electronic transmission abroad and release to a foreign person can be an export. [BIS Part 734](https://www.bis.gov/regulations/ear/734). The ITAR are codified at 22 C.F.R. Parts 120–130. [Current ITAR](https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M). A source-code detector can support routing but cannot classify export-controlled material.

## 11. Trade secrets and whistleblower notice

A federal trade secret requires reasonable measures to keep the information secret, 18 U.S.C. § 1839(3). Classification labels, protected-term lists, secret/source-code detectors, approvals, role separation, audit evidence, and provider restrictions can support—but do not establish—reasonable measures. Add contracts, access control, training, marking, need-to-know handling, exit procedures, and response.

The DTSA protects certain confidential disclosures to government officials or an attorney solely to report/investigate suspected legal violations, and sealed court filings. Under 18 U.S.C. § 1833(b)(3), an employer must give notice of that immunity in agreements with employees, contractors, or consultants governing trade secrets or confidential information, or cross-reference a policy containing the notice. For agreements entered or updated after May 11, 2016, omission prevents the employer from receiving DTSA exemplary damages or attorney fees against that individual. Use the notice in the [acceptable-use policy](templates/01-workforce-ai-acceptable-use-policy.en.md), and have counsel coordinate it with agreements. [18 U.S.C. ch. 90](https://uscode.house.gov/view.xhtml?edition=prelim&path=%2Fprelim%40title18%2Fpart1%2Fchapter90).

## 12. Security and AI-risk mapping

This mapping describes support, not conformity or certification.

| Framework outcome | `Control AI Chat` support | Operator must supply |
|---|---|---|
| CSF 2.0 **Govern** | Roles, separated policy/review permissions, policy records, budgets | Risk appetite, accountable leadership, legal inventory, supplier governance, policy approval |
| **Identify** | Audit search; model/group configuration; projects and assistants | Asset/data/flow inventory, classification, threat/risk assessments, dependency inventory |
| **Protect** | MFA option, lockout, sessions, encrypted provider keys, send-time actions, model restrictions | TLS, network/host/database/upload/backups encryption, patching, IAM lifecycle, endpoint protection |
| **Detect** | Pattern checks, flags, searchable hash-chained audit events | Monitoring, alerting, vulnerability detection, review of misses/false positives, log integration |
| **Respond** | Blocking/approval, account/session actions, audit export | Incident command, forensics, counsel, notification decisions, communications, exercises |
| **Recover** | Retained records and application data subject to operator backup | Backups, immutable/offline copies, restoration tests, continuity and post-incident improvement |
| AI RMF **Govern** | Roles, policies, approval routing, audit evidence | Use-case owner, risk thresholds, affected-stakeholder input, training, accountability |
| **Map** | Model/group/project context and configured rules | Intended use, people affected, data provenance, provider/locale context, misuse scenarios |
| **Measure** | Audit outcomes and configurable detectors | Quality, bias, privacy, security, accessibility, hallucination and human-override testing |
| **Manage** | Warn, Block, Redact, Substitute, or Require approval; local-model option | Decide avoid/mitigate/transfer/accept; residual-risk approval; monitoring and decommissioning |
| NIST AI 600-1 themes | Secret/PII/prompt-injection/source-code controls; approvals; records | Content provenance, confabulation testing, incident disclosure, misuse evaluation, supplier/model testing |

NIST describes these frameworks as voluntary and outcome-oriented. Maintain a current/target profile and evidence; do not describe configuration as “NIST compliant.”

## 13. Incidents and breach notification

Use the [incident-response runbook](templates/05-incident-response-runbook.en.md). Immediately preserve volatile facts, audit exports and hashes, relevant configuration, provider identifiers, affected files, access logs, sessions, and legal-hold decisions. Do not assume a detector match, a hash-chain result, or encryption automatically resolves legal notice.

Analyze every affected person's state, each statute's definition of personal/private information and breach, encryption plus key compromise, risk-of-harm exception, owner/maintainer allocation, content and timing, regulator/credit bureau/media thresholds, and sector/contract deadlines. HIPAA, GLBA/FTC, education, insurance, government-contract, and export reports can overlap.

## 14. Records, retention, and legal holds

Use purpose-based periods, not indefinite retention by habit. In this release, conversations, messages, and files default to 90 days and can be set from 1 through 3,650 days; stored violation transcripts are fixed at 365 days, terminal approval content at 30 days, and audit events remain online indefinitely unless the operator deletes them offline.

Owners and Compliance reviewers can place and release legal holds; Admins cannot because both permission matrices withhold legal-hold management and the hold routes check that permission. Thus the role that configures retention cannot release the hold that stops deletion. Anyone with audit-read access can list holds. Placement and release each require a reason and create an audit event. The event metadata records the reason's length, not its text.

The scopes work as follows: an entire-workspace hold keeps all hold-managed data; a user hold keeps conversations that person owns and files that person uploaded, and can still target a suspended or removed user; a conversation hold keeps its messages and attached files; a project hold keeps its conversations and files; and a date-range hold keeps every conversation active at any point in the range and files uploaded in it. Both dates are included as whole days in the workspace time zone shown by the form. Each scope also keeps corresponding terminal approval content and stored audit transcripts: those about the held user, those from the held conversation or project, or those recorded in the date range. Audit-event metadata is never purged online, so a hold does not change its treatment. Held data remains after its retention period ends and returns to the normal deletion schedule after release. Follow the [legal-hold procedure](templates/06-legal-hold-procedure.en.md).

Fed. R. Civ. P. 37(e) applies when ESI that should have been preserved in anticipation or conduct of litigation is lost because a party failed to take reasonable steps and it cannot be restored or replaced. Cure measures depend on prejudice; the most serious sanctions require intent to deprive. [Current Federal Rules](https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure). State law and agency matters may use different standards.

## 15. Recommended starting settings for the United States

These are starting points only. Tune them to data flows, false positives, sector rules, contracts, labor obligations, and provider architecture. Actions use the interface names. Block prevents model transmission but does not eliminate local retention or incident duties.

| Category key / detector | Product default (outbound; inbound) | Recommended starting action | Difference and rationale |
|---|---|---|---|
| `ssn_us`, `national_id`, `tw_national_id`, `tw_resident_id`, `jp_my_number` | Block; Redact | Block; Redact | Same as default; high identity-theft and unnecessary-transfer risk |
| `tw_business_id`, `jp_corporate_number` | Flag; no rule | Flag; no rule | Same as default; context can still be confidential |
| `email`, `phone`, `passport`, `date_of_birth`, `postal_address`, `ip_address`, `credit_card`, `iban` | Redact; Redact | Redact; Redact | Same as default; raise to Block for prohibited workflows |
| `drivers_license_us`, `jp_drivers_license`, `jp_residence_card`, `vin` | Redact; Redact | Redact; Redact | Same as default; breach-law and identity risks |
| `person_name` | No default rule | Warn or Redact by use case | Differs from default; test contextual false positives first |
| `secret` (all seeded categories) | Block; Block | Block; Block | Same as default; prevent credential disclosure |
| `classification` (`confidential`, `restricted`) | Block; Block | Block; Block | Same as default; enforce highest classifications |
| `keyword` (Protected terms) | Warn; Flag | Require approval; Flag | Stronger outbound recommendation for trade-secret review |
| `source_code` | Flag; Flag | Require approval; Flag | Stronger outbound recommendation for proprietary or controlled repositories |
| `injection` | Block; Block | Block; Block | Same as default; reduce instruction-hijacking risk |
| `semantic` | Disabled (disabled outbound Flag rule) | Keep disabled until risk and cost review | Same as default |
| `institution` (`medical_facility`, `educational_institution`) | Flag; no rule | Flag; no rule | Same as default; a match alone does not establish regulated content |

Health/PHI, student-record, employment-decision, export-control, and other sector concepts do not have complete dedicated structured categories. Add tested Protected terms and classification labels, then use Block or Require approval for the applicable workflow. A product match never replaces the required legal, contractual, or human review.

## 16. Templates and glossary

Templates:

- [Workforce AI acceptable-use policy](templates/01-workforce-ai-acceptable-use-policy.en.md)
- [Electronic-monitoring notice and acknowledgment](templates/02-electronic-monitoring-notice.en.md)
- [CCPA workforce notice-at-collection addendum](templates/03-ccpa-workforce-notice-addendum.en.md)
- [AI-provider due-diligence checklist](templates/04-ai-provider-due-diligence.en.md)
- [Incident-response runbook](templates/05-incident-response-runbook.en.md)
- [Legal-hold procedure](templates/06-legal-hold-procedure.en.md)

| English | 中文（台灣） | 日本語 |
|---|---|---|
| operator | 營運者 | 運用者 |
| personal information | 個人資料 | 個人情報 |
| sensitive personal information | 敏感性個人資料 | センシティブ個人情報 |
| workforce member | 工作人員 | 就業者 |
| legal hold | 法律保存 | リーガルホールド |
| audit log | 稽核紀錄 | 監査ログ |
| compliance reviewer | 法遵審查人員 | コンプライアンス審査担当者 |
| automated decisionmaking technology | 自動化決策技術 | 自動意思決定技術 |
| business associate agreement | 業務夥伴協議 | 事業提携者契約 |
| trade secret | 營業秘密 | 営業秘密 |

See [Sources](SOURCES.md).
