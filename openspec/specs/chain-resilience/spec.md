# Spec: Chain Resilience to Model Unavailability

## Purpose
Define how model-chain status is derived, persisted, exposed, and used when one or more chain models become unavailable.

## Requirements

### REQ-CHAIN-001: Chain status values
Each model chain SHALL have a `status` field with one of the following values:
- `active`: All models in the chain are active.
- `degraded`: Some models in the chain are inactive; the chain remains usable but with reduced fallback options.
- `inactive`: All models in the chain are inactive; the chain cannot serve requests.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-002: Chain status is derived from constituent models
The chain status SHALL be computed from the status of its constituent models:
- If ALL models are `active`, chain status is `active`.
- If SOME models are `active` and SOME are `inactive`, chain status is `degraded`.
- If ALL models are `inactive`, chain status is `inactive`.

The chain status SHALL be recalculated whenever a model in the chain transitions status.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-003: Chain execution skips inactive models
When executing a chain, the gateway SHALL filter out models with `status='inactive'` before attempting fallback. The chain executor SHALL iterate only over active models.

**Rationale**: Inactive models should not be attempted — they would fail immediately with a 503, wasting time and potentially masking the real issue.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-004: Chain with no active models returns 503
If a chain has `status='inactive'` (all models inactive), and a client requests that chain, the gateway SHALL return 503 with message `"Chain '<name>' is inactive: all models are unavailable"`.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-005: Degraded chain continues with active models
If a chain has `status='degraded'` (some models active, some inactive), the gateway SHALL route requests to the chain. Only active models are attempted during fallback. The response headers SHALL include `x-chain-status: degraded` to inform the caller.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-006: Chain model status in /models listing
When listing chains via `/models` or `/v1/models`, each chain entry SHALL include:
- `status`: The derived chain status
- `active_models`: Count of active models in the chain
- `total_models`: Total count of models in the chain
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-007: Chain status recalculation on model status change
When a model's status transitions (active → inactive or inactive → active), the gateway SHALL identify all chains that reference that model and recalculate their status. The updated chain status SHALL be persisted to the database.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-008: Chain validation at startup
At startup, after loading models and chains from the database, the gateway SHALL validate that:
- Every model referenced in a chain exists in the models table (regardless of status).
- No chain references a model that does not exist in the database.

If a referenced model does not exist, the gateway SHALL log an error and fail to start (same behavior as current YAML validation).
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-009: Chain creation with inactive models is allowed
When creating a chain (via admin API or YAML seed), the gateway SHALL permit references to models that are currently `inactive`. The chain will have `status='degraded'` or `status='inactive'` depending on how many of its models are active.

**Rationale**: Operators may want to define chains that include models expected to come online later (e.g., Copilot proxy models that will register when the extension connects).
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-CHAIN-010: Chain status reason
The chain's `status_reason` field SHALL be populated with a human-readable explanation:
- For `active`: `"All models active"`
- For `degraded`: `"X of Y models inactive: <list of inactive model names>"`
- For `inactive`: `"All models inactive"`
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

## Scenarios

### Scenario: Model in chain goes inactive
**Given** chain `primary-fallback` references models `glm-5.1` and `deepseek-v4-flash`, both active
**And** chain status is `active`
**When** `deepseek-v4-flash` is deactivated
**Then** chain `primary-fallback` status is recalculated to `degraded`
**And** `status_reason` is `"1 of 2 models inactive: deepseek-v4-flash"`
**And** the chain remains usable for requests

### Scenario: All models in chain go inactive
**Given** chain `primary-fallback` references models `glm-5.1` and `deepseek-v4-flash`
**And** both models are `inactive`
**When** a client requests `chain-primary-fallback`
**Then** the gateway returns 503 with `{"error": "Chain 'primary-fallback' is inactive: all models are unavailable"}`

### Scenario: Chain execution with degraded chain
**Given** chain `primary-fallback` has models `[glm-5.1 (active), deepseek-v4-flash (inactive), copilot-gpt-4 (active)]`
**And** chain status is `degraded`
**When** a client requests `chain-primary-fallback`
**And** `glm-5.1` returns a retryable error
**Then** the chain executor skips `deepseek-v4-flash` (inactive)
**And** attempts `copilot-gpt-4` next
**And** the response includes header `x-chain-status: degraded`

### Scenario: Model reactivates, chain becomes active
**Given** chain `primary-fallback` has status `degraded` with 1 inactive model
**When** the inactive model is reactivated
**Then** chain status is recalculated to `active`
**And** `status_reason` is `"All models active"`

### Scenario: Copilot proxy model in chain disconnects and reconnects
**Given** chain `hybrid` references static model `glm-5.1` and Copilot model `copilot-gpt-4`
**And** both models are active, chain status is `active`
**When** the Copilot proxy disconnects
**Then** `copilot-gpt-4` is marked inactive
**And** chain `hybrid` status is recalculated to `degraded`
**When** the Copilot proxy reconnects and re-registers `copilot-gpt-4`
**Then** `copilot-gpt-4` is reactivated
**And** chain `hybrid` status is recalculated to `active`
