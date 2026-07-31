## Why

All VS Code extension instances currently register models with the hardcoded `copilot-` prefix. This means only one extension type (the Copilot proxy) can register proxied models, and every extension instance competes for the same `copilot-*` namespace. To support multiple distinct extensions — each with its own model source, namespace, and user — each extension instance needs a configurable model ID prefix (e.g., `alazyer-`) that produces namespaced, collision-free model identifiers like `alazyer-copilot-auto`.

## What Changes

- Add a `modelPrefix` configuration setting to the VS Code extension, replacing the hardcoded `copilot-` prefix in model ID generation. Default remains `copilot-` for backward compatibility.
- Add `copilot_proxy_allowed_prefixes` to the gateway YAML configuration, specifying which model ID prefixes the gateway accepts from extension registrations. Extensions registering models with a prefix not on this list are rejected at WebSocket upgrade time.
- Change the shared protocol type `CopilotProxyModel.id` from the template literal `` `copilot-${string}` `` to `string`, with prefix validation enforced at runtime by the gateway.
- Change the shared protocol type `CopilotProxySource` from the literal `"copilot-proxy"` to `string`, allowing the prefix to serve as the source identifier in model metadata.
- Generalize `isCopilotModelName` in the gateway route handlers to check against the configured allowed prefixes instead of the hardcoded `copilot-` string.
- Generalize `assertValidModel` in the gateway connection registry to validate against allowed prefixes instead of the hardcoded `copilot-` check.

## Capabilities

### New Capabilities

- `configurable-model-prefix`: Gateway-side validation and routing of extension-registered models using configurable, operator-defined prefixes instead of a hardcoded `copilot-` namespace.

### Modified Capabilities

- `copilot-model-registry`: The requirement that model names use the `copilot-` prefix is relaxed — models SHALL use an operator-allowed prefix, which defaults to `copilot-` but may include additional prefixes.
- `copilot-proxy-routing`: The requirement that routing target `copilot-*` models is generalized to target models matching any operator-allowed prefix.
- `copilot-proxy-websocket-protocol`: The `register` frame validation is updated to accept models with any allowed prefix; the `source` field becomes the registering prefix rather than the fixed literal `"copilot-proxy"`.
- `vscode-copilot-proxy-extension`: The extension gains a `modelPrefix` configuration setting that controls the prefix applied to registered model IDs. Default remains `copilot-`.

## Impact

- **Code**: Gateway registry validation, route handler prefix checks, shared protocol types, extension config and model-registry modules. 7 files affected, no new modules.
- **APIs**: No new endpoints. Existing model detail route `GET /v1/models/:model` continues to work for dash-separated model IDs. No breaking changes for clients using `copilot-*` models.
- **Dependencies**: None.
- **Config**: New `copilot_proxy_allowed_prefixes` list in gateway YAML; new `modelPrefix` setting in VS Code extension. Both default to existing behavior (`copilot-`).
- **Systems**: No changes to external system requirements. Backward-compatible — existing deployments work without config changes.
