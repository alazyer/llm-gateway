## ADDED Requirements

### Requirement: Chain execution SHALL try models in priority order with sequential fallback
The chain executor SHALL iterate through the chain's models in the order defined by the `models` list. For each model:
1. Construct the upstream request using that model's config.
2. Execute the request with the model's effective timeout and retry settings.
3. If the request succeeds, return the response.
4. If the request fails with a retryable error, advance to the next model.
5. If the request fails with a non-retryable error, stop and return that error to the caller.

#### Scenario: First model succeeds
- **WHEN** a chain with models `[gpt-5, glm-5.1]` is executed and the request to `gpt-5` succeeds
- **THEN** the executor SHALL return the `gpt-5` response and SHALL NOT attempt `glm-5.1`

#### Scenario: First model fails with retryable error, second succeeds
- **WHEN** a chain with models `[gpt-5, glm-5.1]` is executed, the request to `gpt-5` returns HTTP 503, and the request to `glm-5.1` succeeds
- **THEN** the executor SHALL return the `glm-5.1` response with `x-chain-model: glm-5.1`

#### Scenario: All models fail with retryable errors
- **WHEN** a chain with models `[gpt-5, glm-5.1]` is executed and both models return retryable errors
- **THEN** the executor SHALL throw a `ChainExhaustedError` containing the chain name, the number of models tried, and an `attempts` array with each model's name and error

#### Scenario: Non-retryable error stops the chain immediately
- **WHEN** a chain with models `[gpt-5, glm-5.1]` is executed and `gpt-5` returns HTTP 401
- **THEN** the executor SHALL stop immediately and SHALL NOT attempt `glm-5.1`; the 401 error SHALL be returned to the caller unchanged

### Requirement: Retryable errors SHALL include HTTP 429, 502, 503, and timeout/504
The following errors SHALL be considered retryable for chain fallback purposes:
- HTTP 429 (rate limit)
- HTTP 502 (bad gateway)
- HTTP 503 (service unavailable)
- HTTP 504 / timeout (gateway timeout)
- Network errors (connection reset, DNS failure, etc.) — represented as non-`APIError` failures from the `ChatCompletionsClient`

All other HTTP status codes and `RouteError` status codes SHALL be considered non-retryable.

#### Scenario: HTTP 429 is retryable
- **WHEN** a model in a chain returns HTTP 429
- **THEN** the executor SHALL advance to the next model in the chain

#### Scenario: HTTP 400 is non-retryable
- **WHEN** a model in a chain returns HTTP 400
- **THEN** the executor SHALL stop the chain and return the 400 error to the caller

#### Scenario: Network error is retryable
- **WHEN** a model in a chain fails with a connection error (not an `APIError`)
- **THEN** the executor SHALL advance to the next model in the chain

### Requirement: Per-model timeout and retry settings SHALL override chain and gateway defaults
When executing a specific model in a chain, the effective timeout SHALL be resolved as: model-in-chain `timeout_ms` → chain `timeout_ms` → gateway `request_timeout_ms`. The effective retry count SHALL be resolved as: model-in-chain `max_retries` → chain `max_retries` → gateway `max_retries`.

#### Scenario: Per-model timeout overrides chain default
- **WHEN** a chain specifies `timeout_ms: 30000` and a model entry within the chain specifies `timeout_ms: 60000`
- **THEN** that model SHALL be called with a 60000ms timeout, while other models in the chain use 30000ms

#### Scenario: Chain default overrides gateway default
- **WHEN** the gateway `request_timeout_ms` is 30000 and a chain specifies `timeout_ms: 60000` with no per-model overrides
- **THEN** all models in the chain SHALL use 60000ms timeout

#### Scenario: No overrides — gateway default applies
- **WHEN** neither the chain nor any model entry specifies `timeout_ms` or `max_retries`
- **THEN** all models in the chain SHALL use the gateway-level `request_timeout_ms` and `max_retries`

### Requirement: Chain timeout budget SHALL bound total execution time
When `chain_timeout_ms` is configured on a chain, the executor SHALL track total elapsed wall-clock time from the start of chain execution. If the elapsed time exceeds `chain_timeout_ms` at any point (before starting a new model attempt, or after a model attempt completes), the executor SHALL stop and return HTTP 504 with a `ChainBudgetExceededError`.

