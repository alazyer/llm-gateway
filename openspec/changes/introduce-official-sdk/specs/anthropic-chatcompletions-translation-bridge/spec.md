## ADDED Requirements

### Requirement: `/v1/messages` requests SHALL translate to internal Chat Completions requests
The gateway SHALL translate Anthropic Messages requests to internal Chat Completions request shape before upstream dispatch.

#### Scenario: Text messages translate to chat messages
- **WHEN** `/v1/messages` contains Anthropic text content blocks
- **THEN** the gateway SHALL produce equivalent Chat Completions message entries preserving role order and content

#### Scenario: Tool-use metadata translates to chat tool schema
- **WHEN** `/v1/messages` includes tools or tool choice settings
- **THEN** the gateway SHALL map those fields into Chat Completions tool and tool_choice fields

### Requirement: Upstream Chat Completions responses SHALL translate back to Anthropic message format
The gateway SHALL map Chat Completions non-stream responses and stream deltas into Anthropic-compatible message payloads and events.

#### Scenario: Non-stream response maps stop reason and usage
- **WHEN** upstream returns a non-stream Chat Completions response
- **THEN** the gateway SHALL return Anthropic `stop_reason` and usage fields consistent with mapped finish reason and token usage

#### Scenario: Stream response maps deltas and terminal events
- **WHEN** upstream returns Chat Completions stream chunks
- **THEN** the gateway SHALL map chunks into Anthropic content block deltas and terminal message events

### Requirement: Translation failures SHALL return Anthropic-compatible errors
If Anthropic-to-Chat Completions or Chat Completions-to-Anthropic translation fails, the gateway SHALL return Anthropic-compatible error payloads.

#### Scenario: Invalid tool arguments in upstream response
- **WHEN** upstream tool call arguments cannot be parsed into required Anthropic structure
- **THEN** the gateway SHALL return an Anthropic-compatible error response
