## MODIFIED Requirements

### Requirement: Gateway SHALL normalize upstream transport errors to endpoint contracts
The gateway SHALL map OpenAI SDK transport and upstream HTTP failures into stable endpoint-native error responses.

#### Scenario: Upstream transport error on `/responses`
- **WHEN** SDK transport fails while serving `/responses`
- **THEN** the gateway SHALL return a `/responses`-compatible error envelope with appropriate HTTP status

#### Scenario: Upstream transport error on `/v1/messages`
- **WHEN** SDK transport fails while serving `/v1/messages`
- **THEN** the gateway SHALL return an Anthropic-compatible error envelope with appropriate HTTP status

#### Scenario: Upstream transport error on `/v1/chat/completions`
- **WHEN** SDK transport fails while serving `/v1/chat/completions`
- **THEN** the gateway SHALL return an OpenAI-compatible Chat Completions error envelope with appropriate HTTP status
