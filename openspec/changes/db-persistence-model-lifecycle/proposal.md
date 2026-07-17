# Proposal: Database Persistence and Model Lifecycle for LLM Gateway

## Problem

The LLM Gateway loads all model and model_chain configuration from `gateway.config.yaml` at startup. Self-registered models (from Copilot proxy extensions) exist only in the in-memory `CopilotProxyConnectionRegistry` and vanish when their WebSocket connection drops. There is no persistence for runtime state, no lifecycle management for models, and no way to track or reactivate disconnected providers without re-registration.

This creates three concrete problems:

1. **Self-registered models are ephemeral**: When a Copilot proxy extension disconnects, its models are immediately deleted from the registry. Any configuration or metadata associated with those models is lost. If the provider reconnects, it must fully re-register from scratch.

2. **No model lifecycle control**: There is no mechanism to mark a model as inactive, deprecated, or temporarily unavailable. A model is either fully present in the config or absent. Operators cannot gracefully deprecate a model or temporarily disable it without editing the YAML and restarting.

3. **No chain resilience to model unavailability**: Model chains perform strict cross-field validation at startup — every referenced model must exist. There is no concept of a chain with partially available models. If any model in a chain goes offline, the chain either continues attempting that model (producing errors) or the entire chain becomes unusable.

## Scope

This change introduces:

- A **database persistence layer** (SQLite) for models, model chains, and runtime lifecycle state
- An **active/inactive lifecycle** for models (static and self-registered), with defined transition rules
- **Graceful handling of Copilot proxy disconnection** — models are marked inactive rather than deleted, and reconnection reactivates them
- **Chain-level resilience** — inactive models within a chain are skipped during fallback execution; chains gain a derived `degraded` status
- A **migration path** from YAML-only to database-backed configuration, with YAML remaining as a seed/bootstrap mechanism

## Non-goals

- Multi-instance or distributed coordination (the gateway remains single-process)
- PostgreSQL or other server-database support (SQLite is sufficient for the single-process deployment model)
- Automatic health-check-driven model state transitions (future scope; this change defines the persistence and lifecycle primitives only)
- Admin UI or web dashboard (API-only in this change)
- Modifying the Copilot proxy WebSocket protocol itself

## Impact

- **`src/config.ts`**: Startup flow changes to support YAML-to-DB seeding; `AppConfig.models` and `AppConfig.modelChains` will be populated from the database rather than directly from YAML
- **`src/copilot-proxy/registry.ts`**: `removeConnection` behavior changes from delete to mark-inactive; reconnection logic added
- **`src/contracts.ts`**: New `status` fields on `ChainModelEntry`, `ModelChainConfig`, and a new `GatewayModelConfig` variant with lifecycle fields
- **`src/routes/responses.ts`**: `resolveModel()` and `createModelsList()` must respect active/inactive status; chain execution must skip inactive models
- **`src/chain-executor.ts`**: Chain execution must filter out inactive models before attempting fallback
- **New module `src/db/`**: Database schema, migrations, repository/query layer
- **New module `src/routes/admin.ts`**: Admin API endpoints for lifecycle management
- **`gateway.config.yaml`**: Continues to work as-is; becomes a seed source on first startup
