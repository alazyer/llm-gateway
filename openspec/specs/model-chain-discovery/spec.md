# model-chain-discovery Specification

## Purpose
TBD - created by archiving change add-model-chain. Update Purpose after archive.
## Requirements
### Requirement: Model discovery endpoints SHALL include chain entries
When `model_chains` is configured, the `GET /models` and `GET /v1/models` endpoints SHALL include a virtual model entry for each configured chain. Each chain entry SHALL have:
- `id`: `"chain-<name>"`
- `object`: `"model"`
- `created`: the gateway startup timestamp
- `owned_by`: `"llm-gateway-chain"`
- `capabilities.supports_chain`: `true`
- `capabilities.supports_streaming`: derived from the first model in the chain
- `capabilities.supports_tool_calls`: derived from the first model in the chain
- `chain`: an array of the ordered model names (informational)

#### Scenario: Chain appears in model list
- **WHEN** the gateway has a chain configured with `name: production` and models `[gpt-5, glm-5.1]`
- **THEN** `GET /v1/models` SHALL include an entry with `id: "chain-production"`, `owned_by: "llm-gateway-chain"`, `capabilities.supports_chain: true`, and `chain: ["gpt-5", "glm-5.1"]`

#### Scenario: Chain capabilities match first model
- **WHEN** the first model in a chain has `supports_streaming: true` and `supports_tools: false`
- **THEN** the chain's virtual model entry SHALL have `capabilities.supports_streaming: true` and `capabilities.supports_tool_calls: false`

#### Scenario: No chains configured — no chain entries in model list
- **WHEN** the gateway has no `model_chains` configured
- **THEN** `GET /v1/models` SHALL NOT include any entries with `owned_by: "llm-gateway-chain"` or `id` starting with `chain-`

### Requirement: Model detail endpoint SHALL return chain detail
The `GET /models/:model` and `GET /v1/models/:model` endpoints SHALL accept `chain-<name>` as the model parameter and return the chain's virtual model entry.

#### Scenario: Chain detail returned
- **WHEN** a client calls `GET /v1/models/chain-production` and a chain with `name: production` is configured
- **THEN** the gateway SHALL return the virtual model entry for `chain-production` with full capabilities and chain metadata

#### Scenario: Unknown chain returns 404
- **WHEN** a client calls `GET /v1/models/chain-nonexistent` and no chain with that name is configured
- **THEN** the gateway SHALL return HTTP 404, consistent with the existing behavior for unknown model names

### Requirement: Anthropic model list SHALL include chain entries in Anthropic format
When the `anthropic-version` header is present on `GET /v1/models`, chain entries SHALL be formatted as `AnthropicModelRecord` objects with `id: "chain-<name>"` and `type: "model"`.

#### Scenario: Chain in Anthropic model list
- **WHEN** a client calls `GET /v1/models` with `anthropic-version: 2023-06-01` and a chain `production` is configured
- **THEN** the response SHALL include an Anthropic-format entry with `id: "chain-production"`, `type: "model"`, and `display_name` derived from the chain name

### Requirement: Chain entries SHALL NOT be confused with Copilot proxy models
Chain entries in model discovery SHALL use `owned_by: "llm-gateway-chain"` and SHALL NOT be routed through the Copilot proxy path, even if the chain name coincidentally starts with a Copilot-allowed prefix.

#### Scenario: Chain named copilot-fallback not routed as Copilot model
- **WHEN** a chain is configured with `name: copilot-fallback` (so its ID is `chain-copilot-fallback`) and `copilot_proxy_allowed_prefixes` includes `copilot-`
- **THEN** the chain entry SHALL appear in model discovery with `owned_by: "llm-gateway-chain"`, and requests to `chain-copilot-fallback` SHALL be executed via the chain executor (direct upstream), NOT dispatched through the Copilot proxy WebSocket

Note: This scenario is already prevented by the config validation rule that rejects a chain name if `chain-<name>` matches any model name. Since `copilot-fallback` would only be ambiguous if a plain model named `chain-copilot-fallback` existed, and Copilot proxy models are dynamically registered (not in the YAML catalog), the naming validation already ensures no collision with YAML-defined models. The runtime routing logic MUST still check chain resolution BEFORE Copilot proxy model lookup to avoid misrouting.

