# gateway-auth-hardening Specification

## Purpose
Constant-time token comparison, per-IP rate limiting on data endpoints, and bounded token store for the copilot-proxy subsystem.

## Requirements

### Requirement: Auth token comparison SHALL use constant-time equality

The gateway SHALL compare the provided auth token against the configured gateway auth token using a constant-time comparison algorithm. This prevents timing side-channel attacks that could reveal the token character-by-character.

#### Scenario: Valid token accepted with constant-time comparison
- **WHEN** `gateway_auth_token_env` is configured and a request includes a matching auth token
- **THEN** the gateway SHALL process the request normally, and the comparison SHALL execute in constant time regardless of token content

#### Scenario: Invalid token rejected without timing variance
- **WHEN** `gateway_auth_token_env` is configured and a request includes a non-matching auth token
- **THEN** the gateway SHALL return HTTP 401, and the comparison time SHALL NOT vary based on the number of matching characters between the provided and expected tokens

#### Scenario: Token length mismatch handled safely
- **WHEN** the provided token length differs from the expected token length
- **THEN** the gateway SHALL still use constant-time comparison (by padding or truncating to the expected token length) and return HTTP 401

### Requirement: Gateway SHALL enforce per-IP rate limiting when auth is enabled

The gateway SHALL limit the number of requests per client IP address per minute on all POST data endpoints. Rate limiting SHALL only be active when `gateway_auth_token_env` is configured. When rate limiting is disabled (default), all requests pass through.

#### Scenario: Rate limit not configured — no limiting
- **WHEN** `rate_limit_rpm` is 0 or not configured
- **THEN** the gateway SHALL NOT enforce any rate limiting, regardless of auth status

#### Scenario: Rate limit configured and auth enabled — under limit
- **WHEN** `rate_limit_rpm` is set to N > 0 and `gateway_auth_token_env` is configured and a client IP has made fewer than N requests in the current minute
- **THEN** the gateway SHALL process the request normally

#### Scenario: Rate limit configured and auth enabled — over limit
- **WHEN** `rate_limit_rpm` is set to N > 0 and `gateway_auth_token_env` is configured and a client IP has made N or more requests in the current minute
- **THEN** the gateway SHALL return HTTP 429 with a `Retry-After` header

#### Scenario: Rate limit configured but auth disabled — no limiting
- **WHEN** `rate_limit_rpm` is set to N > 0 but `gateway_auth_token_env` is NOT configured
- **THEN** the gateway SHALL NOT enforce rate limiting (logged as a warning on startup)

#### Scenario: Rate limiting applies only to POST data endpoints
- **WHEN** rate limiting is active and a GET request is made to `/healthz`, `/models`, `/v1/models`, or `/models/:model`
- **THEN** the request SHALL NOT count against the rate limit

### Requirement: CopilotProxyTokenStore SHALL enforce a maximum token count

The token store SHALL reject new token issuance when the number of active (non-expired) tokens reaches the configured maximum. Expired tokens SHALL be pruned before checking the cap.

#### Scenario: Token issuance when under cap
- **WHEN** `maxTokens` is configured and the store contains fewer than `maxTokens` active tokens (after pruning expired)
- **THEN** `issueToken()` SHALL return a new token

#### Scenario: Token issuance when at cap
- **WHEN** `maxTokens` is configured and the store contains `maxTokens` active tokens (after pruning expired)
- **THEN** `issueToken()` SHALL return `undefined` and the `/api/proxy-token` endpoint SHALL return HTTP 429

#### Scenario: Expired tokens reclaimed before cap check
- **WHEN** the store is at cap but some tokens have expired
- **THEN** expired tokens SHALL be pruned first, potentially freeing slots, and issuance SHALL proceed if under cap after pruning

#### Scenario: Default maxTokens value
- **WHEN** `maxTokens` is not explicitly configured
- **THEN** the default SHALL be 10,000
