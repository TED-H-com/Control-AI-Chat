# Control AI Chat API Reference & Developer Usage

This document outlines the core modules, API specifications, and provides usage examples for developers integrating with Control AI Chat.

## Core Modules

The core application data structures and interfaces are defined in `server/src/shared/api.ts`. Key modules include:

- **Auth & Identity**: Role-based access using `Role` (`owner`, `admin`, `compliance`, `member`) and granular `Permission`s.
- **Chat & Completion**: `ChatInput`, `RegenerateInput`, and `EditResendInput` structures. Chat messages (`Message`) contain text or file references.
- **Models & Providers**: Built-in providers defined via `Provider` (`openai`, `anthropic`, `google`, `xai`, `openrouter`, `venice`, `nvidia`).
- **Gates & Security**: The gate mechanism returns verdicts (e.g. `allow`, `flag`, `redact`, `mask`, `block`, `require_approval`). Handled by `DetectorKind`s like `keyword`, `pii`, `secret`, `source_code`, etc.

## API Reference

The server exposes an internal router using the Hono framework, defined in `server/src/routes/catalog.ts`. All endpoints are rooted under `/api/v1`. Access levels generally include `public` or `tenant` (requiring authentication).

### Auth & Identity
- `POST /auth/login` (public) - Sign in using credentials.
- `POST /auth/logout` (tenant) - Sign out.
- `POST /auth/refresh` (public) - Refresh session token.
- `GET /auth/me` (tenant) - Get current user profile and permissions.

### Chat & Assistants
- `POST /chat/runs` (tenant) - Start a new chat completion run.
- `POST /chat/runs/regenerate` (tenant) - Regenerate a message.
- `POST /chat/runs/edit-resend` (tenant) - Edit a message and resend.
- `GET /chat/runs/:id` (tenant) - Get run status.
- `DELETE /chat/runs/:id` (tenant) - Cancel a running execution.
- `GET /models` (tenant) - List available models for the workspace.
- `GET /assistants` (tenant) - List active assistants.

### Conversations & Files
- `GET /conversations` (tenant) - List user conversations.
- `POST /conversations` (tenant) - Create a new conversation.
- `GET /conversations/:id/messages` (tenant) - Get messages in a conversation.
- `POST /files` (tenant) - Upload a file (multipart/form-data).
- `GET /files/:id/content` (tenant) - Get file content.
- `GET /files/:id/extracted` (tenant) - Get extracted text from an uploaded file.

### Admin & Auditing
- `GET /admin/dashboard` (tenant) - Dashboard metrics (requires `audit:read`).
- `GET /audit/events` (tenant) - Query hash-chained audit events.
- `GET /admin/models` (tenant) - List tenant models (requires `model:read`).
- `POST /admin/models` (tenant) - Add a new model to tenant (requires `model:write`).

## Developer Usage Examples

### Authentication

To interact with tenant endpoints, you must authenticate. Use the `/auth/login` endpoint to receive a session cookie.

```bash
curl -X POST https://your-domain/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "yourpassword"}'
```

### Starting a Chat Stream

Control AI Chat heavily utilizes Server-Sent Events (SSE) for streaming message text, tool calls, and usage metrics back to the client.

```javascript
const response = await fetch('/api/v1/chat/runs', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID()
  },
  body: JSON.stringify({
    content: "Explain the routing architecture in Control AI Chat.",
    modelId: "your-model-uuid",
    clientRequestId: crypto.randomUUID()
  })
});

// The response is an EventStream.
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

The server will dispatch standard SSE chunks. Look for events like `assistant.delta` for text updates, and `run.completed` when the completion finishes successfully.
