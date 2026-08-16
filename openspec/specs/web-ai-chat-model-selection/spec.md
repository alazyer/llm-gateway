# web-ai-chat-model-selection Specification

## Purpose

Per-session model selection for the Web AI Chat client and the corresponding backend request-time model resolution. The operator chooses a configured gateway model per chat session; the backend deterministically resolves the routable model for each message request using a stored-model / client-model / default precedence.

## Requirements

### Requirement: The web chat client SHALL select a model per session

The client SHALL present a model picker that lets the operator choose which configured gateway model a session routes to. The selected model SHALL be set on the first message of a session, persisted on the session, and SHALL be changeable mid-session.

#### Scenario: New session stamps the selected model
- **WHEN** a user starts a new chat with model `M` selected in the picker and sends the first message
- **THEN** the client SHALL send `model: M` on the message request
- **AND** the backend SHALL route the message to model `M`
- **AND** the session SHALL be persisted with `model: M`

#### Scenario: Existing session restores its stored model
- **WHEN** a user reopens an existing session whose stored model is `M`
- **THEN** the client SHALL set the picker to `M`
- **AND** subsequent messages SHALL route to `M`

#### Scenario: Mid-session model switch updates the session
- **GIVEN** an existing session with stored model `M1`
- **WHEN** the user changes the picker to `M2` and sends a message
- **THEN** the client SHALL send `model: M2` on the request
- **AND** the backend SHALL route the message to `M2`
- **AND** the backend SHALL update the session's stored model to `M2`

### Requirement: The backend SHALL resolve the model per request

The backend SHALL resolve the routable model for each message request using a deterministic precedence: the session's stored model for an existing session, the client-supplied model for a new session, and the configured default as fallback.

#### Scenario: Existing session uses its stored model
- **GIVEN** session `S` exists with stored model `M`
- **WHEN** a message is sent to session `S`
- **THEN** the backend SHALL route to `M` regardless of any client-supplied `model`
- **UNLESS** the client-supplied `model` differs, in which case the session SHALL be updated to the client-supplied model

#### Scenario: New session uses client-supplied or default model
- **WHEN** a message creates a new session
- **AND** the client supplies `model: M`
- **THEN** the backend SHALL route to `M` and stamp `M` on the session
- **BUT WHEN** the client supplies no `model`
- **THEN** the backend SHALL route to `config.defaultModel` (or the first active model) and stamp that on the session

#### Scenario: Unroutable model is rejected
- **GIVEN** the resolved model is not in the active configured models
- **WHEN** a message is sent
- **THEN** the backend SHALL return `400 VALIDATION_ERROR` with a message naming the model
- **AND** no assistant message SHALL be persisted
