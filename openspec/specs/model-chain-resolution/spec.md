# model-chain-resolution Specification

## Purpose
TBD - created by archiving change add-model-chain. Update Purpose after archive.
## Requirements
### Requirement: resolveModel SHALL recognise chain-<name> identifiers
When `resolveModel()` receives a model string that starts with `chain-`, it SHALL extract the suffix after `chain-` and look it up in the configured `model_chains` catalog. If found, it SHALL return a chain descriptor (not a single `GatewayModelConfig`). If not found, it SHALL throw a 404 RouteError.

#### Scenario: Valid chain identifier resolved
- **WHEN** a request specifies `model: "chain-production"` and a chain with `name: "production"` is configured
- **THEN** `resolveModel()` SHALL return a chain descriptor containing the ordered list of model configs

#### Scenario: Unknown chain identifier returns 404
- **WHEN** a request specifies `model: "chain-nonexistent"` and no chain with `name: "nonexistent"` is configured
- **THEN** `resolveModel()` SHALL throw a RouteError with status 404 and message indicating that the chain is not configured

#### Scenario: Plain model name resolves as before
- **WHEN** a request specifies `model: "gpt-5"` and a model with `name: "gpt-5"` is configured (even if chains are also configured)
- **THEN** `resolveModel()` SHALL return the single `GatewayModelConfig` exactly as it does today, with no chain behavior

### Requirement: Chain resolution SHALL take precedence over default_model when model field is absent
When the request does not include a `model` field and a `default_model` is configured that starts with `chain-`, the gateway SHALL resolve it as a chain. If no resolvable target exists, the route SHALL return 404.

#### Scenario: default_model is a chain identifier
- **WHEN** `default_model: "chain-production"` is configured and a request omits the `model` field
- **THEN** the gateway SHALL resolve the default model as a chain descriptor and execute chain fallback

#### Scenario: default_model is a plain model name
- **WHEN** `default_model: "gpt-5"` is configured and a request omits the `model` field
- **THEN** the gateway SHALL resolve the default model as a single `GatewayModuleConfig` with no chain behavior, same as today

#### Scenario: omitted model with unresolved default returns 404
- **WHEN** a request omits `model` and `default_model` is unset or points to a missing model/chain
- **THEN** the route SHALL return HTTP 404

### Requirement: Route handlers SHALL classify missing and misconfigured targets distinctly
Inference route handlers (`/responses`, `/v1/chat/completions`, `/v1/messages`) SHALL return HTTP 404 when a requested model or chain does not exist, and SHALL return HTTP 500 when a requested existing target cannot execute due to runtime misconfiguration (for example missing environment value for `api_key_env`).

#### Scenario: Missing model returns 404
- **WHEN** a request targets a model name that is not present in the effective catalog
- **THEN** the handler SHALL return HTTP 404

#### Scenario: Existing model missing runtime secret returns 500
- **WHEN** a request targets an existing model whose `api_key_env` variable has no runtime value
- **THEN** the handler SHALL return HTTP 500

### Requirement: Chain execution SHALL fail whole request when chain is broken
When a request is served via chain execution, any broken chain metadata or runtime misconfiguration that prevents valid execution SHALL fail the full request rather than partially succeeding through implicit fallback around broken entries.

#### Scenario: Chain references missing model
- **WHEN** a resolved chain references a model absent from the effective catalog
- **THEN** the route SHALL fail the request instead of skipping that entry silently

#### Scenario: Chain entry with missing runtime secret
- **WHEN** a chain entry resolves to a model with missing runtime `api_key_env` value
- **THEN** the route SHALL fail the request with HTTP 500

