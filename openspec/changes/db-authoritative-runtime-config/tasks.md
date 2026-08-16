## 1. Runtime bootstrap and configuration loading

- [ ] 1.1 Make `GATEWAY_CONFIG_PATH` optional in `src/config.ts` and remove YAML from runtime bootstrap path.
- [ ] 1.2 Ensure startup always runs migrations, then guarantees `gateway_config(id=1)` exists with defaults when missing.
- [ ] 1.3 Refactor runtime config assembly to load gateway/runtime state from DB repositories plus environment-resolved secrets only.
- [ ] 1.4 Keep startup permissive when `models` and `model_chains` are empty, without process exit.

## 2. Inference resolution and error semantics

- [ ] 2.1 Update model/chain resolution to return `404` for missing requested model or chain.
- [ ] 2.2 Update default-model resolution so omitted `model` returns `404` when default target is absent/unresolvable.
- [ ] 2.3 Enforce `500` for existing targets with runtime misconfiguration (for example missing `api_key_env` value).
- [ ] 2.4 Enforce full chain request failure when chain metadata/configuration is broken (no implicit partial fallback around broken entries).

## 3. Health and listing behavior

- [ ] 3.1 Update `/healthz` to return HTTP 200 for process/config liveness even when model catalog is empty.
- [ ] 3.2 Include explicit configuration-state details in `/healthz` response (e.g., configured flag and model count).
- [ ] 3.3 Ensure catalog/listing endpoints return empty collections when no models/chains are configured.

## 4. Validation, tests, and documentation

- [ ] 4.1 Update existing tests that assume YAML seeding/startup coupling to DB-first permissive startup behavior.
- [ ] 4.2 Add/update tests for `404` missing target semantics and `500` misconfigured target semantics on inference routes.
- [ ] 4.3 Add/update tests for chain failure behavior when chain entries are broken/misconfigured.
- [ ] 4.4 Add/update health endpoint tests for HTTP 200 with unconfigured state details.
- [ ] 4.5 Update README and operator docs to state `GATEWAY_CONFIG_PATH` is optional/ignored at runtime and DB/admin provisioning is authoritative.

