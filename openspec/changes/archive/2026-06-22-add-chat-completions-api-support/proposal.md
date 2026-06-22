## Why

The gateway currently supports `/responses` and `/v1/messages`, but clients that speak OpenAI Chat Completions directly cannot call the gateway at `/v1/chat/completions`.

Adding first-class `/v1/chat/completions` request support closes this compatibility gap and lets one gateway serve all three request surfaces against the same upstream model configuration.

## What Changes

- Add a public `POST /v1/chat/completions` route to the gateway.
- Reuse the existing OpenAI SDK-backed upstream transport for both streaming and non-streaming Chat Completions requests.
- Apply existing gateway model routing, upstream model mapping, base URL selection, and API key resolution to Chat Completions requests.
- Return OpenAI-compatible Chat Completions JSON and SSE stream output for clients using this route.
- Normalize validation and upstream transport failures to stable OpenAI-style error responses for `/v1/chat/completions` callers.

## Capabilities

### New Capabilities
- `chat-completions-client-api`: Add a client-facing `/v1/chat/completions` API surface with gateway-managed model routing, upstream dispatch, and response/stream compatibility.

### Modified Capabilities
- `openai-chat-completions-transport`: Extend endpoint-aware transport error normalization and routing guarantees to include direct `/v1/chat/completions` client calls.

## Impact

- Affected code:
  - `src/routes/responses.ts` (or route module where endpoint handlers are registered)
  - `src/upstream/chat-completions-client.ts` and shared dispatch wiring
  - Shared validation/error helpers used by endpoint handlers
  - `tests/server.test.ts` and related endpoint regression suites
- APIs:
  - Adds `POST /v1/chat/completions` on the gateway.
  - Existing `POST /responses`, `POST /v1/responses`, and `POST /v1/messages` remain unchanged.
- Dependencies:
  - No new external dependency required beyond existing OpenAI SDK transport path.
- Systems:
  - Gateway operators can expose one endpoint set for OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions clients against the same configured model catalog.
