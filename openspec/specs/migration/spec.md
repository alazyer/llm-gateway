# Spec: Migration Path from YAML to Database

## Purpose
Define the backward-compatible migration path from YAML bootstrap configuration to SQLite-backed persistent gateway state.

## Requirements

### REQ-MIGRATE-001: Backward-compatible startup
Existing deployments using `gateway.config.yaml` SHALL continue to work without modification. The gateway SHALL detect whether a database exists and behave accordingly:
- **No database exists**: Create database, apply migrations, seed from YAML.
- **Database exists**: Open database, apply pending migrations, ignore YAML.

**Rationale**: Zero-downtime migration. Operators do not need to manually convert YAML to database format.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-002: YAML as seed source only
The `gateway.config.yaml` file SHALL only be read on first startup (when no database exists). After seeding, the YAML file is not read again. Operators MAY delete or retain the YAML file; it has no effect after first startup.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-003: Environment variable for database path
The `GATEWAY_DB_PATH` environment variable SHALL specify the database file location. If not set, default to `./data/gateway.db`. The gateway SHALL create parent directories if they do not exist.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-004: Seed preserves all YAML configuration
When seeding from YAML, the gateway SHALL persist:
- All models from the `models` array with `source='static'`
- All chains from the `model_chains` array
- All gateway-level settings (default_model, timeouts, copilot_proxy config, etc.)
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-005: Seed validates before persisting
Before seeding, the gateway SHALL run the existing YAML validation logic (schema validation, cross-field validation for chains). If validation fails, the gateway SHALL fail to start with an error message. No partial database state shall be created.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-006: Idempotent seeding
If the database exists but is empty (no rows in `models`, `model_chains`, `gateway_config`), the gateway SHALL seed from YAML. This supports the case where the database file was manually created but not populated.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-007: Migration version tracking
Schema migrations SHALL be tracked in a `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

Each migration SHALL insert a row upon successful completion.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-008: Sequential migration application
Migrations SHALL be numbered sequentially (1, 2, 3, ...). On startup, the gateway SHALL query `SELECT MAX(version) FROM schema_migrations` and apply all migrations with version > that value, in order.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-009: Migration failure halts startup
If any migration fails (SQL error), the gateway SHALL log the error and exit with code 1. The database SHALL be left in its pre-migration state (SQLite transactions ensure atomicity per migration).
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-010: Initial schema as migration 1
The initial schema (all tables from REQ-PERSIST-006 through REQ-PERSIST-009) SHALL be migration version 1. This migration creates all base tables.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-011: No data migration from prior database state
The gateway SHALL NOT support migrating from a pre-existing database created by a prior version of the gateway (there is no prior database implementation). Migration logic only handles schema evolution from this point forward.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-MIGRATE-012: GATEWAY_CONFIG_PATH remains for compatibility
The `GATEWAY_CONFIG_PATH` environment variable SHALL remain supported for backward compatibility, but its value is only used during seeding. If both `GATEWAY_DB_PATH` and `GATEWAY_CONFIG_PATH` are set, the database takes precedence after first startup.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

## Scenarios

### Scenario: Fresh deployment
**Given** no `gateway.db` exists
**And** `gateway.config.yaml` is valid with 2 models and 1 chain
**When** the gateway starts
**Then** database is created at `./data/gateway.db`
**And** migration 1 is applied
**And** models, chains, and gateway config are seeded from YAML
**And** gateway starts normally

### Scenario: Existing deployment restarts
**Given** `gateway.db` exists from a prior run
**And** the database has data
**When** the gateway starts
**Then** database is opened
**And** pending migrations (if any) are applied
**And** YAML is not read
**And** gateway starts normally using database as source of truth

### Scenario: Invalid YAML on first start
**Given** no `gateway.db` exists
**And** `gateway.config.yaml` has invalid schema (missing required field)
**When** the gateway starts
**Then** validation fails
**And** error message is logged
**And** gateway exits with code 1
**And** no database is created

### Scenario: Schema upgrade
**Given** `gateway.db` exists at schema version 3
**And** the code includes migrations 4 and 5
**When** the gateway starts
**Then** migrations 4 and 5 are applied
**And** `schema_migrations` has rows for versions 1, 2, 3, 4, 5
**And** gateway starts normally

### Scenario: Custom database path
**Given** `GATEWAY_DB_PATH=/var/lib/gateway/production.db`
**When** the gateway starts
**Then** database is created/opened at `/var/lib/gateway/production.db`
**And** parent directories are created if needed
