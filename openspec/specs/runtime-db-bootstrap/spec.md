# runtime-db-bootstrap Specification

## Purpose
Define startup bootstrap behavior that guarantees a database-authoritative `gateway_config` singleton and ensures runtime configuration is sourced from database state plus environment variables, never from YAML configuration files.

## Requirements

### Requirement: Startup SHALL guarantee a gateway_config singleton
On every startup, after migrations are applied, the gateway SHALL ensure `gateway_config` contains a singleton row with `id = 1`. If the row does not exist, the gateway SHALL insert one using schema defaults.

#### Scenario: Missing gateway_config row is auto-created
- **WHEN** the gateway starts against a database with no `gateway_config` row
- **THEN** the gateway SHALL insert `gateway_config(id=1)` with default values

#### Scenario: Existing gateway_config row is preserved
- **WHEN** the gateway starts against a database where `gateway_config(id=1)` already exists
- **THEN** the gateway SHALL keep the existing row and SHALL NOT reset its values to defaults

### Requirement: Runtime bootstrap SHALL be DB-authoritative
The gateway runtime configuration SHALL be loaded from database state and environment variables only. YAML configuration files SHALL NOT participate in runtime bootstrap decisions.

#### Scenario: Startup without YAML succeeds
- **WHEN** `GATEWAY_CONFIG_PATH` is unset and database bootstrap prerequisites are met
- **THEN** the gateway SHALL start successfully using DB-derived runtime configuration

#### Scenario: Startup with YAML path still uses DB runtime state
- **WHEN** `GATEWAY_CONFIG_PATH` is set and the gateway starts
- **THEN** runtime configuration SHALL still be sourced from database state and environment variables only
