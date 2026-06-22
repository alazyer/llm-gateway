## Context

The gateway already exposes `/responses` and `/v1/messages` and routes both through an internal Chat Completions dispatch path backed by the OpenAI SDK transport.

Today, clients that natively call `POST /v1/chat/completions` cannot use the gateway directly even though the upstream transport and model routing stack already support Chat Completions semantics.

This change adds a direct Chat Completions API surface while preserving existing endpoint behavior, model mapping, auth resolution, and error redaction guarantees.

## Goals / Non-Goals

**Goals:**
- Add first-class `POST /v1/chat/completions` gateway support for stream and non-stream requests.
- Reuse the existing OpenAI SDK transport adapter and shared model resolution path.
- Preserve endpoint-native OpenAI response and error envelopes for Chat Completions callers.
- Keep existing `/responses`, `/v1/responses`, and `/v1/messages` behaviors unchanged.

**Non-Goals:**
- Adding `POST /chat/completions` (no-version alias) in this change.
- Introducing new model configuration keys beyond currently supported routing/auth fields.
- Reworking `/responses` or `/v1/messages` translation behavior.

## Decisions

1. **Add a dedicated route handler for `/v1/chat/completions` in the existing route module**
   - **Rationale:** Keeps endpoint registration centralized and consistent with current `/responses` and `/v1/messages` handlers.
   - **Alternative considered:** Separate route file just for Chat Completions; rejected to avoid duplicating shared helper wiring.

2. **Use pass-through Chat Completions request handling with shared validation and model resolution**
   - **Rationale:** Chat Completions is already the internal canonical transport shape; no translation layer is required.
   - **Alternative considered:** Transform request into an intermediate DTO then back; rejected as unnecessary indirection.

3. **Reuse OpenAI SDK transport for both stream and non-stream execution paths**
   - **Rationale:** Existing transport contract already supports `stream=true|false` behavior and upstream error handling.
   - **Alternative considered:** Add a second transport path for direct Chat Completions endpoint calls; rejected due to divergence risk.

4. **Extend endpoint-aware error normalization to include `/v1/chat/completions`**
   - **Rationale:** Clients expect OpenAI-style error envelopes from this endpoint and must not receive `/responses` or Anthropic-specific shapes.
   - **Alternative considered:** Return raw upstream SDK errors; rejected because it leaks transport details and can break client compatibility.

## Risks / Trade-offs

- **[Route regression risk]** New route wiring could accidentally impact existing endpoint registration order → **Mitigation:** add route-level regression tests for all endpoint families.
- **[Streaming framing mismatch]** Stream chunks could be incorrectly transformed instead of passed through → **Mitigation:** add stream tests asserting OpenAI Chat Completions SSE contract.
- **[Error shape drift]** Shared error handlers may return non-OpenAI envelope for this route → **Mitigation:** add endpoint-specific error mapping tests for validation and upstream failures.

## Migration Plan

1. Add `/v1/chat/completions` handler and register route.
2. Wire handler into existing model resolution + OpenAI SDK transport path.
3. Extend endpoint-aware error normalization logic for direct Chat Completions calls.
4. Add non-stream and stream regression tests for success and failure paths.
5. Release as additive API support (no migration needed for existing clients).

Rollback strategy:
- Remove route registration and handler wiring for `/v1/chat/completions` while keeping all existing endpoints untouched.

## Open Questions

- Should the gateway also expose `POST /chat/completions` as a compatibility alias in a future change? (Out of scope here.)
