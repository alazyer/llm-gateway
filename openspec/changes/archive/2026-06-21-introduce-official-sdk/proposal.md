## Why

Our gateway exists because upstream model providers may only expose OpenAI `/v1/chat/completions`. We still need to support client-facing `/responses` and `/v1/messages` contracts.

To do this safely and consistently, gateway requests should be translated into `/v1/chat/completions` requests for upstream execution, then translated back to endpoint-native responses.

At the same time, `/v1/messages` must preserve Anthropic-native request/response behavior for clients (e.g., Claude Code), so we also need the official Anthropic SDK at the gateway boundary for schema/streaming fidelity while translating through OpenAI chat completions internally.

## What Changes

- Introduce an upstream adapter built on the official OpenAI SDK.
- Introduce an Anthropic SDK-backed boundary adapter for `/v1/messages` request/response handling.
- Route `/responses` through this lifecycle:
  1. Accept OpenAI Responses-formatted request,
  2. Translate to OpenAI Chat Completions request,
  3. Send upstream via OpenAI SDK `/v1/chat/completions`,
  4. Translate upstream response/stream events back to OpenAI Responses format.
- Route `/v1/messages` handling through this lifecycle:
  1. Accept Anthropic-formatted request,
  2. Normalize/validate via Anthropic SDK contract,
  3. Translate to OpenAI Chat Completions request shape,
  4. Send upstream via OpenAI SDK `/v1/chat/completions`,
  5. Translate OpenAI response back to Anthropic response format.
- Preserve existing gateway model resolution and auth/config controls while delegating boundary and transport details to official SDKs.
- Normalize gateway errors and streaming output so downstream clients (e.g., Codex/Claude Code) receive stable endpoint-correct wire behavior.

## Capabilities

### New Capabilities
- `openai-chat-completions-transport`: Add an official OpenAI SDK-backed upstream client for `/v1/chat/completions` execution, streaming, and error mapping.
- `anthropic-sdk-boundary-contract`: Add Anthropic SDK-backed request/response contract handling for `/v1/messages`.
- `anthropic-chatcompletions-translation-bridge`: Ensure `/v1/messages` requests are translated Anthropic → Chat Completions for upstream calls and Chat Completions → Anthropic for responses, including streaming events.
- `responses-chatcompletions-translation-bridge`: Ensure `/responses` requests are translated Responses → Chat Completions and upstream results are translated back to Responses format.

### Modified Capabilities
- _None yet (no existing published capability specs under `openspec/specs/`)._

## Impact

- Affected code:
  - `src/routes/responses.ts` (endpoint handlers for `/responses`, `/v1/messages`)
  - `src/upstream/*` (OpenAI SDK Chat Completions transport client abstraction and wiring)
  - `src/translation/anthropic/*` (Anthropic ↔ OpenAI request/response/stream translation)
  - `src/translation/*` (Responses ↔ Chat Completions translation)
- APIs:
  - Public gateway routes remain `/responses`, `/v1/responses`, `/v1/messages`.
  - Both `/responses` and `/v1/messages` are internally bridged through upstream `/v1/chat/completions`.
  - `/v1/messages` remains Anthropic-compatible externally.
- Dependencies:
  - Add official `openai` and `@anthropic-ai/sdk` packages.
- Systems:
  - Gateway runtime configuration may need OpenAI SDK transport options (timeouts/retries/base URLs) aligned with configured OpenAI-compatible upstreams that expose `/v1/chat/completions`.
  - Anthropic boundary behavior (event framing/shape validation) should be explicitly pinned to SDK-supported contract versions.
