# model-chain-config Specification

## Purpose
TBD - created by archiving change add-model-chain. Update Purpose after archive.
## Requirements
### Requirement: Gateway SHALL accept an optional `model_chains` configuration section
The gateway SHALL accept an optional `model_chains` key in the YAML configuration. When present, `model_chains` SHALL be an array of chain entries. When absent, the gateway SHALL operate with no chains configured, preserving existing behavior.

#### Scenario: Config with no model_chains section
- **WHEN** the YAML configuration does not include a `model_chains` key
- **THEN** the gateway SHALL start normally with zero chains configured and `resolveModel()` SHALL behave exactly as before

#### Scenario: Config with empty model_chains array
- **WHEN** the YAML configuration includes `model_chains: []`
- **THEN** the gateway SHALL start normally with zero chains configured

#### Scenario: Config with valid model_chains
- **WHEN** the YAML configuration includes a `model_chains` array with one or more valid chain entries
- **THEN** the gateway SHALL parse and validate each chain entry and make them available for resolution

### Requirement: Each chain entry SHALL define a name and an ordered models list
Each entry in the `model_chains` array SHALL contain a `name` field (non-empty string) and a `models` field (non-empty array of model references). The order of the `models` array SHALL define the fallback priority: the first model is tried first, the second is tried if the first fails, and so on.

#### Scenario: Valid chain with two models
- **WHEN** the configuration includes `model_chains: [{name: production, models: [gpt-5, glm-5.1]}]` and both `gpt-5` and `glm-5.1` exist in the `models` catalog
- **THEN** the gateway SHALL accept the configuration and the chain `production` SHALL resolve with `gpt-5` as first priority and `glm-5.1` as second

#### Scenario: Chain with empty models list rejected
- **WHEN** the configuration includes `model_chains: [{name: empty, models: []}]`
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that a chain's models list must not be empty

#### Scenario: Chain with empty name rejected
- **WHEN** the configuration includes `model_chains: [{name: "", models: [gpt-5]}]`
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that a chain name must be a non-empty string

### Requirement: Each model reference in a chain SHALL be a string matching a model name from the models catalog
Each element in a chain's `models` list SHALL be either a string (matching a `name` from the `models` catalog) or an object with a `name` field (matching a `name` from the `models` catalog) plus optional `timeout_ms` and `max_retries` override fields.

#### Scenario: Simple string model reference
- **WHEN** a chain's `models` list includes the string `"gpt-5"` and `gpt-5` exists in the `models` catalog
- **THEN** the gateway SHALL resolve that chain entry to the `gpt-5` model config with default timeout and retry settings

#### Scenario: Object model reference with overrides
- **WHEN** a chain's `models` list includes `{name: gpt-5, timeout_ms: 60000, max_retries: 2}` and `gpt-5` exists in the `models` catalog
- **THEN** the gateway SHALL resolve that chain entry to the `gpt-5` model config with timeout 60000ms and max_retries 2, overriding both chain-level and gateway-level defaults

#### Scenario: Reference to non-existent model rejected
- **WHEN** a chain's `models` list includes `"nonexistent-model"` and no model with that name exists in the `models` catalog
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that the model name is not present in the configured model catalog

### Requirement: Chain names SHALL NOT conflict with model names or the chain- prefix
The gateway SHALL enforce the following name uniqueness constraints at startup:
1. No chain `name` SHALL match any model `name` in the `models` catalog.
2. No chain `name` SHALL produce a `chain-<name>` string that matches any model `name` in the `models` catalog.
3. No duplicate chain `name` values within the `model_chains` list.

#### Scenario: Chain name matches a model name
- **WHEN** the configuration includes a chain with `name: gpt-5` and a model with `name: gpt-5` in the models catalog
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that the chain name conflicts with a configured model name

#### Scenario: chain-<name> matches a model name
- **WHEN** the configuration includes a chain with `name: fallback` and a model with `name: chain-fallback` in the models catalog
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that the chain identifier `chain-fallback` conflicts with a configured model name

#### Scenario: Duplicate chain names
- **WHEN** the configuration includes two chains both with `name: production`
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that chain names must be unique

### Requirement: Chain model references SHALL NOT include copilot-proxy models
Model names that start with any prefix in `copilot_proxy_allowed_prefixes` (default: `copilot-`) SHALL NOT be valid entries in a chain's `models` list.

#### Scenario: Copilot model in chain rejected
- **WHEN** the configuration includes `copilot_proxy_allowed_prefixes: ["copilot-"]` and a chain references model `copilot-gpt-4o`
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that Copilot-proxied models cannot be used in chains

### Requirement: Chain model references SHALL NOT reference other chains
A chain's `models` list SHALL NOT contain any string starting with `chain-`. This prevents chain nesting.

#### Scenario: Nested chain reference rejected
- **WHEN** a chain's `models` list includes `"chain-production"`
- **THEN** the gateway SHALL reject the configuration at startup with a validation error indicating that chain nesting is not supported

### Requirement: Each chain entry MAY specify timeout_ms and max_retries defaults
The gateway SHALL allow a chain entry to include `timeout_ms` (positive integer, default inherits from `request_timeout_ms`) and `max_retries` (non-negative integer, default inherits from `max_retries`). These values apply to every model in the chain unless overridden by a per-model entry.

#### Scenario: Chain-level timeout overrides gateway default
- **WHEN** the gateway-level `request_timeout_ms` is 30000 and a chain specifies `timeout_ms: 60000`
- **THEN** each model in that chain SHALL use 60000ms timeout unless a per-model override specifies otherwise

#### Scenario: Chain-level retry overrides gateway default
- **WHEN** the gateway-level `max_retries` is 0 and a chain specifies `max_retries: 1`
- **THEN** each model in that chain SHALL retry once on retryable errors unless a per-model override specifies otherwise

#### Scenario: Chain without overrides inherits gateway defaults
- **WHEN** a chain entry does not specify `timeout_ms` or `max_retries`
- **THEN** each model in that chain SHALL use the gateway-level `request_timeout_ms` and `max_retries` values

### Requirement: Each chain entry MAY specify a chain_timeout_ms total budget
A chain entry MAY include `chain_timeout_ms` (positive integer). When set, the total wall-clock time for the entire chain execution (including all model attempts, retries, and backoff delays) SHALL NOT exceed this value. If the budget is exceeded, the chain SHALL stop and return a 504 error to the client.

#### Scenario: Chain budget exceeded
- **WHEN** a chain specifies `chain_timeout_ms: 45000`, the first model times out after 30000ms, and the second model has not responded by 45000ms total elapsed time
- **THEN** the gateway SHALL stop the chain execution and return HTTP 504 with an error indicating the chain timeout budget was exceeded

#### Scenario: Chain budget not set
- **WHEN** a chain entry does not specify `chain_timeout_ms`
- **THEN** the gateway SHALL NOT impose a total budget on the chain execution; each model is bounded only by its individual timeout

#### Scenario: Chain budget sufficient for all models
- **WHEN** a chain specifies `chain_timeout_ms: 90000` and the first model succeeds after 10000ms
- **THEN** the gateway SHALL return the successful response immediately without waiting for the budget to expire

