# Spec: Database Persistence Layer

## Purpose
Define the SQLite persistence layer, schema, migrations, seeding behavior, and repository access patterns for gateway state.

## Requirements

### REQ-PERSIST-001: SQLite as persistence backend
The gateway SHALL use SQLite as its database backend, accessed via a Node.js SQLite driver (e.g., `better-sqlite3` or Node.js built-in `node:sqlite`).

**Rationale**: The gateway is a single-process Node.js application. SQLite provides zero-configuration, file-based persistence with strong consistency guarantees, suitable for single-writer access patterns. No external database service is required.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-002: Database file location
The database file path SHALL be configurable via the `GATEWAY_DB_PATH` environment variable. If not set, the gateway SHALL default to `./data/gateway.db` relative to the working directory.

**Rationale**: Operators need control over where persistent data is stored, especially in containerized deployments where `/data` may be a mounted volume.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-003: Automatic schema migration
The gateway SHALL apply pending schema migrations automatically on startup. Migrations SHALL be tracked in a `schema_migrations` table with an integer version column. Migrations SHALL be applied sequentially and idempotently.

**Rationale**: Manual migration steps would add operational burden. Automatic migration ensures the schema is always consistent with the running code version.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-004: Database initialization on first start
On first startup (no database file exists), the gateway SHALL create the database, apply all migrations, and seed it from `gateway.config.yaml`. The YAML file acts as a bootstrap seed only; subsequent state changes are persisted to the database.

**Rationale**: Existing deployments must continue to work without modification. The YAML file provides initial configuration; the database becomes the source of truth thereafter.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-005: Seed-on-first-start semantics
If the database already exists and contains data, the gateway SHALL NOT re-seed from YAML on startup. YAML is only read when the database is empty or freshly created.

