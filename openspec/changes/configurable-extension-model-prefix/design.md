## Context

The llm-gateway is a Fastify proxy that translates between three client-facing API surfaces (`/responses`, `/v1/chat/completions`, `/v1/messages`) and a single upstream transport (OpenAI-compatible `/chat/completions`). The Copilot proxy subsystem adds a second model source: VS Code extensions connect via WebSocket to `/ws/copilot-proxy`, discover Copilot models through `vscode.lm`, register them with the gateway, and execute inference requests.

Today, all model IDs from extensions use the hardcoded `copilot-` prefix. The `CopilotProxyConnectionRegistry` already supports multiple concurrent WebSocket connections (one per VS Code window), but all connections register models in the same `copilot-*` namespace. This means only one extension type can exist — the `llm-gateway-copilot-proxy` extension — and every instance competes for the same model identifiers.

The change generalizes the namespace so that each extension instance can declare its own prefix (e.g., `alazyer-`), producing model IDs like `alazyer-copilot-auto`. The gateway validates prefixes against an operator-configured allowlist before accepting registrations.

## Goals / Non-Goals

**Goals:**
- Allow each VS Code extension instance to configure its own model ID prefix.
- Allow the gateway to validate and enforce allowed prefixes via YAML configuration.
- Preserve full backward compatibility — existing `copilot-` deployments must work without any config changes.
- Keep the existing WebSocket protocol, connection registry, auth, and stream adaptation unchanged.
- Expose prefix/channel information for operational visibility.

**Non-Goals:**
- Embedding VS Code's extension host in the browser — extensions remain desktop-side.
- Supporting non-dash characters in prefixes (e.g., `/`) — we standardize on dash-separated identifiers.
- Implementing per-prefix rate limiting or quota tracking beyond the existing per-connection in-flight cap.
- Changing the shared `@llm-gateway/shared` protocol frame structure — only the `id` and `source` field value ranges change.

## Decisions

### 1. Dash-separated prefixes only (no `/`)

**Decision**: Prefixes MUST match `^[a-zA-Z0-9][a-zA-Z0-9._-]*-$` — they must start with an alphanumeric character, may contain dots and dashes, and must end with a dash.

**Rationale**: Model IDs appear in URL path segments (`GET /v1/models/:model`). A `/` in a model ID would require URL-encoding, which some HTTP clients don't handle correctly in path segments. Dash-separated IDs are consistent with existing OpenAI/Anthropic conventions and the gateway's own `copilot-gpt-4o` pattern.

**Alternative considered**: Allow `owner/model` format (e.g., `alazyer/copilot-auto`). Rejected because it introduces URL-encoding friction and breaks the existing dash-separated convention without sufficient benefit.

### 2. Gateway-validated prefix allowlist

**Decision**: The gateway reads `copilot_proxy_allowed_prefixes` from YAML. Only models whose IDs start with a prefix on this list are accepted during registration. Models with disallowed prefixes cause the registration to be rejected and the connection closed with code `1008`.

**Rationale**: This prevents a misconfigured or rogue extension from polluting the model namespace. It also gives operators explicit control over which extension namespaces are active on their gateway instance.

**Alternative considered**: Trust whatever prefix the extension sends (no gateway-side validation). Rejected because it provides no namespace governance — one misconfigured extension could register models under another team's prefix.

### 3. Default allowlist preserves existing behavior

**Decision**: When `copilot_proxy_allowed_prefixes` is not specified in the YAML, the gateway defaults to `["copilot-"]`. This means existing deployments that don't add the new config key continue to work exactly as before.

**Rationale**: Zero-migration-path adoption. Operators only need to update their YAML when they want to enable additional prefixes.

### 4. `source` field mirrors the matched prefix

**Decision**: When a model is registered with a prefix from the allowlist, the `source` field on the model record is set to that prefix string (e.g., `"alazyer-"`) rather than the current hardcoded `"copilot-proxy"`.

**Rationale**: The `source` field already appears in `/v1/models` responses as namespace metadata. Using the prefix as the source gives clients a clear, machine-readable indicator of which extension namespace a model belongs to. It also eliminates the need for a separate `channel` concept — the prefix IS the channel.

**Alternative considered**: Keep `source: "copilot-proxy"` for all extensions and add a separate `prefix` field. Rejected because it duplicates information and requires clients to look at two fields to understand the namespace.

### 5. Generalize `isCopilotModelName` to check allowed prefixes

**Decision**: Replace the `isCopilotModelName` function (which checks `startsWith("copilot-")`) with an `isProxiedModelName` function that checks `startsWith` against the configured allowed prefixes list. The allowed prefixes are passed through the route options, same way the registry is today.

