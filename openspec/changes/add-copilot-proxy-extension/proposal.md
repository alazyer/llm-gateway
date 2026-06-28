## Why

CLI tools already use llm-gateway as a single OpenAI/Anthropic-compatible access point, but Copilot subscription models are only reachable inside VS Code through `vscode.lm`. This change introduces a supported gateway-side proxy path where a VS Code extension connects outward to the gateway, invokes Copilot through VS Code, and streams results back to existing CLI clients without requiring those clients to know about VS Code.

Implementation is gated by legal approval because proxying Copilot responses to external tools may be restricted by GitHub Copilot terms.

## What Changes

- Add a Copilot proxy integration that routes `copilot-*` model requests from existing `/responses`, `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` endpoints through a connected VS Code extension instead of a direct upstream provider.
- Add a gateway WebSocket endpoint for extension connections, registration, keepalive, request dispatch, cancellation, and streaming response frames.
- Add proxy-token authentication for extension-to-gateway WebSocket connections, separate from the existing CLI-to-gateway auth path.
- Add dynamic Copilot model registration so `/models` and `/v1/models` can advertise available proxied models with a `copilot-` prefix and remove them when the extension disconnects.
- Add a VS Code extension package that discovers Copilot models with `vscode.lm`, maintains the WebSocket connection, executes gateway requests through Copilot, adapts streaming output, and reports health/status.
- Add shared protocol/types used by both the gateway and extension to prevent WebSocket message drift.
- Add failure handling for missing extensions, Copilot sign-out, token expiry, stream interruption, cancellation, and multi-extension routing.

## Capabilities

### New Capabilities

- `copilot-proxy-routing`: Gateway routing of `copilot-*` Responses, chat, and messages requests to connected VS Code extension instances.
- `copilot-proxy-websocket-protocol`: Authenticated WebSocket protocol for extension registration, request dispatch, cancellation, keepalive, and streaming responses.
- `copilot-model-registry`: Dynamic registration and discovery of Copilot-backed models in gateway model endpoints.
- `vscode-copilot-proxy-extension`: VS Code extension lifecycle, configuration, status, Copilot model discovery, request execution, and stream adaptation.

### Modified Capabilities

- `incoming-auth`: Add scoped proxy-token issuance and validation for extension WebSocket connections while preserving existing CLI request auth semantics.
- `responses-api`: `/responses` and `/v1/responses` requests using `copilot-*` models are served by the Copilot proxy path and preserve Responses-compatible JSON/SSE output.
- `chat-completions-client-api`: Requests using `copilot-*` models are served by the Copilot proxy path and return 503 when no capable extension is connected.
- `anthropic-sdk-boundary-contract`: `/v1/messages` requests using `copilot-*` models are served by the Copilot proxy path and preserve Anthropic-compatible streaming/error output.

## Impact

- **Code**: gateway routing, model discovery, auth/token handling, WebSocket server, stream adapters, cancellation handling, and tests; new VS Code extension package; new shared protocol package or module.
- **APIs**: Existing CLI endpoints remain unchanged; new `GET/POST` proxy-token API for extensions; new `/ws/copilot-proxy` WebSocket endpoint; `/models` and `/v1/models` may include `source: "copilot-proxy"` records when extensions are connected.
- **Dependencies**: Gateway adds WebSocket support; extension adds VS Code extension tooling and a WebSocket client dependency if the VS Code runtime does not provide one suitable for Node extension hosts.
- **Config**: Gateway proxy-token settings, WebSocket heartbeat/timeouts, and optional Copilot proxy enablement; extension gateway URL/token settings.
- **Systems**: Requires VS Code running with GitHub Copilot installed and signed in; Copilot model availability and limits are discovered dynamically through `vscode.lm`.