#### Scenario: Budget exceeded before next model attempt
- **WHEN** a chain specifies `chain_timeout_ms: 40000`, the first model times out after 35000ms, and 5000ms remains (less than the next model's timeout of 30000ms)
- **THEN** the executor SHALL NOT attempt the next model and SHALL return HTTP 504

#### Scenario: Budget not exceeded — next model attempted
- **WHEN** a chain specifies `chain_timeout_ms: 90000`, the first model fails after 10000ms, and 80000ms remains (sufficient for the next model's timeout of 30000ms)
- **THEN** the executor SHALL attempt the next model in the chain

### Requirement: Streaming chain execution SHALL commit on first successful chunk
For streaming requests resolved to a chain:
1. The executor SHALL try models in order.
2. If a model fails before producing the first SSE chunk (retryable error), advance to the next model.
3. Once the first SSE chunk from any model is received, the executor SHALL commit to that model and stream all subsequent chunks from it to the client.
4. If the stream breaks after the first chunk, the executor SHALL terminate the client stream with an SSE error event containing the chain name, the serving model name, and the error details. The executor SHALL NOT attempt fallback.

#### Scenario: Streaming — first model fails before first chunk, second succeeds
- **WHEN** a streaming chain request with models `[gpt-5, glm-5.1]` is executed, `gpt-5` returns HTTP 503 before any SSE data, and `glm-5.1` produces a valid stream
- **THEN** the gateway SHALL stream `glm-5.1`'s response to the client with `x-chain-model: glm-5.1`

#### Scenario: Streaming — first model streams successfully from start
- **WHEN** a streaming chain request with models `[gpt-5, glm-5.1]` is executed and `gpt-5` produces a valid stream from the first chunk
- **THEN** the gateway SHALL stream `gpt-5`'s response to the client with `x-chain-model: gpt-5` and SHALL NOT attempt `glm-5.1`

#### Scenario: Streaming — stream breaks mid-way
- **WHEN** a streaming chain request is being served by `gpt-5` and the upstream stream breaks after 5 chunks
- **THEN** the gateway SHALL send an SSE error event to the client and SHALL NOT attempt fallback to `glm-5.1`

### Requirement: Chain execution SHALL log each model attempt
The chain executor SHALL emit a structured log entry for each model attempt, including: the chain name, the model name, the attempt index (1-based), and the outcome (success, retryable-error with status code, non-retryable-error with status code, timeout, budget-exceeded).

#### Scenario: Successful attempt logged
- **WHEN** a chain executes and `glm-5.1` succeeds on attempt 2
- **THEN** the executor SHALL log `{chain: "production", model: "glm-5.1", attemptIndex: 2, outcome: "success"}`

#### Scenario: Retryable error logged
- **WHEN** a chain executes and `gpt-5` returns HTTP 503 on attempt 1
- **THEN** the executor SHALL log `{chain: "production", model: "gpt-5", attemptIndex: 1, outcome: "retryable-error", statusCode: 503}`

### Requirement: Chain-exhausted error SHALL return HTTP 502 with structured details
When all models in a chain fail with retryable errors, the executor SHALL throw a `ChainExhaustedError` that the route handler translates to an HTTP 502 response. The response body SHALL include:
- `error`: a human-readable message
- `chain`: the chain name
- `modelsTried`: the number of models attempted
- `attempts`: an array of `{model, statusCode, statusText}` for each failed model

#### Scenario: All models fail — 502 with attempt details
- **WHEN** a chain `production` with models `[gpt-5, glm-5.1]` is executed and both fail (gpt-5 returns 503, glm-5.1 returns 429)
- **THEN** the gateway SHALL return HTTP 502 with body containing `chain: "production"`, `modelsTried: 2`, and `attempts: [{model: "gpt-5", statusCode: 503, ...}, {model: "glm-5.1", statusCode: 429, ...}]`

#### Scenario: Non-retryable error — original status code preserved
- **WHEN** a chain `production` with models `[gpt-5, glm-5.1]` is executed and `gpt-5` returns HTTP 401
- **THEN** the gateway SHALL return HTTP 401 with the original upstream error body, not a 502 chain-exhausted response

### Requirement: Chain-budget-exceeded error SHALL return HTTP 504
When a chain execution exceeds its `chain_timeout_ms` budget, the gateway SHALL return HTTP 504 with a body containing `error: "Chain timeout budget exceeded"` and the chain name.

#### Scenario: Budget exceeded — 504 returned
- **WHEN** a chain execution exceeds `chain_timeout_ms`
- **THEN** the gateway SHALL return HTTP 504 with `{error: "Chain timeout budget exceeded", chain: "<name>"}`
