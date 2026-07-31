## Why

Today, llm-gateway routes every request to exactly one model. If that model's upstream is unavailable (429, 502, 503, timeout), the gateway returns an error to the caller — there is no fallback. Operators who want resilience must configure external load balancers or implement retry logic in every client.

A `model_chain` feature allows operators to define an ordered list of models that act as fallback priorities for a single logical endpoint. External tools reference the chain by name (`chain-<name>`), and the gateway tries each model in sequence until one succeeds. This provides built-in resilience without requiring client-side changes.

## What Changes

- Add a `model_chains` configuration section to `gateway.config.yaml` alongside the existing `models` section. Each chain entry has a `name` and an ordered `models` list referencing model names from the `models` catalog.
- Extend `resolveModel()` to recognise the `chain-<name>` naming convention and resolve it to a chain descriptor instead of a single model.
- Implement a sequential fallback loop in the request handlers: when a chain is resolved, try each model in order, advancing to the next on failure.
- Add per-chain and per-model-in-chain overrides for timeout and retry settings.
- Decide on streaming semantics: stream the first successful response; if the stream breaks mid-way, treat it as a partial response (no mid-stream fallback).
- Reject chain nesting (a chain referencing another chain) at config validation time.
- Expose chains in `/v1/models` (and `/models`) as virtual model entries with `type: "chain"`.
- Define clear error responses when all models in a chain fail vs. partial success.
- Preserve full backward compatibility — configs without `model_chains` work unchanged.

## Capabilities

### New Capabilities

- `model-chain-config`: YAML schema and validation rules for the `model_chains` section, including name uniqueness, model existence checks, and conflict detection with plain model names.
- `model-chain-resolution`: How `chain-<name>` is resolved alongside plain model names, including precedence rules and conflict detection.
- `model-chain-fallback`: Sequential fallback strategy, timeout/retry overrides, streaming behavior, and error semantics for chain execution.
- `model-chain-discovery`: How chains appear in model discovery endpoints (`/models`, `/v1/models`, model detail).

### Modified Capabilities

- `upstream-resilience`: The existing retry/timeout behavior applies per-model-within-chain; chain execution adds a second layer (model-to-model fallback) on top of the existing per-upstream retry.

## Impact

- **Code**: `src/config.ts` (schema + types), `src/routes/responses.ts` (resolveModel + handlers), `src/upstream/chat-completions-client.ts` (per-chain override threading). ~5–7 files touched, 1 new module (`src/chain-executor.ts`).
- **APIs**: No new endpoints. Existing model resolution extends to `chain-<name>`. Existing `/models` and `/v1/models` responses gain virtual chain entries.
- **Dependencies**: None.
- **Config**: New optional `model_chains` section in gateway YAML. Defaults to empty — no chains configured. Fully backward-compatible.
- **Systems**: No changes to external system requirements.
