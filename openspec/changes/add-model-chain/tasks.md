## 1. Configuration Schema and Validation

- [ ] 1.1 Add `yamlModelChainEntrySchema` Zod schema in `src/config.ts` for a single chain entry: `name` (non-empty string), `models` (non-empty array of `z.string()` or `z.object({name, timeout_ms?, max_retries?})`), optional `timeout_ms`, optional `max_retries`, optional `chain_timeout_ms`
- [ ] 1.2 Add `yamlModelChainSchema` Zod schema: `z.array(yamlModelChainEntrySchema)` under key `model_chains`, optional
- [ ] 1.3 Add `model_chains` field to `yamlGatewaySchema` in `src/config.ts`
- [ ] 1.4 Define `ModelChainConfig` and `ModelChainModelEntry` TypeScript interfaces in `src/config.ts`
- [ ] 1.5 Add `modelChains: ModelChainConfig[]` field to `AppConfig` interface in `src/config.ts`
- [ ] 1.6 Implement cross-field validation in `loadYamlConfig()`: chain names must not match any model name, `chain-<name>` must not match any model name, no duplicate chain names, no `chain-` prefixed references in models list, no Copilot-prefixed models in chains list, all model references must exist in the models catalog
- [ ] 1.7 Wire parsed `model_chains` into `AppConfig` returned by `loadConfig()`, resolving model references to full `GatewayModelConfig` objects with effective timeout/retry settings
- [ ] 1.8 Update `gateway.config.example.yaml` with documented `model_chains` section and example entries

## 2. Chain Executor Module

- [ ] 2.1 Create `src/chain-executor.ts` with `ChainDescriptor`, `ChainAttemptResult`, `ChainExhaustedError`, `ChainBudgetExceededError` types
- [ ] 2.2 Implement `executeChain()` for non-streaming requests: sequential loop over models, retryable vs. non-retryable error classification, elapsed time tracking for budget enforcement, structured logging per attempt
- [ ] 2.3 Implement `executeChainStream()` for streaming requests: same sequential loop, but commit to first model that produces an SSE chunk; generate SSE error event on mid-stream failure (no fallback); include `x-chain-model` header
- [ ] 2.4 Implement budget tracking: `chain_timeout_ms` wall-clock cap checked before each model attempt and after each attempt completes
- [ ] 2.5 Export a `isRetryableForChain()` helper that classifies `UpstreamHttpError` and network errors as retryable (429, 502, 503, 504/timeout, network) vs. non-retryable (all others)

## 3. Model Resolution Extension

- [ ] 3.1 Extend `resolveModel()` in `src/routes/responses.ts` to return either `GatewayModelConfig` or `ChainDescriptor` (union type)
- [ ] 3.2 Add chain lookup: if the model string starts with `chain-`, extract the suffix, find the chain by name in `config.modelChains`, return `ChainDescriptor`; if not found, throw 400 RouteError
- [ ] 3.3 Preserve existing single-model resolution path unchanged for non-chain identifiers
- [ ] 3.4 Ensure chain resolution is checked BEFORE Copilot proxy model lookup to prevent `chain-copilot-*` from being misrouted

## 4. Route Handler Integration

- [ ] 4.1 Update `responsesHandler` (`POST /responses`, `POST /v1/responses`): after `resolveModel()`, branch on chain vs. single-model; delegate to chain executor for chains; pass through to existing logic for single models
- [ ] 4.2 Update `chatCompletionsHandler` (`POST /v1/chat/completions`): same branching logic
- [ ] 4.3 Update `anthropicMessagesHandler` (`POST /v1/messages`): same branching logic
- [ ] 4.4 Add `x-chain-model` response header for chain-served responses (non-streaming and streaming)
- [ ] 4.5 Map `ChainExhaustedError` to HTTP 502 with structured error body in all three error senders (`sendError`, `sendOpenAiError`, `sendAnthropicError`)
- [ ] 4.6 Map `ChainBudgetExceededError` to HTTP 504 in all three error senders
- [ ] 4.7 Thread `modelChains` from `AppConfig` through `ResponsesRoutesOptions` to route handlers

## 5. Model Discovery Integration

- [ ] 5.1 Update `createModelsList()` in `src/routes/responses.ts` to append chain virtual model entries after the configured models and Copilot proxy models
- [ ] 5.2 Implement `createChainModelRecord()` that converts a `ModelChainConfig` to a `ModelRecord` with `id: "chain-<name>"`, `owned_by: "llm-gateway-chain"`, `capabilities.supports_chain: true`, and `chain` metadata array
- [ ] 5.3 Update `createAnthropicModelsList()` to include chain entries in Anthropic format
- [ ] 5.4 Update `modelDetailHandler` to resolve `chain-<name>` identifiers and return chain virtual model detail; return 404 for unknown chains
- [ ] 5.5 Derive chain capabilities (`supports_streaming`, `supports_tool_calls`, `supports_responses_api`) from the first model in the chain

## 6. Upstream Client Integration

- [ ] 6.1 Add support for per-request `timeoutMs` and `maxRetries` overrides in `ChatCompletionsClient` constructor or method parameters, so the chain executor can pass model-specific settings without creating new client instances
- [ ] 6.2 Verify that `getClient()` cache key remains `baseUrl::apiKey` — timeout and retry overrides are per-call, not per-client-instance (or adjust cache strategy if per-instance settings are needed)

## 7. Tests

- [ ] 7.1 Add unit tests for chain config validation: valid chains, missing model references, name conflicts, duplicate names, copilot model references, nested chain references, empty models list
- [ ] 7.2 Add unit tests for `executeChain()`: first model succeeds, first fails/second succeeds, all fail (ChainExhaustedError), non-retryable error stops chain, budget exceeded
- [ ] 7.3 Add unit tests for `executeChainStream()`: first model streams, first fails/second streams, mid-stream break produces SSE error event
- [ ] 7.4 Add unit tests for `resolveModel()` extension: chain-<name> resolution, unknown chain returns 400, plain model unchanged, chain as default_model
- [ ] 7.5 Add integration tests: `/v1/chat/completions` with chain model, `/responses` with chain model, `/v1/messages` with chain model, x-chain-model header present, chain-exhausted 502, budget-exceeded 504
- [ ] 7.6 Add integration tests for model discovery: chain in `/v1/models`, chain detail in `/v1/models/chain-<name>`, chain in Anthropic format, no chain entries when no chains configured
- [ ] 7.7 Update existing `config.test.ts` to cover `model_chains` parsing and validation
