# Message Dispatch and Routing Architecture

Control AI Chat routes and dispatches requests to underlying model providers using a standardized architecture designed for security, governance, and auditability.

## Message Dispatch Protocols

The application normalizes all requests using an internal standard protocol, translating to provider-specific formats only at the network edge.

The application currently supports the following target protocols:
- `openai_chat_completions`: Standard stateless chat completion used by OpenAI and compatible APIs.
- `openai_responses`: Emerging stateful/advanced response formats.
- `anthropic_messages`: Anthropic's Messages API format.
- `google_generate_content`: Google's Gemini generation format.

By maintaining an internal format, the application guarantees that gates (security checks, redaction, budgeting, and audit logging) are applied consistently regardless of the target provider.

## Routing Architecture

Routing is the process of selecting the most appropriate combination of provider and model based on the user's request and administrative policies.

### The Routing Lifecycle

1. **Gate Inspection**: Incoming requests pass through the pre-flight gate. Redactions, substitutions, and block policies are enforced here.
2. **Candidate Selection**: The system determines the available routing candidates. It evaluates user group memberships, tenant models, and provider grants.
3. **Intent Parsing**: If multi-model or auto-routing is enabled, the request intent (e.g., speed, required capabilities, geographic constraints) is analyzed. The routing task can be classified into categories like `code`, `writing`, or `general`.
4. **Plan Selection**:
   - **Single Route**: The exact requested model is mapped to its provider candidate.
   - **Fast Multi-Model Plan**: If appropriate, the system generates a plan for multi-model execution based on cost, quality tiers, and capabilities.
5. **Execution and Metering**: The request is dispatched. Providers accumulate streamed responses and apply rate limiting and cost accounting.

### Cost Control

The routing engine heavily relies on billing constraints. It maintains pricing models internally (`microusd_per_million` for input/output/cached) and ensures single-tier prices keep requests below vendor long-context billing thresholds.

## Worker Integration Interfaces

Background tasks such as document extraction, file processing, and auditing are handled by dedicated workers.

### The Extraction Worker

The extraction worker operates as a separate Node.js thread (`worker_threads`). It receives a `Job` payload containing:
- File bytes
- MIME type
- Extraction limits (e.g., `maxPages`, `maxExtractedCharacters`)

It returns an `ExtractionOutcome` detailing the text extracted, the unit count (pages/sheets), language detected, and any warnings (e.g., truncation or removed controls). Extracted text is sanitized and gated before it is used by models.

### The Audit Worker

The audit worker manages retention policies, purges expired records, and continually verifies the integrity of the hash-chained audit log. It accepts dependencies (`AuditWorkerDependencies`) like the database connection, blob store, and retention policy resolver to systematically iterate through active and maintenance tenants.
