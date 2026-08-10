## Why

The current Web AI Chat capability was scoped as a fast validation surface. COM-261 confirms this must evolve into a production-ready end-to-end feature with durable sessions, explicit reliability controls, and auditable behavior.

## What Changes

- Replace validation-only semantics with production chat semantics in the gateway-facing capability contract.
- Define authenticated chat APIs with session persistence and deterministic history retrieval.
- Define streaming and non-stream response behavior through internal LLM Gateway model routing.
- Define production resilience requirements: rate limiting, bounded retry, typed failure handling, and degradation behavior.
- Define observability and audit requirements suitable for operational and compliance review.

## Capabilities

### New Capabilities

- `web-ai-chat-production`: Production web chat behavior over LLM Gateway with persistent conversations and reliability controls.

### Modified Capabilities

- `web-ai-chat-validation`: Existing quick-validation behavior is superseded by production flow.
- `incoming-auth`: Chat endpoints require existing auth enforcement and tenant/user session authorization.
- `request-tracing`: Chat flows include request/session correlation and structured outcome telemetry.
- `persistence`: Session and message persistence are required for chat history.
- `upstream-resilience`: Typed retry/timeout/degradation behavior is required for upstream interruptions.

## Impact

- **API Surface**: Adds explicit production chat request/history/streaming contracts.
- **UX Contract**: Removes separate quick-validation mode and standardizes on production chat states.
- **Operations**: Adds mandatory observability and audit fields for all chat outcomes.
- **Security**: Maintains current auth boundary and session ownership enforcement.

## Non-Goals

- Implementing code in this change.
- Introducing a new identity provider or custom auth protocol.
- Defining provider-specific prompt strategy beyond contract fields.
