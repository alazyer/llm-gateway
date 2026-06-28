## 1. Legal and Scope Gate

- [x] 1.1 Obtain legal approval for proxying GitHub Copilot model responses through llm-gateway to external CLI tools
- [x] 1.2 Document the approved usage constraints in the change implementation notes or project documentation before enabling runtime behavior
- [x] 1.3 If approval is denied, close this change without implementing Copilot proxy runtime code

## 2. Workspace and Shared Protocol

- [x] 2.1 Convert the repository to an npm workspace layout that preserves the existing gateway package behavior and scripts
- [x] 2.2 Create a shared TypeScript package or module for Copilot proxy protocol types with no Fastify or VS Code runtime dependencies
- [x] 2.3 Define WebSocket message types for `register`, `status_update`, `request`, `cancel`, `ping`, `pong`, `stream_delta`, `stream_done`, `stream_error`, and `disconnect`
- [x] 2.4 Define shared Copilot model metadata, capability metadata, stream content types, usage payloads, error payloads, and proxy-token payload types
- [x] 2.5 Add protocol type tests or compile-time fixtures covering valid and invalid message shapes
- [x] 2.6 Update TypeScript build configuration so the shared package builds before the gateway and VS Code extension packages

## 3. Gateway Proxy Token Auth

- [x] 3.1 Add gateway configuration for enabling the Copilot proxy, proxy-token lifetime, WebSocket heartbeat interval, heartbeat timeout, and per-extension capacity limits
- [x] 3.2 Implement scoped proxy-token issuance behind existing gateway HTTP auth
- [x] 3.3 Implement proxy-token validation for `/ws/copilot-proxy` without granting HTTP data-endpoint access to proxy tokens
- [x] 3.4 Ensure Copilot or VS Code credentials are never accepted, logged, stored, or forwarded by the gateway
- [x] 3.5 Add tests for authenticated token issuance, unauthenticated token rejection, expiry handling, and token scope separation
- [x] 3.6 Update example configuration and documentation for proxy-token settings

## 4. Gateway WebSocket Protocol Server

- [x] 4.1 Add a WebSocket dependency and register `/ws/copilot-proxy` on the Fastify gateway
- [x] 4.2 Implement WebSocket connection authentication and connection lifecycle logging with secret redaction
- [x] 4.3 Implement registration handling and validation for extension metadata, Copilot status, and model capability payloads
- [x] 4.4 Implement ping/pong heartbeat and mark connections unhealthy when heartbeat deadlines are missed
- [x] 4.5 Implement request dispatch, in-flight request tracking, ordered frame handling, terminal frame cleanup, and unknown-frame protocol errors
- [x] 4.6 Implement cancellation forwarding for client disconnects and released gateway requests
- [x] 4.7 Add WebSocket protocol tests using a mock extension client for connect, register, heartbeat, stream success, stream error, cancellation, and disconnect

## 5. Gateway Copilot Model Registry

- [x] 5.1 Implement an in-memory Copilot extension connection registry keyed by connection ID
- [x] 5.2 Implement dynamic model registration replacement per connection and immediate model removal on disconnect
- [x] 5.3 Enforce public `copilot-` model naming and reject invalid or unprefixed registration IDs
- [x] 5.4 Merge available Copilot models into `GET /models`, `GET /v1/models`, and model detail endpoints with `source: "copilot-proxy"` metadata
- [x] 5.5 Preserve existing direct model records when a direct model and Copilot-backed model share the same native model name
- [x] 5.6 Apply extension-reported capability gates for streaming and tool support before dispatch
- [x] 5.7 Add tests for registration, re-registration, disconnect removal, model discovery output, collision handling, and capability rejection

## 6. Gateway Copilot Routing and Stream Translation