**Rationale**: Preventing re-seeding avoids overwriting runtime state (e.g., a model manually set to `inactive` via the admin API) every time the gateway restarts.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-006: Model table schema
The gateway SHALL persist models in a `models` table with the following columns:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| name | TEXT | PRIMARY KEY | Unique model identifier |
| upstream_model | TEXT | NOT NULL | Name sent to upstream provider |
| base_url | TEXT | NOT NULL | Upstream API base URL |
| api_key_env | TEXT | NOT NULL | Environment variable name for API key |
| owned_by | TEXT | NOT NULL DEFAULT 'llm-gateway' | Model owner |
| created | INTEGER | NOT NULL | Unix timestamp |
| supports_tools | INTEGER | NOT NULL DEFAULT 1 | Boolean: supports tool calls |
| supports_streaming | INTEGER | NOT NULL DEFAULT 1 | Boolean: supports streaming |
| unknown_field_mode | TEXT | NOT NULL DEFAULT 'warn' | 'warn' or 'enforce' |
| unknown_field_window_requests | INTEGER | NOT NULL DEFAULT 100 | Sliding window size |
| source | TEXT | | 'static' or 'copilot-proxy' |
| source_prefix | TEXT | | Copilot proxy prefix (e.g., 'copilot-') |
| connection_id | TEXT | | Copilot proxy connection ID (nullable) |
| status | TEXT | NOT NULL DEFAULT 'active' | 'active' or 'inactive' |
| status_reason | TEXT | | Human-readable reason for last status change |
| status_changed_at | INTEGER | | Unix timestamp of last status change |
| capabilities_json | TEXT | | JSON blob of Copilot proxy model capabilities |
| updated_at | INTEGER | NOT NULL | Unix timestamp of last row update |
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-007: Model chains table schema
The gateway SHALL persist model chains in a `model_chains` table with the following columns:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| name | TEXT | PRIMARY KEY | Unique chain identifier |
| timeout_ms | INTEGER | NOT NULL | Default per-model timeout |
| max_retries | INTEGER | NOT NULL | Default per-model max retries |
| chain_timeout_ms | INTEGER | | Optional chain-level budget |
| status | TEXT | NOT NULL DEFAULT 'active' | 'active', 'degraded', or 'inactive' |
| status_reason | TEXT | | Human-readable reason for last status change |
| status_changed_at | INTEGER | | Unix timestamp of last status change |
| updated_at | INTEGER | NOT NULL | Unix timestamp of last row update |
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-008: Chain models junction table schema
The gateway SHALL persist chain-model associations in a `chain_models` junction table with the following columns:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| chain_name | TEXT | NOT NULL, FK → model_chains.name | Parent chain |
| position | INTEGER | NOT NULL | 0-based ordering within chain |
| model_name | TEXT | NOT NULL, FK → models.name | Referenced model |
| timeout_ms | INTEGER | | Per-entry override |
| max_retries | INTEGER | | Per-entry override |
| PRIMARY KEY | | (chain_name, position) | Composite key |
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-009: Gateway configuration table
The gateway SHALL persist gateway-level settings in a `gateway_config` table with a single row:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INTEGER | PRIMARY KEY DEFAULT 1 | Singleton row |
| default_model | TEXT | | Default model or chain-<name> |
| request_timeout_ms | INTEGER | NOT NULL DEFAULT 30000 | |
| max_retries | INTEGER | NOT NULL DEFAULT 0 | |
| max_body_size_kb | INTEGER | NOT NULL DEFAULT 1024 | |
| gateway_auth_token_env | TEXT | | |
| health_probe_enabled | INTEGER | NOT NULL DEFAULT 0 | |
| cors_origin | TEXT | | JSON string or null |
| copilot_proxy_enabled | INTEGER | NOT NULL DEFAULT 0 | |
| copilot_proxy_require_token_auth | INTEGER | NOT NULL DEFAULT 1 | |
| copilot_proxy_token_ttl_seconds | INTEGER | NOT NULL DEFAULT 86400 | |
| copilot_proxy_heartbeat_interval_ms | INTEGER | NOT NULL DEFAULT 30000 | |
| copilot_proxy_heartbeat_timeout_ms | INTEGER | NOT NULL DEFAULT 10000 | |
| copilot_proxy_max_inflight_per_connection | INTEGER | NOT NULL DEFAULT 4 | |
| copilot_proxy_allowed_prefixes | TEXT | NOT NULL DEFAULT '["copilot-"]' | JSON array |
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-010: Read-through data access
The gateway SHALL provide a repository layer (`src/db/repository.ts`) that abstracts database reads and writes. The `AppConfig` object SHALL be populated from the database at startup, not directly from YAML. API key values SHALL continue to be resolved from environment variables at runtime (only the `api_key_env` column is stored in the database, never the resolved key value).

**Rationale**: Separating the repository layer from the config loading allows the database to become the source of truth while keeping sensitive credentials out of persistent storage.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

## Scenarios

### Scenario: Fresh startup with YAML seed
**Given** no `gateway.db` file exists
**And** `gateway.config.yaml` defines 2 models and 1 chain
**When** the gateway starts
**Then** SQLite creates `gateway.db`
**And** all migrations are applied
**And** 2 model rows are inserted from the YAML `models` array with `source='static'`
**And** 1 chain row + chain_models rows are inserted from the YAML `model_chains` array
**And** gateway_config is seeded from YAML top-level settings
**And** subsequent requests use the database as the source of truth

### Scenario: Restart with existing database
**Given** `gateway.db` exists with data from a prior run
**And** a model was set to `inactive` via admin API in the prior run
**When** the gateway starts
**Then** the database is opened and pending migrations are applied
**And** YAML is NOT re-read
**And** the `inactive` model retains its `inactive` status

### Scenario: Schema evolution
**Given** `gateway.db` exists at schema version 3
**And** the current code expects schema version 5
**When** the gateway starts
**Then** migrations 4 and 5 are applied sequentially
**And** the application starts normally with the updated schema
