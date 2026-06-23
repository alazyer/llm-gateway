## Purpose
Define gateway request ID propagation to upstream and per-request upstream latency logging for observability.

## ADDED Requirements

### Requirement: Gateway request IDs SHALL be propagated to upstream as X-Request-ID header
The gateway SHALL pass its internal Fastify request ID as an `X-Request-ID` header on all upstream Chat Completions calls.

#### Scenario: Request ID included in upstream call
- **WHEN** the gateway dispatches any upstream Chat Completions request
- **THEN** the request SHALL include an `X-Request-ID` header with the Fastify request ID value

#### Scenario: Request ID absent on upstream error
- **WHEN** upstream fails and the gateway logs the error
- **THEN** the log SHALL include the request ID for correlation

### Requirement: Upstream latency SHALL be logged per request
The gateway SHALL log the elapsed time between dispatching an upstream request and receiving the response (or first stream chunk) for observability.

#### Scenario: Non-stream latency logged
- **WHEN** a non-stream upstream request completes
- **THEN** the gateway SHALL log the total upstream response time in milliseconds

#### Scenario: Stream first-byte latency logged
- **WHEN** a streaming upstream request produces its first chunk
- **THEN** the gateway SHALL log the time-to-first-byte latency in milliseconds
