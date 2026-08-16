## ADDED Requirements

### Requirement: Sessions SHALL carry a human-readable title

Every session SHALL have a title: auto-derived from the first user prompt on creation, and renameable by the owner. The title SHALL be exposed in the session list so history is scannable.

#### Scenario: New session auto-derives a title from the first prompt
- **WHEN** a message creates a new session with first prompt `P`
- **THEN** the session's title SHALL be the first 60 characters of `P`, trimmed
- **AND** if `P` exceeds 60 characters, the title SHALL be truncated with a trailing `…`
- **AND** the title SHALL be persisted on the session row

#### Scenario: Session list exposes titles
- **WHEN** the client requests `GET /api/ai-chat/sessions`
- **THEN** each session in the response SHALL include a `title` field
- **AND** a session with no title (e.g. a pre-existing session) SHALL return `title: null`

### Requirement: Sessions SHALL be renameable by their owner

The owner of a session SHALL be able to rename it via `PATCH /api/ai-chat/sessions/:sessionId`. Renaming SHALL be authenticated, ownership-enforced, validated, and audited.

#### Scenario: Owner renames a session
- **GIVEN** session `S` belongs to user `A`
- **WHEN** user `A` sends `PATCH /api/ai-chat/sessions/S` with body `{ "title": "New Name" }`
- **THEN** the backend SHALL update the session's title to `New Name`
- **AND** SHALL update the session's `updatedAt`
- **AND** SHALL return `200` with `{ sessionId, title, updatedAt }`
- **AND** a `rename` audit event SHALL be recorded

#### Scenario: Non-owner cannot rename
- **GIVEN** session `S` belongs to user `A`
- **WHEN** user `B` sends `PATCH /api/ai-chat/sessions/S` with a title
- **THEN** the backend SHALL return `403 FORBIDDEN`
- **AND** the title SHALL NOT change

#### Scenario: Invalid title is rejected
- **WHEN** a rename request has an empty title or a title longer than 120 characters
- **THEN** the backend SHALL return `400 VALIDATION_ERROR`
- **AND** the title SHALL NOT change
