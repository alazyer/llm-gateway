## Context

The gateway must expose two client-facing contracts (`/responses` and `/v1/messages`) while upstream providers may only support OpenAI `/v1/chat/completions`.

Current routing already centralizes model resolution and endpoint handling in `src/routes/responses.ts`, with translation helpers under `src/translation/*` and an HTTP-based upstream client under `src/upstream/*`.

This change introduces official SDK usage while preserving existing external endpoint contracts:
- OpenAI SDK is the canonical upstream transport for `/v1/chat/completions`.
- Anthropic SDK is the contract boundary for `/v1/messages` compatibility and event shape fidelity.

Stakeholders:
- Gateway consumers using OpenAI Responses clients (e.g., Codex tooling)
- Gateway consumers using Anthropic Messages clients (e.g., Claude Code)
- Gateway operators maintaining model/provider configs

Constraints:
- Upstream protocol remains `/v1/chat/completions` only
- Existing route surface (`/responses`, `/v1/responses`, `/v1/messages`) must stay stable
- Streaming behavior must remain endpoint-correct for both OpenAI Responses and Anthropic Messages clients

## Goals / Non-Goals

**Goals:**
- Use official OpenAI SDK for all upstream `/v1/chat/completions` calls (stream and non-stream).
- Use Anthropic SDK at the `/v1/messages` boundary to keep request/response and streaming semantics compatible.
- Keep a single internal canonical model for upstream dispatch (Chat Completions request/response stream events).
- Maintain current gateway model selection, logging, and error redaction behavior.
- Preserve backward compatibility of public endpoints and payload contracts.

**Non-Goals:**
- Adding native upstream `/responses` support (upstream remains chat-completions-only).
- Adding Anthropic-native upstream transport.
- Expanding to multimodal/tool types not already supported by existing gateway translation logic.
- Reworking gateway config schema beyond fields needed for SDK wiring.

## Decisions

1. **Adopt Chat Completions as canonical internal transport model**
   - **Decision:** Both endpoint families translate into an internal Chat Completions request representation before dispatch.
   - **Rationale:** Upstream capability is `/v1/chat/completions` only; canonicalizing reduces branching and duplicate transport code.
   - **Alternatives considered:**
     - Maintain separate internal models per endpoint (`responses` and `messages`) → rejected due to duplicated dispatch/error/stream logic.
     - Canonicalize to Responses internally → rejected because upstream does not support it.

2. **Use OpenAI SDK for upstream dispatch layer**
   - **Decision:** Replace/encapsulate raw HTTP upstream client with an OpenAI SDK-backed transport adapter for completion + streaming.
   - **Rationale:** Official SDK improves protocol alignment, retry/config behavior, and reduces manual HTTP drift.
   - **Alternatives considered:**
     - Keep custom fetch transport only → rejected; higher maintenance and protocol drift risk.

3. **Use Anthropic SDK at `/v1/messages` boundary (not upstream)**
   - **Decision:** `/v1/messages` ingress/egress semantics are validated/shaped according to Anthropic SDK expectations, then translated to/from Chat Completions.
   - **Rationale:** Ensures compatibility for Anthropic-native clients while respecting upstream constraints.
   - **Alternatives considered:**
     - Drop Anthropic SDK and hand-roll contract logic → rejected; weaker fidelity and higher maintenance burden.

4. **Keep endpoint-specific translators around a shared dispatch core**
   - **Decision:**
     - `/responses`: Responses ↔ Chat Completions translators
     - `/v1/messages`: Anthropic Messages ↔ Chat Completions translators
     - Shared dispatch core invokes OpenAI SDK transport.
   - **Rationale:** Clean separation between protocol adaptation and transport concerns.
   - **Alternatives considered:**
     - Monolithic route-level translation+dispatch implementation → rejected; harder testing and future extension.

5. **Standardize error/stream adaptation per endpoint contract**
   - **Decision:** Map transport/upstream failures into endpoint-native error envelopes and streaming event frames.
   - **Rationale:** Client compatibility depends on wire-level shape, not just final data payload.
   - **Alternatives considered:**
     - Return raw upstream errors/events → rejected; breaks endpoint contract guarantees.

## Risks / Trade-offs

- **[SDK abstraction mismatch]** OpenAI SDK and existing internal DTOs may not align 1:1 → **Mitigation:** add thin adapter types at transport boundary and contract tests for request/response mapping.
- **[Streaming edge cases]** Event ordering or terminal frames may diverge under translation → **Mitigation:** add golden streaming fixtures for `/responses` and `/v1/messages` covering tool calls, partial deltas, and end-of-stream markers.
- **[Behavior drift across SDK versions]** Upgrading official SDKs could subtly change behavior → **Mitigation:** pin versions, add compatibility tests, and document upgrade checklist.
- **[Increased dependency surface]** Two SDKs increase bundle/runtime footprint → **Mitigation:** isolate SDK usage in adapter modules and keep route/translation layers SDK-agnostic.
- **[Config complexity]** Operators may need SDK-specific options (timeouts/retries/base URL nuances) → **Mitigation:** expose minimal explicit config options and sensible defaults.

## Migration Plan

1. Add SDK dependencies (`openai`, `@anthropic-ai/sdk`) and introduce adapter modules in `src/upstream/`.
2. Keep existing translation functions as baseline and refactor dispatch path behind a transport interface.
3. Implement OpenAI SDK chat-completions transport adapter (non-stream + stream).
4. Wire `/responses` to use Responses → Chat Completions translator + SDK dispatch + Chat Completions → Responses translator.
5. Wire `/v1/messages` to use Anthropic boundary handling + Anthropic → Chat Completions translator + SDK dispatch + Chat Completions → Anthropic translator.
6. Add regression tests for both endpoint families (success, validation errors, upstream errors, streaming).
7. Release behind a feature flag (optional), compare behavior with current path, then make SDK path default.

Rollback strategy:
- Keep current HTTP transport implementation available until SDK path is validated.
- Toggle back to legacy transport path if major compatibility regressions are observed.

## Open Questions

None for this change scope. The following decisions are now fixed:

- Anthropic SDK is used for both `/v1/messages` runtime validation and outbound object/event construction.
- Anthropic streaming compatibility minimum is mandatory:
  `message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop`.
- Per-model capability gates are introduced with defaults:
  - `supports_tools: true`
  - `supports_streaming: true`
- Unknown top-level `/responses` fields use strict allowlist policy with per-model rollout:
  - Config key: `unknown_field_mode: warn | enforce` (default `warn`)
  - `warn`: ignore unknown fields and log warning (names + count only)
  - `enforce`: return HTTP 400 with payload
    `{ "error": "Unknown /responses fields.", "unknown_fields": ["..."] }`
- `/v1/messages` strict unknown-field symmetry is out of scope for this change and will be addressed separately.
- Promotion from `warn` to `enforce` for a model requires acceptance gates:
  - `/responses` regression tests pass (stream and non-stream)
  - `/v1/messages` regression tests pass (stream and non-stream)
  - Claude runtime compatibility tests pass
  - Soak gate: zero unknown-field warnings over 3 days and at least 300 requests for that model.

