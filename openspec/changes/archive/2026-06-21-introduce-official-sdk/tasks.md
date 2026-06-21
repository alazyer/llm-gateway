## 1. SDK Transport Foundation

- [x] 1.1 Add `openai` and `@anthropic-ai/sdk` dependencies and update lockfile
- [x] 1.2 Introduce an OpenAI SDK chat-completions transport adapter in `src/upstream/`
- [x] 1.3 Keep/define a transport interface so routes/translators remain SDK-agnostic
- [x] 1.4 Map SDK transport failures into existing endpoint-native error paths

## 2. Configuration and Capability Controls

- [x] 2.1 Extend model config schema with `supports_tools` and `supports_streaming` (default `true`)
- [x] 2.2 Extend model config schema with `unknown_field_mode: warn|enforce` (default `warn`)
- [x] 2.3 Update config examples/docs to show per-model rollout and capability flags
- [x] 2.4 Add config validation tests for defaults and invalid enum values

## 3. `/responses` Translation and Strictness

- [x] 3.1 Route `/responses` and `/v1/responses` through SDK-backed chat-completions dispatch
- [x] 3.2 Enforce top-level unknown-field detection for `/responses` request bodies
- [x] 3.3 Implement `warn` mode: ignore unknown top-level fields and log names+count only
- [x] 3.4 Implement `enforce` mode: return HTTP 400 with `{ "error": "Unknown /responses fields.", "unknown_fields": [...] }`
- [x] 3.5 Add pre-dispatch rejections for unsupported tools/streaming using per-model flags

## 4. `/v1/messages` Anthropic Boundary and Bridge

- [x] 4.1 Apply Anthropic SDK-compatible validation/normalization for `/v1/messages` inputs
- [x] 4.2 Keep `/v1/messages` unknown-field strictness unchanged (no new strict rollout here)
- [x] 4.3 Ensure Anthropic → Chat Completions request translation feeds SDK transport
- [x] 4.4 Ensure Chat Completions → Anthropic response translation covers stop reason, usage, and errors
- [x] 4.5 Ensure streaming emits minimum required Anthropic event sequence

## 5. Observability and Rollout Guardrails

- [x] 5.1 Add structured warning logs for unknown `/responses` fields (names+count only)
- [x] 5.2 Add telemetry counters for warn/enforce unknown-field occurrences per model
- [x] 5.3 Document enforce promotion gate requirements (tests + soak window)
- [x] 5.4 Add operator runbook notes for moving a model from `warn` to `enforce`

## 6. Verification and Compatibility Tests

- [x] 6.1 Update/add `/responses` non-stream tests for SDK transport path
- [x] 6.2 Update/add `/responses` streaming tests for SDK transport path
- [x] 6.3 Update/add `/v1/messages` non-stream tests for translation and Anthropic envelope fidelity
- [x] 6.4 Update/add `/v1/messages` streaming tests for mandated event ordering
- [x] 6.5 Add tests for capability-gate rejections (`supports_tools`, `supports_streaming`)
- [x] 6.6 Add tests for `unknown_field_mode` warn/enforce behavior and 400 payload shape
