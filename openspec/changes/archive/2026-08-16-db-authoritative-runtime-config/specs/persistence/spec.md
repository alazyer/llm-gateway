## MODIFIED Requirements

### REQ-PERSIST-004: Database initialization on first start
On first startup (no database file exists), the gateway SHALL create the database, apply all migrations, ensure `gateway_config(id=1)` exists, and start successfully even when no models or chains are configured.

**Rationale**: Database-first startup must not depend on YAML or pre-provisioned catalogs.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-005: Seed-on-first-start semantics
Startup SHALL NOT perform YAML seeding behavior. An empty model/chain catalog is a valid runtime state; listing/discovery APIs SHALL return empty collections until configuration is provisioned.

**Rationale**: Runtime state is owned by the database and provisioned through management APIs/tools.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-PERSIST-010: Read-through data access
The gateway SHALL provide a repository layer (`src/db/repository.ts`) that abstracts database reads and writes. The `AppConfig` runtime object SHALL be populated from database state. API key values SHALL continue to be resolved from environment variables at runtime (only the `api_key_env` column is stored in the database, never the resolved key value). Missing runtime secret values SHALL surface as inference-path failures for affected targets, not as startup failure.

**Rationale**: Preserves startup permissiveness while keeping secrets out of persistent storage.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

