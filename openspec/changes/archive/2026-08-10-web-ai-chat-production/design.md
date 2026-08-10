## Architecture

### Components

1. **Web Chat UI Client**
   - Presents session list, message timeline, stream-in-progress state, and retry/recover actions.
   - Sends authenticated prompt requests and consumes SSE stream events.

2. **Gateway Chat API Surface**
   - Validates auth and request payloads.
   - Enforces user-level rate limits.
   - Coordinates session/message persistence and model invocation.

3. **Model Routing Adapter**
   - Maps chat requests to internal LLM Gateway model routes.
   - Applies timeout and bounded retry policy for transient upstream failures.
   - Normalizes upstream failures into typed gateway error classes.

4. **Session Persistence Layer**
   - Persists sessions and messages (user/assistant) with deterministic ordering metadata.
   - Supports paginated history retrieval with stable cursors.

5. **Audit + Observability Pipeline**
   - Emits audit events for access/send/complete/fail outcomes.
   - Emits operational telemetry for latency, retries, rate limits, stream interruptions, and failure classes.

### Data Flow

1. UI loads session list and recent messages from gateway history APIs.
2. User submits prompt (`stream=true|false`) with authenticated context.
3. Gateway validates auth/quota/input, persists user message, and invokes selected model route.
4. For streaming, gateway emits ordered SSE events (`started`, `delta`, `heartbeat`, `completed` or `error`).
5. Gateway persists final assistant message (or failure outcome), then emits audit and telemetry.
6. UI updates stable UX state (idle/sending/streaming/completed/failed) and presents localized actionable errors.

## API Contracts

### Send Message

`POST /api/ai-chat/messages`

Request:

```json
{
  "sessionId": "optional-uuid",
  "prompt": "user input text",
  "stream": true,
  "clientMessageId": "uuid",
  "context": {
    "locale": "en-US",
    "timezone": "Asia/Shanghai"
  }
}
```

Non-stream response:

```json
{
  "sessionId": "uuid",
  "messageId": "uuid",
  "assistantMessage": {
    "role": "assistant",
    "content": "final answer"
  },
  "usage": {
    "inputTokens": 123,
    "outputTokens": 456
  },
  "model": "gateway-model-alias",
  "requestId": "trace-id"
}
```

### Stream Contract

For `stream=true`, response type is `text/event-stream` with ordered event lifecycle:
- `started`: includes `sessionId`, `messageId`, `model`, `requestId`
- `delta`: incremental assistant text chunks
- `heartbeat`: periodic liveness event while stream active
- `completed`: usage metadata and terminal success
- `error`: terminal typed failure with retryability signal

Error payload:

```json
{
  "code": "RATE_LIMITED|UPSTREAM_TIMEOUT|UPSTREAM_UNAVAILABLE|VALIDATION_ERROR|UNAUTHORIZED",
  "message": "human-readable message",
  "retryable": true,
  "requestId": "trace-id"
}
```

### History Contracts

- `GET /api/ai-chat/sessions?cursor=<cursor>&limit=<n>`
- `GET /api/ai-chat/sessions/{sessionId}/messages?cursor=<cursor>&limit=<n>`

Both SHALL return deterministic ordering and stable cursors.

## Reliability and Degradation

1. **Rate limiting**: Exceeded quota returns `RATE_LIMITED`; client receives cooldown semantics.
2. **Bounded retry**: Only transient upstream/network failures are retried; retry count is finite and observable.
3. **Gateway unavailable**: Return `UPSTREAM_UNAVAILABLE` promptly with retry guidance.
4. **Mid-stream interruption**: Emit stream `error` with `retryable`; preserve partial response for user.
5. **Post-inference persistence failure**: Return typed failure and emit audit event documenting partial completion state.

## Security

- All chat routes SHALL require existing gateway auth middleware.
- Session reads/writes SHALL enforce tenant/user ownership.
- Prompt length and required fields SHALL be validated before model invocation.
- Sensitive bodies SHOULD be excluded from default logs; correlation metadata MUST be present.

## Acceptance Strategy

- Contract tests for send/history/stream payloads and event ordering.
- Integration tests for auth isolation, rate limits, retry policy, and persistence recovery.
- Failure injection tests for upstream timeout/unavailable and stream interruption.
- UX verification for state transitions and history restoration across refresh.
