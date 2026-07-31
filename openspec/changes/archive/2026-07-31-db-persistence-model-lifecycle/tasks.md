# Tasks: Database Persistence and Model Lifecycle

## Phase 1: Database Foundation

### Task 1.1: Add SQLite dependency
**File**: `package.json`
**Description**: Add `better-sqlite3` (or use Node.js built-in `node:sqlite` if on Node 22+) as the SQLite driver. Add type definitions if needed.
**Estimate**: 15 minutes
**Owner**: Planner

### Task 1.2: Create database connection module
**File**: `src/db/index.ts`
**Description**: Implement database initialization:
- Accept `GATEWAY_DB_PATH` env var, default to `./data/gateway.db`.
- Create parent directories if they don't exist.
- Open database connection.
- Enable WAL mode for better concurrency (single writer, but allows reads during writes).
- Export a singleton database connection or a connection getter.
**Estimate**: 30 minutes
**Owner**: Planner

### Task 1.3: Create migration infrastructure
**Files**: `src/db/migrations/index.ts`, `src/db/migrations/001-initial.ts`
**Description**: 
- Implement migration runner that queries `schema_migrations` table for current version.
- Apply pending migrations sequentially.
- Each migration is a function that receives the database connection and executes DDL.
- Wrap each migration in a transaction.
- Log applied migrations.
**Estimate**: 1 hour
**Owner**: Planner

### Task 1.4: Implement initial schema migration
**File**: `src/db/migrations/001-initial.ts`
**Description**: Create all tables per REQ-PERSIST-006 through REQ-PERSIST-009:
- `schema_migrations`
- `models`
- `model_chains`
- `chain_models`
- `gateway_config`
**Estimate**: 45 minutes
**Owner**: Planner

### Task 1.5: Create database row types
**File**: `src/db/types.ts`
**Description**: Define TypeScript interfaces for database rows:
- `ModelRow`
- `ModelChainRow`
- `ChainModelRow`
- `GatewayConfigRow`
- `SchemaMigrationRow`
**Estimate**: 30 minutes
**Owner**: Planner

## Phase 2: Repository Layer

### Task 2.1: Implement model repository
**File**: `src/db/repository.ts`
**Description**: Implement CRUD operations for models:
- `getAllModels(): Promise<ModelRow[]>`
- `getModelByName(name: string): Promise<ModelRow | null>`
- `getActiveModels(): Promise<ModelRow[]>`
- `insertModel(model: ModelRow): Promise<void>`
- `updateModelStatus(name: string, status: 'active' | 'inactive', reason: string): Promise<void>`
- `updateModelConnection(name: string, connectionId: string | null, capabilities: ...): Promise<void>`
- `getModelsByConnection(connectionId: string): Promise<ModelRow[]>`
- `reactivateOrInsertModel(model: ModelRow): Promise<void>` — for Copilot reconnect
**Estimate**: 2 hours
**Owner**: Planner

### Task 2.2: Implement chain repository
**File**: `src/db/repository.ts`
**Description**: Implement CRUD operations for chains:
- `getAllChains(): Promise<ModelChainRow[]>`
- `getChainByName(name: string): Promise<ModelChainRow | null>`
- `getChainModels(chainName: string): Promise<ChainModelRow[]>`
- `insertChain(chain: ModelChainRow, models: ChainModelRow[]): Promise<void>`
- `updateChainStatus(name: string, status: 'active' | 'degraded' | 'inactive', reason: string): Promise<void>`
- `getChainsReferencingModel(modelName: string): Promise<string[]>`
- `recalculateChainStatus(chainName: string): Promise<void>` — derive status from model statuses
**Estimate**: 2 hours
**Owner**: Planner

### Task 2.3: Implement gateway config repository
**File**: `src/db/repository.ts`
**Description**: Implement gateway config operations:
- `getGatewayConfig(): Promise<GatewayConfigRow | null>`
- `insertGatewayConfig(config: GatewayConfigRow): Promise<void>`
- `updateGatewayConfig(partial: Partial<GatewayConfigRow>): Promise<void>`
**Estimate**: 30 minutes
**Owner**: Planner

