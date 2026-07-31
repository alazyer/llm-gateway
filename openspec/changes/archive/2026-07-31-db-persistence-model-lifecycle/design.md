# Design: Database Persistence and Model Lifecycle

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Gateway Startup                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Load environment (GATEWAY_DB_PATH, GATEWAY_CONFIG_PATH)                  │
│  2. Initialize database (open or create + migrate)                           │
│  3. If database empty: seed from gateway.config.yaml                         │
│  4. Load AppConfig from database (repository layer)                          │
│  5. Start Fastify server with routes                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Runtime Layer                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────────┐    ┌─────────────────┐    │
│  │ Copilot Proxy    │    │ Model/Chain          │    │ Admin API       │    │
│  │ Registry         │───▶│ Repository           │◀───│ Routes          │    │
│  │ (in-memory conn) │    │ (db read/write)      │    │                 │    │
│  └──────────────────┘    └──────────────────────┘    └─────────────────┘    │
│          │                         │                         │              │
│          │ on connect/disconnect   │                         │              │
│          ▼                         ▼                         ▼              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         SQLite Database                               │  │
│  │  ┌─────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │  │
│  │  │ models  │  │ model_chains│  │ chain_models │  │ gateway_config│  │  │
│  │  └─────────┘  └─────────────┘  └──────────────┘  └───────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### D1: SQLite over PostgreSQL or other server databases

**Decision**: Use SQLite as the persistence backend.

**Rationale**: 
- The gateway is a single-process Node.js application with no existing database dependency.
- SQLite provides zero-configuration, file-based persistence with strong consistency for single-writer workloads.
- No external service to manage, monitor, or fail over.
- Sufficient for the data volume (tens to hundreds of models, not millions).
- Node.js 22+ has built-in SQLite support via `node:sqlite`; alternatively `better-sqlite3` is a mature, synchronous API.

**Trade-offs**:
- Not suitable for multi-instance deployments (would require moving to PostgreSQL or adding distributed coordination).
- No built-in replication or backup; operators must handle file-level backup.

### D2: YAML as seed-only, not live config

**Decision**: The `gateway.config.yaml` file is read only on first startup to seed the database. After seeding, the database is the source of truth.

**Rationale**:
- Allows runtime state changes (model deactivation) to persist across restarts.
- Avoids the complexity of merging YAML changes with database state.
- Operators can still use YAML for initial deployment; subsequent changes go through the admin API.

**Trade-offs**:
- Operators expecting to edit YAML and restart will not see changes reflected.
- Documentation must clearly explain the seed-only behavior.

### D3: Binary model status (active/inactive)

**Decision**: Models have a binary `status` field: `active` or `inactive`.

**Rationale**:
- Simple mental model: a model is either available or not.
- Richer states (`deprecated`, `provisioning`, `error`) can be represented via `status_reason` text without adding state machine complexity.
- Future changes can add explicit states if needed.

**Trade-offs**:
- No built-in "deprecated" state that might warn clients but still serve.
- No automatic health-check-driven transitions in this change (future scope).

### D4: Mark inactive on disconnect, not delete

**Decision**: When a Copilot proxy connection closes, associated models are marked `inactive` rather than deleted.

**Rationale**:
- Preserves model metadata for visibility and potential reconnection.
- Allows chains to reference Copilot models that will come online later.
- Operators can see which models were previously available.

**Trade-offs**:
- Database accumulates inactive models over time. (Mitigation: admin API could add a "purge inactive" endpoint in future.)
- Model identity is by name; if a Copilot extension registers a different model with the same name, it reactivates the existing row.

### D5: Chain status is derived, not manually set

**Decision**: Chain `status` is computed from the status of its constituent models, not set manually.

**Rationale**:
- Ensures chain status is always consistent with model status.
- Eliminates the risk of a chain marked "active" but with all models inactive.
- Operators manage model status; chain status follows automatically.

**Trade-offs**:
- No way to manually deactivate a chain without deactivating all its models. (Future: could add a manual chain-level override if needed.)

### D6: Inactive models skipped in chain execution

**Decision**: When executing a chain, the executor filters out inactive models before attempting fallback.

**Rationale**:
- Inactive models would fail immediately with 503; attempting them wastes time.
- Skipping them allows degraded chains to still serve requests with available models.
- Maintains the fallback semantics: try models in order until one succeeds.

**Trade-offs**:
- A chain with all models inactive returns 503 immediately rather than attempting and failing each model.

### D7: Admin API reuses gateway auth

**Decision**: Admin API endpoints require the same `gateway_auth_token` used for the existing auth hook.

**Rationale**:
- Avoids introducing a second authentication mechanism.
- Operators already have this token configured.
- Simple and consistent.

**Trade-offs**:
- No separate admin-only token; anyone with the gateway token can access admin endpoints. (Future: could add a separate `admin_auth_token_env` if needed.)

## Module Structure

