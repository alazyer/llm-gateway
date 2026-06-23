## Purpose
Define upstream transport resilience: configurable timeouts, retry with backoff, and stream abort on client disconnect.

## ADDED Requirements

### Requirement: Upstream requests SHALL time out after a configurable duration
The gateway SHALL enforce a configurable request timeout on all upstream Chat Completions calls (both stream and non-stream). Default timeout SHALL be 30 seconds.

#### Scenario: Non-stream request exceeds timeout
- **WHEN** an upstream non-stream request does not respond within `request_timeout_ms`
- **THEN** the gateway SHALL abort the request and return a 504 Gateway Timeout error to the client

#### Scenario: Stream request exceeds timeout for initial response
- **WHEN** an upstream stream request does not produce the first chunk within `request_timeout_ms`
- **THEN** the gateway SHALL abort the request and return a 504 Gateway Timeout error to the client

#### Scenario: Timeout not configured defaults to 30s
- **WHEN** `request_timeout_ms` is not set in gateway configuration
- **THEN** the gateway SHALL use a default timeout of 30000ms

### Requirement: Upstream requests SHALL retry on transient failures with backoff
The gateway SHALL retry upstream Chat Completions calls on transient HTTP errors (429, 502, 503) with configurable retry count and exponential backoff. Default SHALL be 0 retries (no retry).

#### Scenario: 429 rate-limit triggers retry
- **WHEN** upstream returns HTTP 429 and `max_retries` > 0
- **THEN** the gateway SHALL retry the request after backoff delay without forwarding the 429 to the client

#### Scenario: 502/503 triggers retry
- **WHEN** upstream returns HTTP 502 or 503 and `max_retries` > 0
- **THEN** the gateway SHALL retry the request after backoff delay

#### Scenario: All retries exhausted
- **WHEN** all retry attempts fail
- **THEN** the gateway SHALL return the last upstream error to the client

#### Scenario: Retries not configured
- **WHEN** `max_retries` is not set or is 0
- **THEN** the gateway SHALL not retry and SHALL forward the upstream error immediately

### Requirement: Streaming responses SHALL abort upstream on client disconnect
The gateway SHALL detect client disconnect during streaming and abort the upstream connection to release resources.

#### Scenario: Client disconnects mid-stream
- **WHEN** the client connection closes while upstream is still streaming
- **THEN** the gateway SHALL abort the upstream ReadableStream reader and release all resources

#### Scenario: Client stays connected through full stream
- **WHEN** the client receives the full streaming response
- **THEN** the gateway SHALL complete the stream normally without premature abort