- [x] 6.1 Extend route selection so registered `copilot-*` models route to the Copilot proxy while non-Copilot models continue using the existing upstream transport
- [x] 6.2 Return endpoint-native HTTP 503 errors for `copilot-*` requests when no healthy extension can serve the requested model
- [x] 6.3 Select a healthy least-loaded capable extension when multiple extensions register the same Copilot model
- [x] 6.4 Translate `/responses` and `/v1/responses` non-stream Copilot proxy frames into Responses-compatible JSON responses
- [x] 6.5 Translate `/responses` and `/v1/responses` stream Copilot proxy frames into Responses-compatible SSE lifecycle events and errors
- [x] 6.6 Translate `/v1/chat/completions` non-stream Copilot proxy frames into OpenAI-compatible JSON responses
- [x] 6.7 Translate `/v1/chat/completions` stream Copilot proxy frames into OpenAI-compatible SSE chunks, terminal events, and errors
- [x] 6.8 Translate `/v1/messages` non-stream Copilot proxy frames into Anthropic-compatible message responses
- [x] 6.9 Translate `/v1/messages` stream Copilot proxy frames into the required Anthropic lifecycle events and endpoint-native errors
- [x] 6.10 Forward HTTP client disconnects as WebSocket `cancel` frames and ignore late frames for released request IDs
- [x] 6.11 Add route tests for Responses non-stream, Responses stream, OpenAI non-stream, OpenAI stream, Anthropic non-stream, Anthropic stream, unavailable model, extension disconnect mid-stream, and multi-extension load selection

## 7. VS Code Extension Package

- [x] 7.1 Create `packages/vscode-extension` with VS Code extension manifest, TypeScript config, build script, test script, activation entrypoint, and packaging script
- [x] 7.2 Add extension configuration for gateway URL, proxy token, reconnect limits, and status output
- [x] 7.3 Implement extension activation, deactivation, command registration, and clean WebSocket disconnect behavior
- [x] 7.4 Implement a status bar controller showing connected, disconnected, retrying, gateway error, and Copilot unavailable states
- [x] 7.5 Add extension logging/output channel with redaction for proxy tokens and request payload secrets
- [x] 7.6 Add extension unit tests for configuration loading, lifecycle state transitions, and status rendering

## 8. VS Code WebSocket Client and Reconnect

- [x] 8.1 Implement the extension WebSocket client for `/ws/copilot-proxy`
- [x] 8.2 Send registration after connection and after every successful reconnect before accepting requests
- [x] 8.3 Respond to gateway `ping` frames with `pong` frames before heartbeat timeout
- [x] 8.4 Implement bounded exponential reconnect backoff with a 30-second maximum delay
- [x] 8.5 Handle proxy-token expiry by stopping proxy traffic and surfacing a re-authentication or token-refresh action
- [x] 8.6 Add tests using a mock gateway WebSocket server for connect, reconnect, registration, ping/pong, token expiry, and clean disconnect

## 9. VS Code Copilot Bridge and Stream Adapter

- [x] 9.1 Implement Copilot model discovery through `vscode.lm.selectChatModels()` or the current stable VS Code language model API
- [x] 9.2 Map discovered Copilot model identifiers to gateway `copilot-*` model IDs and report supported capabilities conservatively
- [x] 9.3 Poll or subscribe for Copilot availability changes and send updated registrations or status updates
- [x] 9.4 Translate gateway request frames into `vscode.lm` chat request messages, parameters, and supported tool definitions
- [x] 9.5 Execute Copilot requests through `vscode.lm` and stream text, tool-call, progress, usage, done, and error frames back to the gateway
- [x] 9.6 Implement request cancellation using the VS Code API cancellation mechanism where available
- [x] 9.7 Add tests with mocked `vscode.lm` for model discovery, unavailable Copilot, text streaming, tool support, unsupported tools, usage reporting, errors, and cancellation

## 10. Integration and Documentation

- [x] 10.1 Add integration tests with a mock extension connection proving end-to-end `copilot-*` request flow through `/v1/chat/completions`
- [x] 10.2 Add integration tests with a mock extension connection proving end-to-end `copilot-*` request flow through `/v1/messages`
- [x] 10.3 Add integration tests with a mock extension connection proving end-to-end `copilot-*` request flow through `/v1/responses`
- [x] 10.4 Add an operator setup guide for enabling the Copilot proxy, issuing proxy tokens, configuring the VS Code extension, and interpreting status/errors
- [x] 10.5 Document failure modes: extension disconnected, Copilot signed out, gateway unreachable, proxy token expired, stream interrupted, unsupported tools, and capacity exhausted
- [x] 10.6 Document that Copilot auth remains managed by VS Code and must not be exported or stored in gateway configuration
- [x] 10.7 Run gateway tests, extension tests, shared package tests, TypeScript builds, and VS Code extension packaging
- [x] 10.8 Validate the OpenSpec change with `openspec validate add-copilot-proxy-extension`
