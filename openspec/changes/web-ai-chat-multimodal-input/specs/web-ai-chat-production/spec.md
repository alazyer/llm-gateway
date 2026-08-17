## MODIFIED Requirements

### Requirement: Web AI Chat SHALL support production prompt execution in stream and non-stream modes

Prompt submission SHALL route through internal LLM Gateway model routing and return either non-stream completion or SSE event stream per request mode. The message request SHALL accept an optional `model` field, and the routed model SHALL be resolved per request (not fixed at startup). The message request SHALL accept an optional `attachments` array of image parts, and when attachments are present the routed model SHALL receive a multimodal content array; image attachments SHALL be rejected when the routed model does not support image input.

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

#### Scenario: Multimodal message forwarded to an image-capable model
- **WHEN** an authenticated user submits a message with a non-empty `prompt` and an `attachments` array of valid image parts, and the routed model supports image input
- **THEN** the backend SHALL build a `content` array of one `{ type: "text" }` part and one `{ type: "image_url" }` part per attachment
- **AND** SHALL forward that multimodal content to the upstream model via the existing chat completions transport
- **AND** SHALL persist the user message with its image attachments

#### Scenario: Image attachments rejected for non-image model
- **WHEN** an authenticated user submits a message with an `attachments` array and the routed model does not support image input
- **THEN** the backend SHALL return `400 VALIDATION_ERROR`
- **AND** SHALL NOT call the upstream model
- **AND** SHALL NOT persist a user message or create/touch a session for the request (the capability check runs before any session or user-message insert)
- **AND** an audit event with a failed outcome SHALL be recorded

#### Scenario: Attachments ignored for text-only request
- **WHEN** an authenticated user submits a message with no `attachments` field
- **THEN** the backend SHALL build `content` as a plain text string (unchanged behavior)
- **AND** SHALL NOT alter the existing text-only request path

## ADDED Requirements

### Requirement: Web AI Chat SHALL persist and restore multimodal user message content

The system SHALL persist user messages that include image attachments such that the attachments are restored verbatim from history, without altering the persistence or retrieval of text-only messages.

#### Scenario: Multimodal user message round-trips through history
- **GIVEN** a user message was sent with text and image attachments and persisted
- **WHEN** the session history is read via `GET /api/ai-chat/sessions/:sessionId/messages`
- **THEN** the returned user message SHALL expose the original text and each image attachment's data URL
- **AND** the message SHALL be retrievable with the same cursor pagination as text-only messages

#### Scenario: Text-only messages remain unchanged
- **GIVEN** a user message was sent with text only (no attachments)
- **WHEN** the session history is read
- **THEN** the returned user message SHALL expose plain text content with no envelope or attachment structure
- **AND** SHALL be byte-for-byte equivalent to pre-change text-only behavior

#### Scenario: Attachment validation enforced server-side
- **WHEN** an authenticated user submits a message with an attachment whose MIME type is not an image type, or whose base64 size exceeds the per-image cap (~700 KB), or that includes more than one attachment
- **THEN** the backend SHALL return `400 VALIDATION_ERROR`
- **AND** SHALL NOT call the upstream model
