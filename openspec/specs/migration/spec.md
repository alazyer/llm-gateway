# Spec: Migration Path from YAML to Database

## Purpose
Define the backward-compatible migration path from YAML bootstrap configuration to SQLite-backed persistent gateway state.

## Requirements

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

### REQ-MIGRATE-003: Environment variable for database path
The `GATEWAY_DB_PATH` environment variable SHALL specify the database file location. If not set, default to `./data/gateway.db`. The gateway SHALL create parent directories if they do not exist.
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
The `GATEWAY_CONFIG_PATH` environment variable SHALL remain accepted for compatibility, but it SHALL be ignored by runtime startup behavior.
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
