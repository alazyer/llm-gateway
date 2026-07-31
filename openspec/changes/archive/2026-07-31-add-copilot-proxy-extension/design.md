## Context

llm-gateway is currently a Fastify translation proxy with OpenAI-compatible `/v1/chat/completions`, Anthropic-compatible `/v1/messages`, `/responses`, model discovery, incoming auth, CORS, health checks, request guardrails, and upstream resilience. Models are configured statically in YAML and dispatched to OpenAI SDK-compatible upstream providers through the existing Chat Completions transport.

COM-27 introduces a second model source: GitHub Copilot models available only inside a running VS Code extension host through `vscode.lm`. The gateway cannot and must not call Copilot internal APIs directly. Instead, a VS Code extension connects outward to the gateway over WebSocket, registers available Copilot models, receives inference requests, calls `vscode.lm`, and streams gateway protocol frames back to the original HTTP client.

Legal review is a blocking precondition before implementation because making Copilot subscription responses available to external CLI tools may be restricted by GitHub Copilot terms.

Legal approval was recorded on 2026-06-26 before runtime implementation began. No additional usage constraints were provided with the approval.

## Goals / Non-Goals

**Goals:**
- Preserve existing CLI-facing endpoints while adding `copilot-*` model routing.
- Keep Copilot authentication entirely inside VS Code and the Copilot extension.
- Add an authenticated gateway-to-extension WebSocket protocol for registration, health, request dispatch, cancellation, and streaming.
- Dynamically expose Copilot-backed models through the gateway model registry and remove them on disconnect.
- Support Responses-compatible, OpenAI-compatible, and Anthropic-compatible streaming translations for Copilot proxy responses.
- Add a VS Code extension package with lifecycle, configuration, WebSocket reconnect, model discovery, status reporting, and Copilot request execution.
- Share protocol and model/stream types between the gateway and extension.

**Non-Goals:**
- Calling Copilot's private or undocumented network APIs from the gateway.
- Extracting, storing, logging, or forwarding Copilot auth tokens.
- Replacing existing direct upstream provider configuration or model routing.
- Guaranteeing all `vscode.lm` models support tools, token accounting, or concurrency; these are discovered and reported as capabilities.
- Implementing automatic gateway retries for Copilot requests after they have been accepted by the extension.
- Beginning implementation before legal approval.

## Decisions

1. **Route by `copilot-*` model prefix**
   - Use `copilot-` as the gateway-visible namespace for Copilot-backed models.
   - Rationale: avoids collision with direct upstream names such as `gpt-4o` and gives clients an explicit routing key.
   - Alternative considered: reuse native model names and infer source from registry. Rejected because it creates ambiguous routing when the same model is available through direct and Copilot-backed sources.

2. **Gateway remains the CLI-facing HTTP/SSE authority**
   - CLI tools continue calling `/responses`, `/v1/responses`, `/v1/chat/completions`, and `/v1/messages`.
   - Rationale: preserves existing client configuration and keeps gateway auth, request validation, model discovery, and endpoint-specific response translation centralized.
   - Alternative considered: CLI tools call the VS Code extension directly. Rejected because the extension cannot reliably expose an externally reachable server and this bypasses gateway controls.

3. **Extension connects as a persistent WebSocket client**
   - Gateway exposes `/ws/copilot-proxy`; the VS Code extension initiates the connection.
   - Rationale: VS Code is often behind NAT/firewalls, and bidirectional streaming is required.
   - Alternative considered: HTTP callbacks from gateway to extension. Rejected due to reachability and lifecycle issues.

4. **Shared JSON-frame protocol with correlation IDs**
   - Every inference request gets a gateway-generated request ID. Gateway-to-extension `request`/`cancel` frames and extension-to-gateway `stream_delta`/`stream_done`/`stream_error` frames carry the same ID.
   - Rationale: allows multiple in-flight requests over one WebSocket and maps stream output back to the original HTTP/SSE response.
   - Alternative considered: one WebSocket per request. Rejected due to higher connection churn and less efficient health/registration management.

5. **Proxy-token auth is separate from CLI auth**
   - CLI requests continue using existing gateway auth. Extension WebSocket connections use scoped proxy tokens issued by an authenticated gateway endpoint and validated during WebSocket connection setup.
   - Rationale: Copilot auth is not exportable, and extension access needs a gateway-controlled credential with expiry and revocation potential.
   - Alternative considered: reuse the gateway auth token directly for WebSocket. Rejected because long-lived broad-scope credentials in extension settings increase blast radius.

