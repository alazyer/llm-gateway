## 1. Contract and Schema Baseline

- [x] 1.1 Define typed request/response schemas for send message, sessions list, and message history.
- [x] 1.2 Define SSE event schema (`started`, `delta`, `heartbeat`, `completed`, `error`) and ordering rules.
- [x] 1.3 Define typed error taxonomy and retryability semantics.

## 2. Auth and Authorization

- [x] 2.1 Enforce authenticated access for all `/api/ai-chat/*` routes.
- [x] 2.2 Enforce tenant/user ownership for all session reads and writes.
- [x] 2.3 Add integration tests for unauthorized and cross-user access denial.

## 3. Rate Limiting and Retry

- [x] 3.1 Apply per-user rate limit policy and include cooldown-relevant response metadata.
- [x] 3.2 Implement bounded retry for transient upstream/network failures only.
- [x] 3.3 Emit retry count and terminal failure class telemetry.

## 4. Streaming and Failure Handling

- [x] 4.1 Implement deterministic SSE lifecycle and stream close semantics.
- [x] 4.2 Handle mid-stream interruption with typed terminal error event.
- [x] 4.3 Preserve partial assistant content state where available.

## 5. Persistence and History

- [x] 5.1 Persist user and assistant messages with stable session IDs and timestamps.
- [x] 5.2 Implement deterministic cursor-based pagination for sessions and messages.
- [x] 5.3 Verify history restoration across page refresh/navigation.

## 6. Audit and Observability

- [x] 6.1 Emit audit events for access/send/complete/fail paths with correlation fields.
- [x] 6.2 Emit latency/error/retry/stream-health operational metrics.
- [x] 6.3 Validate redaction behavior for sensitive prompt/response content.

## 7. Production Flow Consolidation

- [x] 7.1 Remove/redirect legacy quick-validation-only route to production chat flow.
- [x] 7.2 Ensure UX exposes stable states: idle, sending, streaming, completed, failed.
- [x] 7.3 Validate localized actionable error messaging for each typed failure class.

## 8. Release Acceptance

- [x] 8.1 Execute end-to-end scenarios for healthy flow, rate-limit, timeout, unavailable, and interrupted-stream cases.
- [x] 8.2 Confirm acceptance criteria and reliability objectives are met before release.
