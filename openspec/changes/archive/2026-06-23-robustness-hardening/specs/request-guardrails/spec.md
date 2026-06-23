## Purpose
Define request body size limits, unknown-field counter bounds, and client disconnect cleanup to prevent resource exhaustion.

## ADDED Requirements

### Requirement: The gateway SHALL enforce configurable request body size limits
The gateway SHALL reject requests whose body exceeds a configurable size limit. Default SHALL be 1MB (1024KB).

#### Scenario: Request body exceeds limit
- **WHEN** a request body exceeds `max_body_size_kb`
- **THEN** the gateway SHALL return HTTP 413 Payload Too Large with an error message

#### Scenario: Request body within limit
- **WHEN** a request body is within `max_body_size_kb`
- **THEN** the gateway SHALL process the request normally

#### Scenario: Size limit not configured defaults to 1MB
- **WHEN** `max_body_size_kb` is not set in gateway configuration
- **THEN** the gateway SHALL use a default limit of 1024KB

### Requirement: Unknown-field counters SHALL be bounded and reset periodically
The `unknownFieldCounters` Map SHALL not grow unboundedly. Each model's counter SHALL reset after a configurable observation window.

#### Scenario: Counter resets after observation window
- **WHEN** the unknown-field counter for a model has been active for longer than the observation window
- **THEN** the gateway SHALL reset the counter to zero

#### Scenario: Counter accumulates within window
- **WHEN** unknown fields are detected within the observation window
- **THEN** the counter SHALL increment normally without reset

#### Scenario: Multiple models tracked independently
- **WHEN** different models receive requests with unknown fields
- **THEN** each model SHALL have its own independent counter and observation window
