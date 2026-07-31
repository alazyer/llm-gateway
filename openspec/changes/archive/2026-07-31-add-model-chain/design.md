## Context

The llm-gateway is a Fastify v5 proxy that translates between three client-facing API surfaces (`/responses`, `/v1/chat/completions`, `/v1/messages`) and a single upstream transport (OpenAI-compatible `/chat/completions`). All model resolution flows through `resolveModel()` in `src/routes/responses.ts`, which currently returns exactly one `GatewayModelConfig`. The upstream client (`ChatCompletionsClient`) implements per-request retry with exponential backoff on 429/502/503, but always against the same upstream — there is no model-switching logic anywhere.

Operators want a built-in fallback mechanism: define a chain of models, reference the chain by name, and let the gateway try each model in order until one succeeds.

## Goals / Non-Goals

**Goals:**
- Allow operators to define named, ordered model chains in the YAML config.
- Resolve `chain-<name>` as a first-class model identifier alongside plain model names.
- Implement sequential fallback: try model N, on failure advance to model N+1.
- Support per-chain and per-model-in-chain timeout and retry overrides.
- Stream the first successful response; no mid-stream fallback.
- Reject chain nesting at config validation time.
- Expose chains in model discovery endpoints.
- Full backward compatibility — no `model_chains` section means no change in behavior.

**Non-Goals:**
- Intelligent routing (cost-based, latency-based, or capacity-based model selection).
- Chain nesting (a chain whose `models` list references another chain).
- Mid-stream fallback (if a stream breaks after first byte, return partial + error metadata).
- Cross-provider translation within a single chain (all models in a chain must use the same upstream transport — OpenAI-compatible `/chat/completions`).
- Copilot-proxy models in chains (Copilot models are routed via WebSocket dispatch, not direct upstream; mixing them in a chain would require a fundamentally different dispatch path).
- Hot-reload of chain configuration (chains are loaded at startup; changing them requires a restart, same as all other YAML config).

## Decisions

### 1. `chain-` prefix as the naming convention for chain references

**Decision**: External tools reference a chain by using the prefix `chain-` followed by the chain's `name` (e.g., `chain-production`). This is consistent with the existing `copilot-` prefix convention for Copilot-proxied models and provides a clear, syntactic signal that the identifier is a chain, not a plain model.

**Rationale**: A prefix convention avoids introducing a new request field (like `chain` alongside `model`) and keeps the resolution logic simple: if the model string starts with `chain-`, resolve it as a chain; otherwise, resolve as a plain model. It also works transparently with all three API surfaces since they all accept a `model` string field.

**Alternative considered**: Add a separate `chain` field to the request body. Rejected because it would require changes to all three API request schemas and all client tools, breaking the "drop-in replacement" property.

### 2. No chain nesting — enforced at validation time

**Decision**: The `models` list in a chain entry MUST reference only model names from the `models` catalog. Referencing another chain name (i.e., a string starting with `chain-`) is a validation error that prevents startup.

**Rationale**: Nested chains create unbounded recursion risk and make timeout/retry semantics extremely hard to reason about. The primary use case is a flat priority list of concrete models. If operators need deeper composition, they can define multiple flat chains.

**Alternative considered**: Allow nesting with a max depth cap. Rejected because the complexity outweighs the marginal flexibility gain for a first implementation.

### 3. Sequential fallback with fail-fast advancement

**Decision**: When executing a chain, the gateway tries models in the order listed. For each model:
1. Send the request using that model's upstream config.
2. Apply per-model retry settings (defaulting to chain-level settings, then gateway-level).
3. Apply per-model timeout settings (defaulting to chain-level settings, then gateway-level).
4. If the request succeeds (HTTP 200 with valid response), return the response to the caller.
5. If the request fails with a **retryable error** (429, 502, 503, timeout/504, network error), advance to the next model.
6. If the request fails with a **non-retryable error** (400, 401, 403, 404, etc.), stop and return that error to the caller immediately — do NOT try the next model.

**Rationale**: Non-retryable errors indicate a problem with the request itself (bad auth, invalid params, model not found at upstream). Trying the next model with the same bad request would just produce another error, wasting time and tokens. Retryable errors indicate transient upstream problems, which is exactly the scenario fallback is designed for.

