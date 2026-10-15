# Workforce AI Acceptable-Use Policy

> Starting point only—adapt it to the operator's facts and have qualified counsel review it before use.

**Policy owner:** [title]\
**Effective date / version:** [date / version]\
**Applies to:** [employees, applicants, contractors, temporary workers, interns, volunteers, and other users]

## 1. Purpose and scope

This policy governs workforce use of `Control AI Chat`, its connected models, saved assistants, projects, file uploads, and outputs. It also governs copying content between `Control AI Chat` and other systems. It applies on organization devices, accounts, networks, and business processes, and to organization information used from any location.

`Control AI Chat` is an operator-managed tool. The organization selects the models and purposes, controls accounts and records, and may inspect activity as described in its monitoring and privacy notices. The source-code maintainers do not operate this deployment and do not receive its data.

## 2. Authorized use

Users may use only:

- an organization-issued account;
- models, assistants, and projects made available to their group;
- approved business purposes within their role and training; and
- information allowed by the classification and data-handling rules below.

Users shall not share accounts, bypass controls, expose API keys, connect unapproved tools, disable or evade checks, split content to avoid detection, or attempt to infer values replaced by redaction tokens.

## 3. Inputs

### 3.1 Never enter without written authorization

Do not enter or upload the following unless the data owner and [privacy/security/legal/sector owner] have approved the specific workflow and model endpoint in writing:

- protected health information, patient records, diagnoses, treatment, insurance, disability or other health information;
- Social Security numbers, tax identifiers, driver's-license or passport numbers;
- payment-card data, bank-account or routing numbers, credentials, private keys, passwords, access tokens or authentication secrets;
- customer, consumer, applicant or employee personal information beyond what is necessary for the approved purpose;
- education records or student information;
- source code, nonpublic vulnerabilities, security architecture, logs or incident material;
- trade secrets, unreleased plans, formulas, designs, pricing, source material or other confidential business information;
- information received under a nondisclosure agreement or another contract that restricts disclosure to the selected recipient;
- export-controlled technical data, controlled technology or source code, Controlled Unclassified Information, classified information, or government information restricted by contract; or
- privileged legal advice, attorney work product, investigation material, or litigation-hold material.

When approval exists, use the minimum information needed, prefer de-identified or synthetic material, and use only the approved model and project.

### 3.2 Prohibited purposes

Users shall not use the system to:

- make or materially influence hiring, rejection, promotion, pay, scheduling, performance, discipline, termination, lending, housing, insurance, education, health-care, or other consequential decisions unless the organization has approved a documented workflow;
- unlawfully discriminate, harass, surveil, profile, impersonate, deceive, threaten, or facilitate harm;
- generate or distribute unlawful, infringing, defamatory, sexually exploitative, malicious, or fraudulent material;
- provide professional legal, medical, financial, safety-critical, or regulatory advice as final advice without an authorized qualified professional;
- evade records, discovery, sanctions, export, security, privacy, or intellectual-property obligations;
- make an AI system the final authority where human judgment is required; or
- represent generated content as verified, original human work when that representation is inaccurate.

## 4. Send-time checks, warnings, and approvals

Before transmission to a model, `Control AI Chat` inspects prompt text and extracted file text for configured patterns and labels, and it checks model responses before release. Accepted files are plain text, CSV, Markdown, PDF, DOCX, XLSX, and PPTX. Images are refused, and PDFs without a text layer fail extraction. These checks are imperfect: they can miss sensitive content and can flag harmless content. Users remain responsible for every input.

The system may:

- **Allow** content without interruption;
- **Flag** a match in records without interrupting the send;
- **Redact** a match by replacing it with a token without retaining the original or a token mapping in memory or in the database. The value cannot be restored or revealed from `Control AI Chat`; a user who needs the original must keep it outside the product;
- **Substitute** replacement text irreversibly (code action `mask`);
- **Warn** and require the user to confirm;
- **Block** transmission; or
- **Require approval**, holding content encrypted until an owner or compliance reviewer releases or rejects it. Administrators and members cannot decide approvals.

When multiple rules match, the strongest configured action applies. A warning is not approval to violate this policy. A missed detection is not permission. Users shall not rephrase, fragment, screenshot, encode, or otherwise transform content to avoid a control.

