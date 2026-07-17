## ADDED Requirements

### Requirement: resolveModel SHALL recognise chain-<name> identifiers
When `resolveModel()` receives a model string that starts with `chain-`, it SHALL extract the suffix after `chain-` and look it up in the configured `model_chains` catalog. If found, it SHALL return a chain descriptor (not a single `GatewayModelConfig`). If not found, it SHALL throw a 400 RouteError.

#### Scenario: Valid chain identifier resolved
- **WHEN** a request specifies `model: "chain-production"` and a chain with `name: "production"` is configured
- **THEN** `resolveModel()` SHALL return a chain descriptor containing the ordered list of model configs

#### Scenario: Unknown chain identifier returns 400
- **WHEN** a request specifies `model: "chain-nonexistent"` and no chain with `name: "nonexistent"` is configured
- **THEN** `resolveModel()` SHALL throw a RouteError with status 400 and message indicating that the chain is not configured

#### Scenario: Plain model name resolves as before
- **WHEN** a request specifies `model: "gpt-5"` and a model with `name: "gpt-5"` is configured (even if chains are also configured)
- **THEN** `resolveModel()` SHALL return the single `GatewayModelConfig` exactly as it does today, with no chain behavior

### Requirement: Chain resolution SHALL take precedence over default_model when model field is absent
When the request does not include a `model` field and a `default_model` is configured that starts with `chain-`, the gateway SHALL resolve it as a chain.

#### Scenario: default_model is a chain identifier
- **WHEN** `default_model: "chain-production"` is configured and a request omits the `model` field
- **THEN** the gateway SHALL resolve the default model as a chain descriptor and execute chain fallback

#### Scenario: default_model is a plain model name
- **WHEN** `default_model: "gpt-5"` is configured and a request omits the `model` field
- **THEN** the gateway SHALL resolve the default model as a single `GatewayModuleConfig` with no chain behavior, same as today

### Requirement: Route handlers SHALL branch on chain vs. single-model resolution
Each route handler (`/responses`, `/v1/chat/completions`, `/v1/messages`) SHALL check the result of `resolveModel()`. If the result is a chain descriptor, the handler SHALL delegate to the chain executor. If the result is a single `GatewayModelConfig`, the handler SHALL proceed with the existing single-model path.

#### Scenario: Chain request dispatched to chain executor
- **WHEN** `resolveModel()` returns a chain descriptor for a request to `POST /v1/chat/completions`
- **THEN** the handler SHALL call `executeChain()` with the chain descriptor, the upstream request, and a transport factory

#### Scenario: Single-model request uses existing path
- **WHEN** `resolveModel()` returns a `GatewayModelConfig` for a request to `POST /v1/chat/completions`
- **THEN** the handler SHALL proceed with the existing single-model dispatch logic, unchanged

### Requirement: Chain execution SHALL set x-chain-model response header
When a request is served via chain execution, the response SHALL include an `x-chain-model` header whose value is the `name` of the model that ultimately produced the successful response.

#### Scenario: Successful chain response includes header
- **WHEN** a chain with models `[gpt-5, glm-5.1]` succeeds on the first model `gpt-5`
- **THEN** the response SHALL include `x-chain-model: gpt-5`

#### Scenario: Fallback response includes header for fallback model
- **WHEN** a chain with models `[gpt-5, glm-5.1]` fails on `gpt-5` and succeeds on `glm-5.1`
- **THEN** the response SHALL include `x-chain-model: glm-5.1`

#### Scenario: Single-model response does NOT include header
- **WHEN** a request resolves to a plain model `gpt-5` (not a chain)
- **THEN** the response SHALL NOT include `x-chain-model` header