**Alternative considered**: Always try all models regardless of error type. Rejected because it delays the inevitable error response and could amplify rate-limit problems across multiple upstreams.

### 4. Streaming: first-success-wins, no mid-stream fallback

**Decision**: For streaming requests resolved to a chain:
1. Try model N in order.
2. If the upstream connection fails before the first SSE chunk (retryable error), advance to model N+1.
3. Once the first SSE chunk is received from the upstream, the gateway commits to that model and streams all chunks to the client.
4. If the stream breaks mid-way (connection reset, upstream error mid-stream), the gateway:
   - Terminates the stream to the client with an SSE error event.
   - Does NOT attempt to fallback to the next model (mid-stream fallback would require replaying partial context, which is not feasible without buffering the entire stream).
5. Include a `x-chain-model` response header indicating which model in the chain ultimately served the request, so callers can track which model responded.

**Rationale**: Mid-stream fallback is impractical for SSE streams because: (a) the client may have already processed partial output, (b) replaying from the beginning with a new model would duplicate output, (c) buffering the entire stream defeats the purpose of streaming. The first-success-wins approach is clean and predictable.

**Alternative considered**: Buffer the first model's full response before streaming, enabling fallback if the first model fails completely. Rejected because it defeats the latency benefit of streaming and would require the gateway to hold the entire response in memory.

### 5. Per-chain timeout/retry overrides with per-model granularity

**Decision**: Each chain entry MAY specify:
- `timeout_ms`: per-chain default timeout (overrides `request_timeout_ms` for all models in the chain unless a model-level override exists).
- `max_retries`: per-chain default retry count (overrides `max_retries` for all models in the chain unless a model-level override exists).
- Each entry in the chain's `models` list MAY specify `timeout_ms` and `max_retries` overrides that take precedence over the chain-level defaults.

The resolution order for any given model in a chain is:
`model-in-chain override → chain-level default → gateway-level default`

**Rationale**: Different models may have different latency profiles (e.g., a large model may need a longer timeout). Per-model overrides allow fine-tuning without forcing every model to use the same chain-level setting.

**Alternative considered**: Only chain-level overrides (no per-model granularity). Rejected because it's too coarse — a chain mixing fast and slow models would either timeout the slow model or over-wait on the fast one.

### 6. Chains appear as virtual models in discovery endpoints

**Decision**: When `model_chains` is configured, the `/models` and `/v1/models` endpoints SHALL include virtual model entries for each chain. These entries:
- Use `id: "chain-<name>"` as the model identifier.
- Set `object: "model"`.
- Set `owned_by: "llm-gateway-chain"`.
- Include a `capabilities` object with `supports_chain: true` and `supports_streaming: true` / `supports_tools: true` derived from the first model in the chain.
- Include a `chain` field listing the ordered model names for informational purposes.

The `/models/:model` and `/v1/models/:model` detail endpoints SHALL return chain detail for `chain-<name>` identifiers.

**Rationale**: Clients that enumerate available models need to see chains as selectable options. Including chain metadata (model list) helps operators verify their configuration.

**Alternative considered**: Don't show chains in model discovery, require out-of-band knowledge. Rejected because it breaks the self-describing property of the API.

### 7. Error semantics: chain-level error wraps the last model's error

**Decision**: When all models in a chain fail:
- Return HTTP 502 with a structured error body that includes: the chain name, the number of models tried, and the error from the **last** model attempted.
- Include an `attempts` array in the error detail showing each model name and its error status (for debugging).
- For non-retryable errors that stop early, return the originating model's error status code directly (e.g., 401 stays 401).

**Rationale**: Returning 502 for total chain failure signals "gateway-level problem" to the client while preserving debugging information. Preserving the original status code for non-retryable errors avoids masking the real problem.

**Alternative considered**: Always return 502 regardless of error type. Rejected because it hides the real error (e.g., auth failures should surface as 401, not 502).

### 8. Name conflict detection at startup