**Rationale**: The current function is a fast-reject optimization to avoid unnecessary registry lookups. Generalizing it preserves the optimization while supporting multiple prefixes.

**Alternative considered**: Remove the prefix check entirely and always do a registry lookup. Simpler code but loses the fast-reject for clearly non-proxied models. Kept the prefix check for efficiency.

### 6. `CopilotProxyModel.id` type changes to `string`

**Decision**: Change the shared protocol type from `` `copilot-${string}` `` to `string`. Runtime validation in the gateway's `assertValidModel` enforces the prefix constraint.

**Rationale**: TypeScript template literal types cannot express "string starting with one of N configurable prefixes." Runtime validation is already required for the allowlist check, so the compile-time type guard provides no additional safety and becomes a friction point when the extension sends a non-`copilot-` prefix.

**Alternative considered**: Use a generic type parameter `` `CopilotProxyModel<T extends string>` ``. Rejected as over-engineering — only one variant of the type is ever used at runtime.

### 7. Extension `modelPrefix` config with `copilot-` default

**Decision**: Add `llmGatewayCopilotProxy.modelPrefix` setting with default `"copilot-"`. The extension uses this prefix when constructing model IDs from discovered `vscode.lm` models.

**Rationale**: Default preserves backward compatibility. The setting is a simple string — operators set it once per extension instance and don't need to think about it again.

### 8. New `/api/channels` management endpoint

**Decision**: Add `GET /api/channels` (requires gateway auth) that returns active prefixes, connected extension count per prefix, and registered model IDs per prefix.

**Rationale**: Operators need visibility into which prefixes are active and how many extensions are serving each. This is useful for debugging, capacity planning, and verifying that new prefixes are working after config changes.

**Alternative considered**: Add prefix info to `/healthz`. Rejected — `/healthz` should stay focused on binary up/down status. Channel detail is a management concern.

## Risks / Trade-offs

- **Existing deployments must not break** → Default allowed prefixes is `["copilot-"]`, default extension prefix is `"copilot-"`. No config change needed for existing setups.
- **Two extensions register the same model ID** → Already handled by `listModels()` which deduplicates by first-registered. The prefix makes collisions unlikely but not impossible (two extensions with the same prefix). This is the same risk that exists today with two VS Code windows.
- **Prefix allowlist requires gateway restart to change** → Accepted for the first implementation. Hot-reload of allowed prefixes could be added later if needed.
- **`source` field changes from `"copilot-proxy"` to the prefix string** → This is a visible change in `/v1/models` responses. Clients currently checking `source === "copilot-proxy"` will need to update to `source.startsWith(allowedPrefix)`. This is a **BREAKING** change for clients that do exact string matching on `source`.
- **`CopilotProxyModel.id` type widening from template literal to `string`** → This removes compile-time enforcement of the `copilot-` prefix. Downstream code that relied on the type narrowing will need to use runtime checks. The `assertValidModel` function already provides this.
- **`protocol.typecheck.ts` compile breakage** → `packages/shared/src/protocol.typecheck.ts` has an `@ts-expect-error` on line 72 asserting that `"gpt-4o"` is not assignable to `` `copilot-${string}` ``. After the type change to `string`, this directive becomes stale ("Unused '@ts-expect-error'") and will itself cause a compile error. The file also hardcodes `"copilot-gpt-4o"` and `"copilot-proxy"` literals in its test variables that must be updated for consistency with the new generalized types. Task 1.3 addresses this.

## Migration Plan

1. Add `copilot_proxy_allowed_prefixes` to the YAML schema with default `["copilot-"]`. Existing configs without this key are equivalent.
2. Deploy the gateway change. No behavior change for existing deployments.
3. For teams that want their own prefix: add the prefix to `copilot_proxy_allowed_prefixes` in the gateway YAML, restart the gateway, then configure the extension's `modelPrefix` setting.
4. Update any clients that do exact matching on `source: "copilot-proxy"` to handle the new prefix-based source values.

**Rollback**: Remove the new prefix from the gateway YAML and restart. Extensions with that prefix will have their registrations rejected. Revert the extension's `modelPrefix` setting to `"copilot-"`.

## Open Questions

1. Should the `/api/channels` endpoint also show the extension connection IDs, or just aggregate counts?
2. Should we enforce that prefix strings end with a dash (`-`), or allow any valid pattern?
3. Is there a need for per-prefix health checks in `/healthz`, or is the management endpoint sufficient?