### Task 2.4: Implement chain status recalculation
**File**: `src/db/repository.ts`
**Description**: Implement the chain status derivation logic:
- Query all models in the chain.
- Count active vs inactive.
- Determine status: active (all active), degraded (some active), inactive (all inactive).
- Build status_reason string.
- Update chain row.
**Estimate**: 1 hour
**Owner**: Planner

## Phase 3: Seeding

### Task 3.1: Implement YAML-to-database seeding
**File**: `src/db/seed.ts`
**Description**: 
- Parse `gateway.config.yaml` using existing YAML parsing logic.
- Run existing validation (schema + cross-field).
- Insert models with `source='static'`.
- Insert chains + chain_models.
- Insert gateway_config.
- Wrap in a transaction.
**Estimate**: 1.5 hours
**Owner**: Planner

### Task 3.2: Integrate seeding into startup
**File**: `src/config.ts` (modified)
**Description**: 
- After database init, check if `models` table is empty.
- If empty, call seed function.
- Log seeding action.
**Estimate**: 30 minutes
**Owner**: Planner

## Phase 4: Config Loading Refactor

### Task 4.1: Load AppConfig from database
**File**: `src/config.ts` (modified)
**Description**: 
- Replace direct YAML parsing with database reads.
- Use repository layer to load models, chains, gateway config.
- Resolve API keys from environment variables using `api_key_env` column.
- Build `AppConfig` object.
- Handle missing database (should not happen after init).
**Estimate**: 1.5 hours
**Owner**: Planner

### Task 4.2: Add status fields to contracts
**File**: `src/contracts.ts` (modified)
**Description**: 
- Add `status`, `statusReason`, `statusChangedAt` to `GatewayModelConfig` interface.
- Add `status`, `statusReason`, `statusChangedAt` to `ModelChainConfig` interface.
- Add `activeModels`, `totalModels` to chain-related types.
**Estimate**: 30 minutes
**Owner**: Planner

## Phase 5: Model Lifecycle

### Task 5.1: Modify Copilot proxy registry for persistence
**File**: `src/copilot-proxy/registry.ts` (modified)
**Description**: 
- On `replaceRegistration`: call `reactivateOrInsertModel` for each model.
- On `removeConnection`: call `updateModelStatus` for each model with that connection_id, then recalculate affected chains.
- Pass database repository reference to registry constructor.
**Estimate**: 2 hours
**Owner**: Planner

### Task 5.2: Implement status transition logging
**File**: `src/db/repository.ts` (modified)
**Description**: 
- Add structured logging to `updateModelStatus` and `updateChainStatus`.
- Include old status, new status, reason, timestamp.
**Estimate**: 30 minutes
**Owner**: Planner

## Phase 6: Chain Resilience

### Task 6.1: Filter inactive models in chain executor
**File**: `src/chain-executor.ts` (modified)
**Description**: 
- At the start of `executeChain` and `executeChainStream`, filter `chain.models` to active only.
- If no active models, throw `ChainInactiveError` (new error type).
- Add `x-chain-status` header to responses when chain is degraded.
**Estimate**: 1 hour
**Owner**: Planner

### Task 6.2: Handle chain inactive error in routes
**File**: `src/routes/responses.ts` (modified)
**Description**: 
- Catch `ChainInactiveError` in handlers.
- Return 503 with appropriate message.
- Add error handling to `sendError`, `sendAnthropicError`, `sendOpenAiError`.
**Estimate**: 30 minutes
**Owner**: Planner

### Task 6.3: Resolve model respects status
**File**: `src/routes/responses.ts` (modified)
**Description**: 
- Modify `resolveModel` to check model status.
- If model is inactive, throw `RouteError` with 503 and status_reason.
**Estimate**: 30 minutes
**Owner**: Planner

## Phase 7: Admin API

### Task 7.1: Create admin routes module
**File**: `src/routes/admin.ts` (new)
**Description**: Implement admin API endpoints:
- `GET /admin/models` — list all models with status
- `GET /admin/models/:name` — single model detail
- `POST /admin/models/:name/activate` — activate model
- `POST /admin/models/:name/deactivate` — deactivate model
- `GET /admin/chains` — list all chains with status
- `GET /admin/chains/:name` — single chain detail
- `GET /admin/status` — gateway status summary
- `GET /admin/database` — database info
**Estimate**: 3 hours
**Owner**: Planner