**Decision**: The following conflicts SHALL be detected at config validation time and prevent startup:
- A chain `name` that matches an existing model `name` in the `models` catalog.
- A chain `name` where `chain-<name>` matches an existing model `name` (i.e., a plain model already named `chain-something`).
- Duplicate chain `name` values within the `model_chains` list.

**Rationale**: Name conflicts create ambiguous resolution. Detecting them at startup fails fast rather than producing unpredictable runtime behavior.

### 9. Chain executor as a separate module

**Decision**: Extract chain execution logic into a new `src/chain-executor.ts` module rather than inlining it into `responses.ts`. The module exports a `executeChain()` function that:
- Takes a chain descriptor, the original request, and a transport factory.
- Handles the sequential fallback loop internally.
- Returns the successful response or throws a `ChainExhaustedError`.
- Emits structured log entries for each attempt (model name, attempt number, outcome).

**Rationale**: `responses.ts` is already ~2080 lines. Adding chain execution logic inline would make it harder to maintain and test. A separate module keeps the fallback algorithm testable in isolation and keeps the route handlers focused on request/response translation.

### 10. Copilot-proxy models excluded from chains

**Decision**: Model names starting with `copilot-` (or any prefix in `copilot_proxy_allowed_prefixes`) SHALL NOT be valid entries in a chain's `models` list. This is enforced at config validation time.

**Rationale**: Copilot-proxied models are dispatched through a fundamentally different path (WebSocket → VS Code extension → Copilot API). Mixing them with direct-upstream models in a chain would require the executor to handle two entirely different dispatch mechanisms, significantly complicating the implementation. If this is needed in the future, it should be a separate design.

## Risks / Trade-offs

- **Latency amplification**: A chain that exhausts all models incurs the sum of all timeouts and retries. Operators must set per-model timeouts carefully to avoid excessive tail latency. The chain-level `timeout_ms` cap mitigates this by bounding the total chain execution time.
- **Partial streaming failure is visible to clients**: If a stream breaks mid-way, clients receive a partial response + error event. Some clients may not handle this gracefully. Documenting this behavior clearly is essential.
- **Rate-limit amplification**: On a retryable error, the gateway retries the same model (per existing retry logic) AND then falls back to the next model. This means a single client request could generate up to `(1 + max_retries) × num_models_in_chain` upstream requests in the worst case. Operators should set `max_retries` conservatively in chains.
- **Config complexity**: Chains add a new config section with nested overrides. The validation rules (no nesting, no copilot models, name conflicts) reduce footguns but don't eliminate the cognitive load. Good documentation and example configs are necessary.
- **`chain-` prefix collision**: If a future feature also wants to use the `chain-` prefix, there would be a conflict. The validation rule preventing plain models named `chain-*` reserves the namespace, but it also means existing configs with such model names would break. This is acceptable because `chain-` is not a convention used by any known upstream provider.

## Migration Plan

1. Add `model_chains` to the YAML schema with no default chains. Existing configs without this section are equivalent.
2. Deploy the gateway change. No behavior change for existing deployments.
3. Operators opt in by adding a `model_chains` section to their YAML and restarting.
4. Clients reference chains using `chain-<name>` as the `model` field value. No client SDK changes required.

**Rollback**: Remove the `model_chains` section from the YAML and restart. Any clients still referencing `chain-<name>` will receive a 400 error (model not configured), consistent with today's behavior for unknown models.

## Open Questions

1. Should the chain-level `timeout_ms` be a total budget (wall-clock cap for the entire chain execution) or a per-model default that applies to each model individually? **Resolved: both.** A chain-level `timeout_ms` acts as a per-model default (overridable per model-in-chain), and a separate `chain_timeout_ms` acts as a total wall-clock budget for the entire chain execution. If `chain_timeout_ms` is exceeded, the chain stops regardless of individual model progress.
2. Should chain execution be configurable to skip models that have recently failed (circuit-breaker pattern)? **Deferred.** The first implementation is purely sequential. A circuit-breaker layer can be added later without changing the config schema.
3. Should the `x-chain-model` response header also be added to non-chain responses (e.g., `x-chain-model: <direct-model-name>`) for uniformity? **No.** Only chain responses get the header; direct model responses are unchanged.
