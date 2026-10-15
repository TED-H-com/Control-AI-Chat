# AI Provider Due-Diligence and Contract Checklist

> Starting point only—adapt it to the operator's facts and have qualified counsel review it before use.

**Provider / model / endpoint:** [name]\
**Review owner and date:** [name/date]\
**Approved data and use cases:** [scope]\
**Prohibited data and use cases:** [scope]\
**Renewal / re-review date:** [date]

The operator supplies its own provider account or local endpoint. The source-code maintainers are not the provider, do not negotiate these terms, and do not receive deployment data. Complete this checklist for each endpoint and material model version.

## 1. Processing and model training

- [ ] Map every payload: prompts, system/saved instructions, uploads or extracted text, metadata, outputs, feedback, abuse-monitoring content, and support tickets.
- [ ] Confirm by product tier and API—not marketing generally—whether inputs, outputs, embeddings, metadata, or feedback are used to train, fine-tune, evaluate, moderate, or improve any model/service.
- [ ] Record the default and opt-out mechanism; who can change it; whether it applies retroactively; and evidence of the selected setting.
- [ ] Prohibit training or secondary use unless specifically approved. Define permitted processing narrowly and forbid sale, cross-context advertising, profiling, reidentification, and combining data outside agreed purposes.
- [ ] Confirm whether humans may review content, for what triggers, from what locations, under what access controls, and for how long.
- [ ] Determine whether provider filters or abuse systems retain content despite “zero retention.” Resolve contradictions in the contract, data-processing addendum, product documentation, console, and support response.

## 2. Retention and deletion

- [ ] Record each retention clock for content, metadata, security/abuse logs, backups, legal holds, and support data.
- [ ] Test any zero-retention or modified-monitoring option and retain proof of activation.
- [ ] Require deletion/return on request and termination, including backups on a defined cycle, with written certification where appropriate.
- [ ] Identify legal-compulsion and security exceptions; require narrow use, segregation, and notice when lawful.
- [ ] Align provider periods with the operator's notice and schedule. `Control AI Chat` deletion cannot delete copies held by a provider.

## 3. Subprocessors, location, and transfers

- [ ] Obtain a current subprocessor list with function and processing/storage location.
- [ ] Require advance notice of additions, a meaningful objection/remedy, and equivalent written duties.
- [ ] Identify remote support and human-review locations, not only primary storage regions.
- [ ] Confirm routing/failover does not move data to an unapproved region or endpoint.
- [ ] Evaluate export controls, government-contract restrictions, localization terms, and cross-border privacy mechanisms.

## 4. Security and assurance

- [ ] Obtain current independent reports/certifications relevant to the exact service and boundary; record period, scope, exceptions, complementary user-entity controls, and remediation.
- [ ] Review encryption in transit/at rest, tenant isolation, key management, privileged access, MFA, secure development, vulnerability management, penetration testing, logging, backup, recovery, and deletion.
- [ ] Require prompt remediation of critical findings and a right to receive material changes.
- [ ] Confirm API authentication and rotation. `Control AI Chat` encrypts provider keys at rest under an operator-supplied environment key; the operator must protect and rotate both layers.
- [ ] Review resilience, model/version change notice, deprecation, rate limits, incident history, and business continuity.

## 5. Incident and legal process terms

- [ ] Define a security incident broadly enough to cover unauthorized access, acquisition, use, disclosure, loss, model leakage, subprocessor incidents, and compromised keys.
- [ ] Require notice without undue delay and within [hours], early enough for the shortest applicable legal/contract deadline; do not wait for a completed investigation.
- [ ] Require rolling facts: dates, systems, data fields, people/jurisdictions, encryption/key status, containment, indicators, recipients, root cause, remediation, and contact.
- [ ] Require evidence preservation, cooperation, regulator/individual notice support, costs/indemnity allocation, and no public attribution without coordination where lawful.
- [ ] Require notice of legal demands where permitted and commitments to narrow/challenge overbroad demands.

## 6. CCPA service-provider / contractor terms

If the operator is a CCPA business and relies on service-provider or contractor status, 11 C.C.R. § 7051 requires a written contract. Confirm it:

- [ ] prohibits selling or sharing personal information;
- [ ] identifies specific, limited business purposes rather than referencing the agreement generally;
- [ ] prohibits retention, use, or disclosure outside those purposes and outside the direct business relationship, except as permitted by the CCPA/regulations;
- [ ] includes the same level of privacy protection required of the business;
- [ ] permits the business to take reasonable and appropriate steps to ensure compliant use;
- [ ] requires notice if the provider can no longer meet its obligations and permits the business to stop/remediate unauthorized use;
- [ ] governs subcontractors and requires written flow-downs;
- [ ] supports consumer requests and correction/deletion; and
- [ ] supports the business's cybersecurity audits and risk assessments with relevant facts and auditor access required by § 7051(h).

Verify whether the provider is in fact a “service provider” or “contractor” for each processing activity under Cal. Civ. Code § 1798.140. A contractual label does not cure incompatible conduct. [Current CCPA and regulations](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf).

## 7. HIPAA

- [ ] Determine whether the operator is a covered entity or business associate and whether the provider creates, receives, maintains, or transmits PHI on its behalf.
- [ ] If yes, obtain a signed BAA before any PHI. Confirm it covers the exact API/product, account, subprocessors, regions, support, abuse monitoring, and model features.
- [ ] Confirm permitted/required uses, safeguards, Security Rule duties, incident and breach reporting, subcontractor flow-down, access/amendment/accounting support, HHS access, return/destruction, and termination rights under 45 C.F.R. § 164.504(e).
- [ ] Apply minimum necessary limits and document the approved PHI workflow.
- [ ] If no suitable BAA is available, block PHI for that endpoint. A “HIPAA eligible” claim is not a signed BAA.

[HHS business-associate contract guidance](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html).

## 8. GLBA Safeguards Rule

For a covered financial institution, 16 C.F.R. § 314.4(f) requires reasonable steps to select and retain service providers capable of appropriate safeguards, contractual safeguards, and periodic assessment based on risk and continued adequacy.

- [ ] Document selection evidence and risk rating.
- [ ] Contractually require safeguards and incident cooperation.
- [ ] Reassess reports, incidents, material changes, subprocessors, and performance at [frequency].
- [ ] Include provider activity in the written information-security program, risk assessment, monitoring/testing, and Qualified Individual reporting.

[FTC Safeguards Rule guidance](https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know).

## 9. Other regulated and contractual data

- [ ] FERPA: establish consent or school-official/other exception, direct control, purpose limits, redisclosure limits, access and deletion.
- [ ] Government contracts/CUI: inspect FAR/DFARS and agency clauses, authorization boundary, NIST SP 800-171/FedRAMP requirements, reporting and evidence duties.
- [ ] Export controls: classify technical data/technology/source code and evaluate destination, foreign-person access, end user/use, license and exceptions.
- [ ] Trade secrets/NDA: confirm disclosure is permitted to this provider and supports reasonable secrecy measures.
- [ ] Professional confidentiality, privilege, financial, insurance, communications, biometric, children's, health-data, and state-sector laws: [analysis].

## 10. Commercial, IP, and termination

- [ ] Allocate ownership/licensing of inputs and outputs; assess infringement warranties, defense, indemnity, caps, exclusions, and claim process.
- [ ] Restrict provider use of organization names, marks, data, and output.
- [ ] Identify model changes, safety/filter changes, discontinuation rights, portability, export format, and transition assistance.
- [ ] Require return/deletion, credential revocation, subprocessor termination, and written completion evidence.
- [ ] Ensure audit, confidentiality, incident, deletion, liability, and legal-process terms survive as needed.

## 11. Decision record

| Item | Decision |
|---|---|
| Risk rating and rationale | [low/medium/high; reasons] |
| Approved use/data/regions | [details] |
| Required `Control AI Chat` rules | [Block/Redact/Require approval/group/model restrictions] |
| Exceptions and compensating measures | [details] |
| Contract/documents reviewed and versions | [details] |
| Open issues / owner / deadline | [details] |
| Approvals | [legal/privacy/security/sector/business] |

Reassess at least annually and before a new model, material term, training policy, subprocessor, region, incident, data type, or use case.