### Task 7.2: Register admin routes in app
**File**: `src/app.ts` (modified)
**Description**: 
- Import and register admin routes.
- Ensure admin routes use existing auth hook.
**Estimate**: 15 minutes
**Owner**: Planner

## Phase 8: Model Listing Updates

### Task 8.1: Add status to /models responses
**File**: `src/routes/responses.ts` (modified)
**Description**: 
- Modify `createModelRecord` to include `status` field.
- Modify `createChainModelRecord` to include `status`, `active_models`, `total_models`.
- Add `?status=active` query parameter filtering.
**Estimate**: 1 hour
**Owner**: Planner

## Phase 9: Testing

### Task 9.1: Unit tests for repository
**File**: `tests/db/repository.test.ts`
**Description**: 
- Test model CRUD operations.
- Test chain CRUD operations.
- Test status transitions.
- Test chain status recalculation.
- Use in-memory SQLite for tests.
**Estimate**: 2 hours
**Owner**: Planner

### Task 9.2: Unit tests for chain executor with status
**File**: `tests/chain-executor-status.test.ts`
**Description**: 
- Test filtering inactive models.
- Test degraded chain execution.
- Test all-inactive chain returns error.
**Estimate**: 1.5 hours
**Owner**: Planner

### Task 9.3: Integration tests for admin API
**File**: `tests/routes/admin.test.ts`
**Description**: 
- Test all admin endpoints.
- Test authentication requirement.
- Test status transitions.
**Estimate**: 2 hours
**Owner**: Planner

### Task 9.4: Integration tests for Copilot lifecycle
**File**: `tests/copilot-proxy/lifecycle.test.ts`
**Description**: 
- Test connect → register → disconnect → mark inactive.
- Test reconnect → reactivate.
- Test chain status updates on Copilot model status change.
**Estimate**: 2 hours
**Owner**: Planner

### Task 9.5: Migration tests
**File**: `tests/db/migrations.test.ts`
**Description**: 
- Test fresh database creation.
- Test seeding from YAML.
- Test schema upgrade (apply multiple migrations).
- Test idempotent seeding.
**Estimate**: 1.5 hours
**Owner**: Planner

## Phase 10: Documentation

### Task 10.1: Update README
**File**: `README.md` (modified)
**Description**: 
- Document database persistence.
- Document `GATEWAY_DB_PATH` env var.
- Document seed-only YAML behavior.
- Document admin API endpoints.
**Estimate**: 30 minutes
**Owner**: Planner

### Task 10.2: Add example gateway.config.yaml comments
**File**: `gateway.config.example.yaml` (modified)
**Description**: 
- Add comments explaining YAML is seed-only.
- Reference admin API for runtime changes.
**Estimate**: 15 minutes
**Owner**: Planner

---

## Task Summary

| Phase | Tasks | Estimate |
|-------|-------|----------|
| 1. Database Foundation | 5 | 3h 15m |
| 2. Repository Layer | 4 | 5h 30m |
| 3. Seeding | 2 | 2h |
| 4. Config Loading Refactor | 2 | 2h |
| 5. Model Lifecycle | 2 | 2h 30m |
| 6. Chain Resilience | 3 | 2h |
| 7. Admin API | 2 | 3h 15m |
| 8. Model Listing Updates | 1 | 1h |
| 9. Testing | 5 | 9h |
| 10. Documentation | 2 | 45m |
| **Total** | **28** | **~31h** |

## Critical Path

1. Phase 1 (Database Foundation) → Phase 2 (Repository) → Phase 4 (Config Loading)
2. Phase 1 → Phase 3 (Seeding) → Phase 4
3. Phase 2 → Phase 5 (Model Lifecycle) → Phase 6 (Chain Resilience)
4. Phase 2 → Phase 7 (Admin API)
5. Phase 6 → Phase 8 (Model Listing)
6. All phases → Phase 9 (Testing) → Phase 10 (Documentation)

## Parallelization Opportunities

- Phase 2 tasks can run in parallel once Phase 1 is complete.
- Phase 7 (Admin API) can start once Phase 2 repository is ready.
- Phase 8 can start once Phase 6 chain resilience is ready.
- Phase 9 tests can be written in parallel with implementation (TDD style).
