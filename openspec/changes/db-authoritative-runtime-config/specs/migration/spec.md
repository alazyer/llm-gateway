## MODIFIED Requirements

### REQ-MIGRATE-001: Backward-compatible startup
Existing deployments using `gateway.config.yaml` SHALL continue to start without requiring operators to remove legacy environment variables. The gateway SHALL always open/create the database, apply pending migrations, ensure `gateway_config(id=1)` exists, and continue startup even when `models` and `model_chains` are empty.

**Rationale**: Startup behavior must be DB-authoritative and permissive so provisioning can happen after process boot.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-002: YAML as seed source only
`gateway.config.yaml` SHALL NOT be used for runtime seeding behavior in startup. Startup behavior SHALL be independent of YAML presence and SHALL rely on database state plus environment variables.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-004: Seed preserves all YAML configuration
Runtime startup SHALL NOT persist YAML-derived configuration into database state. Configuration persistence is handled by database writes through administrative/runtime management paths.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-005: Seed validates before persisting
Startup SHALL NOT block on YAML validation because YAML is not part of the runtime bootstrap path.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-006: Idempotent seeding
If the database exists but is missing `gateway_config(id=1)`, startup SHALL create the singleton with defaults and proceed. Startup SHALL NOT require model or chain rows to exist.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-012: GATEWAY_CONFIG_PATH remains for compatibility
The `GATEWAY_CONFIG_PATH` environment variable SHALL remain accepted for compatibility, but it SHALL be ignored by runtime startup behavior.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