For approval requests, provide a truthful business reason and requested recipient/model. Do not send the same content through another channel while review is pending. Reviewers shall decide only within delegated authority, record the basis, and escalate uncertainty.

## 5. Review and use of outputs

AI output may be incorrect, incomplete, fabricated, biased, outdated, insecure, or infringing. Before using it, the responsible user shall:

1. verify material facts, quotations, citations, calculations, code, and legal or technical claims against authoritative sources;
2. check for confidential, personal, biased, discriminatory, unsafe, or malicious material;
3. test code in an isolated environment and conduct normal security, licensing, and peer review;
4. apply required professional review, accessibility review, and records controls;
5. disclose AI assistance when law, contract, policy, professional duty, or context requires it; and
6. remain personally accountable for the final work product.

Do not assume an output is owned, noninfringing, confidential, or eligible for intellectual-property protection. Follow [IP/legal review process]. Do not expose internal system prompts, approval content, or another user's conversations. `Control AI Chat` does not retain redaction mappings.

## 6. Monitoring, privacy, and records

The organization may record and review prompts, uploads, detections, actions, approval material, model usage, outputs, account/session activity, and audit events for the purposes stated in its [electronic-monitoring notice](02-electronic-monitoring-notice.en.md) and applicable privacy notices. Users should have no expectation of personal privacy in organization-provided accounts except where law provides otherwise.

Access is role restricted. Authorized reviewers may search audit records, review stored violation transcripts or held excerpts, decide approvals, and export audit metadata. Retention periods and legal holds apply. Do not delete, alter, or conceal material subject to a preservation instruction.

## 7. Incident reporting

Immediately stop the affected workflow and report to [channel / phone / email] if you:

- send or receive information contrary to this policy;
- select the wrong model, provider, project, recipient, or account;
- observe a control bypass, unusual access, exposed credential, lost device, malicious output, or suspected compromise;
- receive output that could cause harm or an unlawful decision; or
- believe records were altered, deleted, or improperly retained.

Preserve the conversation identifier, date/time, model, relevant screenshots or files, and error text. Do not broadly redistribute sensitive content or investigate beyond authorization. Good-faith reporting is protected under [nonretaliation policy].

## 8. Administration and exceptions

Exceptions require prior written approval from [roles], a defined purpose, data types, model/provider, users, safeguards, retention, testing, expiration date, and documented residual-risk decision. Emergency use must follow [emergency process] and be reviewed afterward.

The organization may suspend accounts or sessions, preserve records, remove model access, investigate, and take proportionate corrective or disciplinary action, up to and including termination of employment or contract, subject to applicable law, collective bargaining agreements, and organization policy. Good-faith mistakes, self-reporting, intent, training, and harm should be considered consistently.

## 9. Defend Trade Secrets Act immunity notice

Under 18 U.S.C. § 1833(b), an individual is not criminally or civilly liable under federal or state trade-secret law for disclosing a trade secret: (1) in confidence, directly or indirectly, to a federal, state, or local government official or to an attorney, solely to report or investigate a suspected violation of law; or (2) in a complaint or other document filed under seal in a lawsuit or other proceeding. An individual who files a retaliation lawsuit for reporting a suspected violation of law may disclose the trade secret to the individual's attorney and use it in the proceeding if any trade-secret filing is under seal and the individual does not disclose the trade secret except by court order.

This notice applies to employees, contractors, and consultants. It does not authorize disclosure beyond 18 U.S.C. § 1833(b), remove other lawful confidentiality duties, or permit access to material the individual is not authorized to access. The statutory notice requirement applies to contracts and agreements governing trade secrets or confidential information entered into or updated after May 11, 2016. An employer that omits the required notice cannot recover exemplary damages or attorney fees under 18 U.S.C. § 1836(b)(3)(C)–(D) in an action against that individual for conduct occurring while notice was absent. [Official statute](https://uscode.house.gov/view.xhtml?edition=prelim&path=%2Fprelim%40title18%2Fpart1%2Fchapter90).

## 10. Acknowledgment

I acknowledge that I received, read, and understand this policy and the related monitoring and privacy notices; had an opportunity to ask questions; will use only approved workflows; and understand that send-time detection is imperfect and does not replace my obligations.

**Name:** ____________________\
**Signature / approved electronic assent:** ____________________\
**Date and time:** ____________________\
**Policy version:** ____________________
