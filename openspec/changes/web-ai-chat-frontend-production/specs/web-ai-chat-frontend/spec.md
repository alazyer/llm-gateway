## ADDED Requirements

### Requirement: The web chat client SHALL drive the production chat capability exclusively

The Nuxt web chat surface SHALL call `/api/ai-chat/*` production endpoints for sending prompts and retrieving sessions and messages, and SHALL NOT call `/v1/chat/completions` directly for chat.

#### Scenario: Send message routes through production endpoint
- **WHEN** a user submits a prompt in the chat UI
- **THEN** the client SHALL send `POST /api/ai-chat/messages` with `prompt`, `stream`, and `clientMessageId`
- **AND** SHALL NOT issue a direct request to `/v1/chat/completions`

#### Scenario: Sessions and history are loaded from production endpoints
- **WHEN** the chat UI loads a session
- **THEN** the client SHALL retrieve sessions via `GET /api/ai-chat/sessions`
- **AND** SHALL retrieve messages via `GET /api/ai-chat/sessions/:sessionId/messages`

### Requirement: The web chat client SHALL attach user identity on every chat request

The client SHALL include an `x-user-id` header on all `/api/ai-chat/*` requests so the backend tenant/user header contract is satisfied. Until a real identity source exists, the value is the constant `llm-gateway`.

#### Scenario: Authenticated request includes user identity
- **WHEN** the client sends any request to `/api/ai-chat/*`
- **THEN** the request SHALL carry an `x-user-id` header set to `llm-gateway`
- **AND** the request SHALL carry the existing gateway auth credential

#### Scenario: Missing gateway auth credential blocks chat
- **WHEN** no gateway auth credential is available
- **THEN** the client SHALL NOT send the chat request
- **AND** SHALL present an authentication-required state to the user

### Requirement: The web chat client SHALL consume the production SSE lifecycle

The client SHALL parse the typed production SSE event stream (`started`, `delta`, `heartbeat`, `completed`, `error`) rather than OpenAI-style frame chunks, and SHALL render each lifecycle state.

#### Scenario: Stream success renders lifecycle in order
- **WHEN** a `stream=true` request succeeds
- **THEN** the client SHALL render `started`, accumulate `delta` content, and finalize on `completed`
- **AND** SHALL ignore `heartbeat` events for content purposes

#### Scenario: Terminal stream error preserves partial content
- **WHEN** the stream emits a terminal `error` event after one or more `delta` events
- **THEN** the client SHALL retain the partial assistant content already rendered
- **AND** SHALL surface the typed error code, retryability, and request id to the user

#### Scenario: Heartbeat does not corrupt content
- **WHEN** a `heartbeat` event arrives between `delta` events
- **THEN** the client SHALL NOT alter the rendered assistant content
- **AND** SHALL keep the stream connection open

### Requirement: The web chat client SHALL expose stable UX states and localized typed-failure messaging

The client SHALL present stable states (idle, sending, streaming, completed, failed) and SHALL map each backend typed failure class to an actionable, localized message.

#### Scenario: Stable state transitions during a request
- **WHEN** a user sends a prompt
- **THEN** the UI SHALL transition through sending → streaming → completed (or failed)
- **AND** SHALL present an idle state when no request is in flight

#### Scenario: Typed failures render actionable localized messages
- **WHEN** a typed failure is received (`RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`)
- **THEN** the UI SHALL display a distinct actionable message for each code
- **AND** for retryable failures SHALL present retry guidance

### Requirement: The web chat client SHALL restore session history across navigation

The client SHALL persist and restore conversation context across page refresh and navigation using cursor-based pagination against the production history endpoints.

#### Scenario: History restores after refresh
- **GIVEN** a session has prior messages
- **WHEN** the user reloads the page and reopens the session
- **THEN** the client SHALL render prior messages in deterministic order
- **AND** prior conversation context SHALL be visible

#### Scenario: Cursor pagination does not skip or duplicate messages
- **GIVEN** a session history spans multiple pages
- **WHEN** the client follows the returned cursor for the next page
- **THEN** the client SHALL render results without skipping or duplicating messages