6. **Dynamic extension-driven model registration**
   - The extension discovers available `vscode.lm` chat models, maps them to `copilot-*` gateway IDs, and registers them on connect and on availability changes.
   - Rationale: only VS Code can know which Copilot models are available for the signed-in user and subscription tier.
   - Alternative considered: static YAML configuration of Copilot models. Rejected because availability varies by user, tier, VS Code version, and Copilot state.

7. **Least-loaded routing for multiple extensions**
   - If multiple extension connections can serve a model, the gateway selects the least-loaded healthy connection.
   - Rationale: supports multiple VS Code instances without introducing complex scheduling.
   - Alternative considered: first-connected routing. Rejected because it can overload one extension while others are idle.

8. **No gateway retry after Copilot dispatch**
   - The gateway does not automatically retry Copilot requests that fail in `vscode.lm` or mid-stream.
   - Rationale: Copilot rate limits and retry semantics are opaque; automatic retries may amplify quota pressure or duplicate tool calls.
   - Alternative considered: retry on another connected extension. Rejected for the first implementation because user identity/quota and side-effect semantics are unclear.

9. **Shared package or shared module for protocol types**
   - Add shared TypeScript definitions for WebSocket messages, model metadata, stream deltas, errors, and token records.
   - Rationale: avoids duplicate protocol definitions between gateway and extension.
   - Alternative considered: copy types into both packages. Rejected due to protocol drift risk.

10. **Monorepo package layout evolves incrementally**
   - The current repository is a single root TypeScript package. This change should introduce `packages/shared` and `packages/vscode-extension` only when implementation begins, while preserving the gateway entrypoints and scripts.
   - Rationale: the extension has different build/distribution requirements from the gateway, and shared protocol types need independent consumption.
   - Alternative considered: put extension source under `src/extension`. Rejected because VS Code extension manifest/build/test tooling differs from the server package.

## Risks / Trade-offs

- **Copilot terms may prohibit this proxy use** → Treat legal approval as a blocking Phase 0 task; if not approved, abandon implementation.
- **`vscode.lm` API instability** → Gate extension behavior by VS Code engine/API availability, use narrow adapters, and surface unavailable status to the gateway.
- **VS Code runtime dependency** → Return 503 for `copilot-*` model requests when no capable extension is connected; clearly advertise availability through model discovery.
- **Copilot auth and model availability are user-scoped** → Never persist Copilot credentials; register models dynamically per extension connection.
- **Tool calls may not be supported by every Copilot model** → Extension reports capabilities per model; gateway rejects tool requests for models that do not advertise tool support.
- **Token usage may be unavailable or approximate** → Protocol allows usage frames but does not require exact counts; endpoint adapters use zero/unknown-safe defaults where current contracts require usage.
- **Concurrent request limits are unknown** → Track per-extension in-flight counts, route to least-loaded connections, and return 503/429-style endpoint-native errors when capacity is exhausted.
- **WebSocket disconnects can interrupt streams** → Gateway sends endpoint-native partial/error termination, cancels correlated in-flight requests, and removes disconnected models immediately.
- **New package layout increases build complexity** → Add workspace build ordering and keep shared package free of runtime dependencies.

## Migration Plan

1. Legal review is resolved as approved for this implementation.
2. Add shared protocol/types without changing runtime behavior.
3. Add gateway WebSocket server, proxy-token issuance, connection registry, and model registration behind disabled-by-default configuration.
4. Add gateway route selection for `copilot-*` models, returning 503 when the proxy feature is enabled but no capable extension is connected.
5. Add VS Code extension package and local development configuration.
6. Add integration tests using a mock extension and mock Copilot bridge before testing against real VS Code/Copilot.
7. Enable the feature in development only, then document operator setup and rollback.

Rollback is configuration-based: disable Copilot proxy routing and remove `copilot-*` registrations. Existing direct upstream models and endpoints remain unchanged.

## Open Questions

1. Which `vscode.lm` API surface and VS Code engine version will be required at implementation time?
2. Which Copilot models and capability metadata are observable through `vscode.lm` for Individual, Business, and Enterprise users?
3. Does `vscode.lm` expose tool-call streaming and token usage consistently enough to advertise those capabilities?
4. What capacity limit should be enforced per extension connection before returning overload errors or queueing requests?
5. Should proxy tokens be persisted across gateway restarts or held in memory for the first implementation?
