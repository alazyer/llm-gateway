# web-ai-chat-production Specification

## Purpose

Production Web AI Chat capability over the LLM Gateway: durable sessions, authenticated per-user access, stream and non-stream prompt execution through internal model routing, rate limiting with bounded retry, typed failure handling, persistent history with cursor-based pagination, and audit/observability signals. Supersedes the quick-validation-only chat flow.

## Requirements

### Requirement: Web AI Chat SHALL run as an authenticated production capability

All Web AI Chat routes and actions SHALL require authenticated access and SHALL enforce tenant/user ownership of sessions.

#### Scenario: Unauthorized chat request is rejected
- **WHEN** a request to `/api/ai-chat/*` is made without valid auth context
- **THEN** the system SHALL return `401 UNAUTHORIZED`
- **AND** no chat session/message persistence SHALL occur

#### Scenario: Cross-user session access is denied
- **GIVEN** session `S` belongs to user `A`
- **WHEN** user `B` requests session `S`
- **THEN** the system SHALL return `403 FORBIDDEN`
- **AND** an audit event with denied outcome SHALL be recorded

### Requirement: Web AI Chat SHALL support production prompt execution in stream and non-stream modes

Prompt submission SHALL route through internal LLM Gateway model routing and return either non-stream completion or SSE event stream per request mode. The message request SHALL accept an optional `model` field, and the routed model SHALL be resolved per request (not fixed at startup).

#### Scenario: Non-stream prompt success
- **WHEN** an authenticated user submits a valid prompt with `stream=false`
- **THEN** response SHALL include `sessionId`, `messageId`, `assistantMessage`, `model`, `usage`, and `requestId`
- **AND** both user and assistant messages SHALL be persisted
- **AND** the assistant message SHALL record the model actually routed to

#### Scenario: Stream prompt success
- **WHEN** an authenticated user submits a valid prompt with `stream=true`
- **THEN** SSE events SHALL be emitted in order: `started`, `delta*`, `completed`
- **AND** final assistant message metadata SHALL be persisted on completion

#### Scenario: Message request accepts an optional model field
- **WHEN** an authenticated user submits a message with `model: M` in the request body
- **THEN** the backend SHALL resolve the routable model per the session/new-session precedence
- **AND** SHALL route to the resolved model
- **AND** the request SHALL NOT be rejected solely because a `model` field is present

### Requirement: Web AI Chat SHALL enforce rate limiting and bounded retry

The system SHALL apply per-user rate limiting and SHALL retry only transient upstream/network failures within a bounded attempt count.

#### Scenario: User exceeds rate limit
- **WHEN** a user exceeds configured request quota
- **THEN** the system SHALL return typed error `RATE_LIMITED`
- **AND** response SHALL provide enough metadata for client cooldown behavior

#### Scenario: Transient upstream failure recovers via retry
- **WHEN** an upstream transient error occurs before retry limit
- **THEN** the system SHALL retry within configured bounds
- **AND** successful completion SHALL be returned if a retry succeeds
- **AND** retry count SHALL be emitted in telemetry

### Requirement: Web AI Chat SHALL persist session history with deterministic retrieval

The system SHALL persist chat sessions and messages and SHALL provide stable cursor-based history retrieval. The session list response SHALL include each session's `title` and `model`.

#### Scenario: Session history restores after refresh
- **GIVEN** a session has prior messages
- **WHEN** user reloads and reopens the session
- **THEN** messages SHALL be returned in deterministic order
- **AND** prior conversation context SHALL be visible

#### Scenario: Cursor pagination is stable
- **GIVEN** history spans multiple pages
- **WHEN** client follows returned cursor for next page
- **THEN** results SHALL not skip or duplicate messages

#### Scenario: Session list includes title and model
- **WHEN** the client requests `GET /api/ai-chat/sessions`
- **THEN** each session in the response SHALL include `title` and `model` fields
- **AND** `title` and `model` SHALL be `null` for sessions that predate the columns

### Requirement: Web AI Chat SHALL provide typed failure classification and graceful degradation

The system SHALL classify failures into typed error categories and SHALL provide recoverable UX behavior for interruption and upstream failures.

#### Scenario: Gateway unavailable
- **WHEN** upstream model route is unavailable
- **THEN** the system SHALL return/emit `UPSTREAM_UNAVAILABLE`
- **AND** user SHALL receive actionable retry guidance

#### Scenario: Mid-stream interruption
- **WHEN** stream begins and is interrupted before completion
- **THEN** terminal stream event SHALL be `error` with `retryable` indicator
- **AND** partial assistant content SHALL remain visible where available

### Requirement: Web AI Chat SHALL emit audit and observability signals for production operations

All chat outcomes SHALL produce structured audit and telemetry data with request/session correlation.

#### Scenario: Success outcome logging
- **WHEN** a chat request completes successfully
- **THEN** audit log SHALL include actor, action, sessionId, requestId, timestamp, and outcome code

#### Scenario: Failure telemetry logging
- **WHEN** a chat request fails (timeout/unavailable/interruption/rate-limit)
- **THEN** telemetry SHALL include latency, error class, retry count, and stream interruption flag

### Requirement: Production flow SHALL replace quick-validation mode

The previous quick-validation-only flow SHALL be removed or redirected so only production chat flow remains active, including in the web client.

#### Scenario: Legacy validation entry path behavior
- **WHEN** user navigates to legacy quick-validation entry
- **THEN** navigation SHALL resolve to production chat capability
- **AND** no separate quick-validation operational mode SHALL remain

#### Scenario: Web client resolves legacy validation mode to production chat
- **WHEN** a user enters the web chat surface that previously ran quick-validation mode
- **THEN** the web client SHALL present the production chat experience backed by `/api/ai-chat/*`
- **AND** SHALL NOT expose a separate quick-validation operational mode or toggle
