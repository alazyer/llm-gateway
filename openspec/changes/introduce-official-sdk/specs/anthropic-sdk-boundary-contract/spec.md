## ADDED Requirements

### Requirement: `/v1/messages` boundary SHALL use Anthropic SDK-compatible validation and construction
The gateway SHALL validate and normalize `/v1/messages` requests and construct `/v1/messages` responses/events using Anthropic SDK-compatible contract shapes.

#### Scenario: Valid Anthropic request accepted
- **WHEN** a `/v1/messages` request conforms to Anthropic-compatible schema
- **THEN** the gateway SHALL accept it and normalize it for translation to internal Chat Completions format

#### Scenario: Invalid Anthropic request rejected
- **WHEN** a `/v1/messages` request violates Anthropic-compatible schema
- **THEN** the gateway SHALL return an Anthropic-compatible invalid request error

### Requirement: Anthropic streaming minimum event contract SHALL be guaranteed
For `/v1/messages` streaming responses, the gateway SHALL emit at least the following ordered events:
`message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop`.

#### Scenario: Text completion stream emits required lifecycle events
- **WHEN** upstream emits a valid text stream for `/v1/messages`
- **THEN** the gateway SHALL emit required Anthropic lifecycle events in the mandated order

#### Scenario: Tool-use stream emits required lifecycle events
- **WHEN** upstream emits tool call deltas for `/v1/messages`
- **THEN** the gateway SHALL emit content block events and terminal message events in the mandated order

### Requirement: `/v1/messages` strict unknown-field policy SHALL remain unchanged in this change
This change SHALL NOT introduce unknown top-level field strictness rollout behavior for `/v1/messages`.

#### Scenario: Unknown `/v1/messages` strict-mode config absent
- **WHEN** gateway configuration is updated for this change
- **THEN** no `/v1/messages`-specific `warn|enforce` unknown-field policy SHALL be required
