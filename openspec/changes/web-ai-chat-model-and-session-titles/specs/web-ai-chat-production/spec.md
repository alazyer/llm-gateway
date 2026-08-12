## MODIFIED Requirements

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
