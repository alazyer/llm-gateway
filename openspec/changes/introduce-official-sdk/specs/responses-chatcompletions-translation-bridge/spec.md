## ADDED Requirements

### Requirement: `/responses` requests SHALL translate to internal Chat Completions requests
The gateway SHALL translate `/responses` request payloads into internal Chat Completions request shape before upstream dispatch.

#### Scenario: Responses input maps to chat message list
- **WHEN** `/responses` request includes supported `input` or `instructions`
- **THEN** the gateway SHALL construct equivalent Chat Completions `messages`

#### Scenario: Responses tool fields map to chat tool fields
- **WHEN** `/responses` request includes supported `tools` and `tool_choice`
- **THEN** the gateway SHALL map those fields to Chat Completions-compatible tool schema

### Requirement: `/responses` top-level unknown field handling SHALL be per-model configurable
The gateway SHALL support per-model `unknown_field_mode` with values `warn` or `enforce` for unknown top-level `/responses` request fields. If omitted, default SHALL be `warn`.

#### Scenario: Warn mode ignores unknown top-level fields
- **WHEN** a model has `unknown_field_mode=warn` and request includes unknown top-level fields
- **THEN** the gateway SHALL ignore those fields and continue processing

#### Scenario: Enforce mode rejects unknown top-level fields
- **WHEN** a model has `unknown_field_mode=enforce` and request includes unknown top-level fields
- **THEN** the gateway SHALL return HTTP 400 with payload `{ "error": "Unknown /responses fields.", "unknown_fields": ["..."] }`

### Requirement: Unknown-field observability SHALL log names and count only
When unknown top-level `/responses` fields are detected, the gateway SHALL log unknown field names and count, and SHALL NOT log raw field values.

#### Scenario: Warn mode observability log
- **WHEN** unknown top-level fields are detected in warn mode
- **THEN** logs SHALL include only field names and count without raw values

#### Scenario: Enforce mode observability log
- **WHEN** unknown top-level fields are detected in enforce mode
- **THEN** logs SHALL include only field names and count without raw values

### Requirement: Per-model capability gates SHALL control tools and streaming eligibility
The gateway SHALL support per-model `supports_tools` and `supports_streaming` flags, each defaulting to `true`.

#### Scenario: Tools rejected when unsupported
- **WHEN** request uses tools for a model with `supports_tools=false`
- **THEN** the gateway SHALL reject the request with client error before upstream dispatch

#### Scenario: Streaming rejected when unsupported
- **WHEN** request uses streaming for a model with `supports_streaming=false`
- **THEN** the gateway SHALL reject the request with client error before upstream dispatch

### Requirement: Promotion to enforce mode SHALL require acceptance gates
A model SHALL transition from `unknown_field_mode=warn` to `unknown_field_mode=enforce` only after all acceptance gates pass.

#### Scenario: Enforce promotion allowed
- **WHEN** `/responses` and `/v1/messages` stream/non-stream regressions pass, Claude runtime compatibility tests pass, and unknown-field warnings remain zero for 3 days with at least 300 requests
- **THEN** the model SHALL be eligible for `unknown_field_mode=enforce`

#### Scenario: Enforce promotion blocked
- **WHEN** any required test gate fails or soak gate is not satisfied
- **THEN** the model SHALL remain in `unknown_field_mode=warn`
