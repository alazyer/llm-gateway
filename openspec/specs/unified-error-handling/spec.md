# unified-error-handling Specification

## Purpose
A single parameterized error sender and a single tools-detection predicate, replacing three duplicated copies of each. This is a pure refactor — no behavior changes.

## Requirements

### Requirement: Error sender SHALL be a single parameterized function

The gateway SHALL use a single `sendRouteError` function with a `format` parameter instead of three separate error sender functions. The function SHALL produce identical HTTP responses to the three original functions for each format.

#### Scenario: Gateway format matches original sendError output
- **WHEN** `sendRouteError` is called with `format: "gateway"` and an `UpstreamHttpError`
- **THEN** the response body SHALL be `{ error: "Upstream request failed.", upstream: { statusCode, statusText } }`
- **AND** the status code SHALL be the upstream status code

#### Scenario: Gateway format matches original sendError for RouteError
- **WHEN** `sendRouteError` is called with `format: "gateway"` and a `RouteError`
- **THEN** the response body SHALL be `{ error: message, ...details }`
- **AND** the status code SHALL be the `RouteError.statusCode`

#### Scenario: Gateway format matches original sendError for unknown errors
- **WHEN** `sendRouteError` is called with `format: "gateway"` and a generic `Error`
- **THEN** the response body SHALL be `{ error: message }`
- **AND** the status code SHALL be 500

#### Scenario: Anthropic format matches original sendAnthropicError output
- **WHEN** `sendRouteError` is called with `format: "anthropic"` and an `UpstreamHttpError`
- **THEN** the response body SHALL be `{ type: "error", error: { type: "api_error", message: "Upstream request failed." } }`

#### Scenario: Anthropic format matches original sendAnthropicError for RouteError
- **WHEN** `sendRouteError` is called with `format: "anthropic"` and a `RouteError` with statusCode < 500
- **THEN** the response body SHALL be `{ type: "error", error: { type: "invalid_request_error", message } }`

#### Scenario: Anthropic format matches original sendAnthropicError for RouteError >= 500
- **WHEN** `sendRouteError` is called with `format: "anthropic"` and a `RouteError` with statusCode >= 500
- **THEN** the response body SHALL be `{ type: "error", error: { type: "api_error", message } }`

#### Scenario: OpenAI format matches original sendOpenAiError output
- **WHEN** `sendRouteError` is called with `format: "openai"` and an `UpstreamHttpError`
- **THEN** the response body SHALL be `{ error: { message: "Upstream request failed.", type: "api_error" } }`

#### Scenario: OpenAI format matches original sendOpenAiError for RouteError
- **WHEN** `sendRouteError` is called with `format: "openai"` and a `RouteError` with statusCode < 500
- **THEN** the response body SHALL be `{ error: { message, type: "invalid_request_error" } }`

#### Scenario: OpenAI format matches original sendOpenAiError for RouteError >= 500
- **WHEN** `sendRouteError` is called with `format: "openai"` and a `RouteError` with statusCode >= 500
- **THEN** the response body SHALL be `{ error: { message, type: "api_error" } }`

#### Scenario: All formats set correct content-type header
- **WHEN** `sendRouteError` is called with any format
- **THEN** the response content-type SHALL be `application/json; charset=utf-8`

### Requirement: Tools-detection predicate SHALL be a single unified function

The gateway SHALL use a single `requestUsesTools` function instead of three separate `*RequestUsesTools` functions. The function SHALL accept `{ tools?: unknown[]; tool_choice?: unknown }` and return `boolean`.

#### Scenario: Tools array is non-empty
- **WHEN** `requestUsesTools` is called with `{ tools: [{ type: "function", name: "fn" }] }`
- **THEN** it SHALL return `true`

#### Scenario: Tools array is empty
- **WHEN** `requestUsesTools` is called with `{ tools: [] }`
- **THEN** it SHALL return `false`

#### Scenario: Tool choice is not "none"
- **WHEN** `requestUsesTools` is called with `{ tool_choice: "auto" }` (no tools array)
- **THEN** it SHALL return `true`

#### Scenario: Tool choice is "none"
- **WHEN** `requestUsesTools` is called with `{ tool_choice: "none" }` (no tools array)
- **THEN** it SHALL return `false`

#### Scenario: Neither tools nor tool_choice
- **WHEN** `requestUsesTools` is called with `{}`
- **THEN** it SHALL return `false`

#### Scenario: Tool choice is a named function object
- **WHEN** `requestUsesTools` is called with `{ tool_choice: { type: "function", function: { name: "fn" } } }`
- **THEN** it SHALL return `true`

### Requirement: Existing error-handling behavior SHALL be preserved

All existing tests for error responses SHALL pass without modification after the refactor.

#### Scenario: Server integration tests pass unchanged
- **WHEN** `npm test` is run after the refactor
- **THEN** all existing error-handling tests SHALL pass with identical assertions