```
src/
├── db/
│   ├── index.ts              # Database connection initialization
│   ├── migrations/
│   │   ├── 001-initial.ts    # Initial schema
│   │   └── index.ts          # Migration runner
│   ├── repository.ts         # Data access layer (models, chains, config)
│   ├── seed.ts               # YAML-to-database seeding
│   └── types.ts              # Database row types
├── routes/
│   ├── admin.ts              # Admin API endpoints (new)
│   └── responses.ts          # Modified to use repository + respect status
├── copilot-proxy/
│   └── registry.ts           # Modified: mark inactive on disconnect
├── chain-executor.ts         # Modified: filter inactive models
├── config.ts                 # Modified: load from database
└── contracts.ts              # Modified: add status fields
```

## Data Flow

### Startup Flow

```
┌─────────────────┐
│ Load env vars   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────┐
│ DB exists?      │──No─▶│ Create DB file   │
└────────┬────────┘     └────────┬─────────┘
         │Yes                    │
         │                       ▼
         │              ┌──────────────────┐
         │              │ Apply migrations │
         │              └────────┬─────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│ Apply pending   │     │ DB empty?        │
│ migrations      │     └────────┬─────────┘
└────────┬────────┘              │
         │                Yes    │    No
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│ Load AppConfig  │◀────│ Seed from YAML   │
│ from DB         │     └──────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Start Fastify   │
└─────────────────┘
```

### Model Status Transition Flow

```
┌─────────────────────────┐
│ Status transition event │
│ (disconnect, admin API) │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Update model row        │
│ (status, reason, ts)    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Find chains referencing │
│ this model              │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ For each chain:         │
│ recalculate status      │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Persist chain status    │
│ to database             │
└─────────────────────────┘
```

### Chain Execution Flow (Modified)

```
┌─────────────────────────┐
│ Resolve chain by name   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Load chain models       │
│ from repository         │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Filter to active models │
│ only                    │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐     ┌──────────────────┐
│ Active models empty?    │─Yes─▶│ Return 503       │
└───────────┬─────────────┘     │ "chain inactive" │
            │No                  └──────────────────┘
            ▼
┌─────────────────────────┐
│ For each active model   │
│ in order:               │
│   attempt request       │
│   if retryable error:   │
│     continue to next    │
│   if success:           │
│     return response     │
└─────────────────────────┘
```

## API Key Handling

API keys are **never** stored in the database. The `models` table stores only `api_key_env` (the environment variable name). At runtime, when loading a model into `AppConfig`, the repository resolves `process.env[api_key_env]` to get the actual key value.

This ensures:
- Secrets remain in environment variables / secret managers.
- Database backups do not contain credentials.
- Existing secret management practices are unchanged.

## Copilot Proxy Registry Integration

The in-memory `CopilotProxyConnectionRegistry` remains for connection-level state (in-flight requests, heartbeat tracking). However, model registration now persists to the database:

1. **On connect/register**: 
   - Check if model exists in DB with `source='copilot-proxy'` and `status='inactive'`.
   - If yes: reactivate (update status, connection_id, capabilities).
   - If no: insert new row with `status='active'`.

2. **On disconnect**:
   - Query DB for models with `connection_id=<closed_connection>`.
   - Update each to `status='inactive'` with reason.
   - Recalculate affected chain statuses.

The registry's in-memory `connections` map continues to track WebSocket state for request dispatch, but model identity and lifecycle state live in the database.

## Error Handling

- **Database open failure**: Log error, exit with code 1.
- **Migration failure**: Log error with migration version, exit with code 1. Database left in pre-migration state.
- **Seed validation failure**: Log validation errors, exit with code 1. No database rows created.
- **Repository query failure**: Log error, return 500 to client. (Queries are simple and should not fail under normal operation.)
- **Status transition failure**: Log error, continue operation. (Non-critical; status can be re-synced.)

## Observability

All status transitions are logged at INFO level with structured fields:
```json
{
  "event": "model_status_transition",
  "model": "copilot-gpt-4",
  "old_status": "active",
  "new_status": "inactive",
  "reason": "Copilot proxy connection closed",
  "timestamp": 1721234567
}
```

Chain status recalculations are logged at INFO level:
```json
{
  "event": "chain_status_recalculated",
  "chain": "primary-fallback",
  "old_status": "active",
  "new_status": "degraded",
  "reason": "1 of 2 models inactive: deepseek-v4-flash",
  "timestamp": 1721234567
}
```

## Testing Strategy

1. **Unit tests** for repository layer (CRUD operations, status transitions, chain recalculation).
2. **Unit tests** for chain executor with inactive models (filtering, degraded behavior).
3. **Integration tests** for admin API endpoints (activate/deactivate, listing).
4. **Integration tests** for Copilot proxy lifecycle (connect → disconnect → reconnect).
5. **Migration tests** (fresh DB, existing DB, schema upgrade).
6. **End-to-end tests** for request routing with inactive models (503 responses, degraded chains).
