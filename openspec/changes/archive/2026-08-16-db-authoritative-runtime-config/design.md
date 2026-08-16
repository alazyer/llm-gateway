## Context

Current startup always parses YAML from `GATEWAY_CONFIG_PATH` via `loadConfigForRuntime()`, then applies DB fallback for only part of the config. This keeps YAML in the runtime critical path and conflicts with the desired behavior: DB-authoritative runtime, permissive startup, and inference-time validation for model/chain existence and credentials.

The confirmed behavior contract is:
- `GATEWAY_CONFIG_PATH` is optional and ignored at runtime.
- Startup must not be blocked by missing models/chains or missing model credentials.
- `gateway_config(id=1)` must always exist (auto-create defaults when absent).
- No configured models/chains returns empty lists in listing APIs.
- Inference returns `404` for missing model/chain and `500` for existing-but-misconfigured targets.
- `/healthz` stays `200` and surfaces config state details.

## Goals / Non-Goals

**Goals:**
- Remove YAML dependency from runtime startup path.
- Make database the sole runtime configuration source for gateway and catalog state.
- Keep startup permissive while enforcing correctness at inference resolution.
- Provide deterministic and consistent API semantics for empty/missing/misconfigured states.

**Non-Goals:**
- Migrating existing YAML files into DB automatically at startup.
- Introducing new secret storage (secrets remain in environment variables referenced by `api_key_env`).
- Redesigning admin API surface beyond what is required for the new runtime behavior.
- Changing deployment env controls (`HOST`, `PORT`, `LOG_LEVEL`) from env-driven to DB-driven.

## Decisions

### D1. Runtime configuration source is DB-only
**Decision:** Startup no longer reads YAML for runtime behavior. `GATEWAY_CONFIG_PATH` is accepted but ignored.

**Rationale:** Eliminates dual-source drift and removes file-coupled startup requirements.

**Alternatives considered:**
- Keep YAML seed-on-empty-DB: rejected per confirmed behavior.
- Fail startup when YAML exists: rejected to avoid breaking existing env configurations.

### D2. Startup ensures `gateway_config` singleton
**Decision:** During bootstrap, ensure `gateway_config(id=1)` exists; if absent, insert defaults equivalent to current schema defaults.

**Rationale:** Guarantees minimal runtime baseline without requiring pre-seeded data.

**Alternatives considered:**
- Fail startup when singleton is absent: rejected; conflicts with permissive startup.
- Require external migration tooling before first boot: rejected; too operationally strict.

### D3. Catalog emptiness is valid runtime state
**Decision:** Zero models/chains is a valid started state. Listing/discovery endpoints return empty arrays.

**Rationale:** Supports first-boot and staged provisioning without process failure.

**Alternatives considered:**
- Fail startup with “no models configured”: rejected by contract.
- Return service unavailable globally: rejected; non-inference endpoints should remain usable.

### D4. Inference error classification by failure type
**Decision:** 
- Missing model/chain target resolves to `404`.
- Existing target with runtime misconfiguration (for example unresolved `api_key_env`) resolves to `500`.
- Broken chain resolution/execution fails the whole request; no partial success fallback.

**Rationale:** Distinguishes “not found” from “found but broken,” while keeping chain behavior deterministic.

**Alternatives considered:**
- Return `503` for unconfigured/misconfigured: rejected by contract.
- Partial chain fallback under broken metadata: rejected to avoid hidden inconsistencies.

### D5. Health remains process-level, with config-state detail
**Decision:** `/healthz` returns `200` when process is alive and includes state fields (e.g., configured flag, model/chain counts), instead of failing on empty catalog.

**Rationale:** Aligns with permissive startup and separates liveness from inference readiness.

**Alternatives considered:**
- Preserve current no-model `503`: rejected by confirmed behavior.

## Risks / Trade-offs

- **[Risk] Silent reliance on YAML in operator mental model** → **Mitigation:** document that YAML is ignored at runtime; update README and migration spec.
- **[Risk] Startup succeeds but inference fails later due to missing secrets** → **Mitigation:** provide explicit `500` code/message for missing credentials and include details in logs.
- **[Risk] Existing tests assert YAML seeding behavior** → **Mitigation:** update migration/persistence specs and adapt tests to DB-first runtime expectations.
- **[Risk] Empty catalog may confuse clients** → **Mitigation:** enforce consistent empty-list behavior on catalog endpoints and clear `404` semantics on targeted inference.

## Migration Plan

1. Update config loading contract so `GATEWAY_CONFIG_PATH` is optional and not used for runtime state resolution.
2. Add/adjust bootstrap step to ensure `gateway_config(id=1)` exists with defaults after migrations.
3. Route runtime config assembly through DB repositories only.
4. Update model/chain resolution and inference handlers to implement `404`/`500` semantics.
5. Update `/healthz` response contract to keep `200` and include configuration-state fields.
6. Update OpenSpec capability specs (`migration`, `persistence`, `model-chain-resolution`, `enhanced-health`) and tests.

Rollback strategy:
- Revert to prior startup path that reads YAML and seeds/derives runtime config from it.
- Restore previous health and inference error semantics.

## Open Questions

- Should we emit an explicit startup log line when `GATEWAY_CONFIG_PATH` is set but ignored to aid operator debugging?
- Should health expose a single `configured` boolean, or a richer shape (`models`, `chains`, `default_model_present`, credential check summary)?
