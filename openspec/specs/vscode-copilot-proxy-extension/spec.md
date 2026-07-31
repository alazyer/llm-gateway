# vscode-copilot-proxy-extension Specification

## Purpose
Define VS Code extension behavior for connecting to the gateway, registering Copilot-backed models, and serving proxied requests.

## Requirements

### Requirement: VS Code extension SHALL manage Copilot proxy lifecycle
The VS Code extension SHALL activate, read configuration including model prefix, discover Copilot model availability, connect to the gateway, register models, and cleanly disconnect on deactivation.

#### Scenario: Extension activates with configured gateway and prefix
- **WHEN** the extension activates and has gateway URL, proxy token, and model prefix configuration
- **THEN** it SHALL attempt to connect to the gateway WebSocket endpoint and register models using the configured prefix

#### Scenario: Extension deactivates
- **WHEN** VS Code deactivates the extension
- **THEN** the extension SHALL send a clean disconnect notification when possible and close the WebSocket connection

#### Scenario: Missing configuration
- **WHEN** required gateway configuration is missing
- **THEN** the extension SHALL not attempt proxy traffic and SHALL report disconnected status in VS Code UI

### Requirement: VS Code extension SHALL discover Copilot chat models through `vscode.lm`
The extension SHALL use VS Code language model APIs to discover available Copilot chat models and map them to gateway model registrations using the configured prefix.

#### Scenario: Copilot models available with custom prefix
- **WHEN** `vscode.lm` returns one or more chat models and the extension is configured with prefix `alazyer-`
- **THEN** the extension SHALL register corresponding model identifiers with the `alazyer-` prefix (e.g., `alazyer-copilot-auto`)

#### Scenario: Copilot models available with default prefix
- **WHEN** `vscode.lm` returns one or more chat models and the extension has no custom prefix configured
- **THEN** the extension SHALL register corresponding model identifiers with the `copilot-` prefix (e.g., `copilot-gpt-4o`)

#### Scenario: Copilot unavailable
- **WHEN** `vscode.lm` is unavailable or returns no usable chat models
- **THEN** the extension SHALL report Copilot unavailable status and SHALL register no routable models

#### Scenario: Model availability changes
- **WHEN** the discovered Copilot model set changes during extension runtime
- **THEN** the extension SHALL send an updated registration or status update to the gateway using the configured prefix

### Requirement: VS Code extension SHALL execute gateway requests through Copilot
The extension SHALL translate gateway request frames into `vscode.lm` chat requests, execute them through Copilot, and stream results back through the gateway protocol.

#### Scenario: Text request succeeds
- **WHEN** the extension receives a valid gateway `request` frame for a supported model
- **THEN** it SHALL invoke the selected `vscode.lm` model and send text output as `stream_delta` frames

#### Scenario: Tool request supported
- **WHEN** the extension receives a gateway request with tools for a model that supports tools through `vscode.lm`
- **THEN** it SHALL translate supported tool definitions and stream tool-call deltas back to the gateway

#### Scenario: Tool request unsupported
- **WHEN** the extension receives a gateway request with tools for a model that does not support tools through `vscode.lm`
- **THEN** it SHALL return a `stream_error` for that request without invoking Copilot

### Requirement: VS Code extension SHALL adapt Copilot stream parts to gateway stream frames
The extension SHALL convert Copilot stream parts into gateway protocol frames that preserve text, tool-call, progress, usage, completion, and error semantics where available.

#### Scenario: Text stream part
- **WHEN** Copilot emits a text stream part
- **THEN** the extension SHALL send a `stream_delta` frame with `content_type: "text"`

#### Scenario: Tool call stream part
- **WHEN** Copilot emits a tool-call stream part
- **THEN** the extension SHALL send a `stream_delta` frame with `content_type: "tool_call"` if the gateway request advertised tool support

#### Scenario: Usage stream part
- **WHEN** Copilot emits token usage information
- **THEN** the extension SHALL send usage information in a `stream_delta` or `stream_done` frame according to the shared protocol

### Requirement: VS Code extension SHALL reconnect with bounded exponential backoff
The extension SHALL retry gateway WebSocket connections with exponential backoff capped at a configured maximum and SHALL re-register models after reconnecting using the configured prefix.

#### Scenario: Gateway temporarily unreachable
- **WHEN** the WebSocket connection attempt fails
- **THEN** the extension SHALL retry using exponential backoff with a maximum delay cap

#### Scenario: Reconnect succeeds
- **WHEN** the extension reconnects after a disconnect
- **THEN** it SHALL send a fresh registration with the configured prefix before accepting gateway requests

#### Scenario: Proxy token expired
- **WHEN** the gateway rejects the WebSocket connection because the proxy token expired
- **THEN** the extension SHALL obtain or prompt for a new proxy token before reconnecting

### Requirement: VS Code extension SHALL surface proxy status to the user
The extension SHALL show connection and Copilot availability status through VS Code UI affordances such as a status bar item and command output/logging.

#### Scenario: Connected and registered
- **WHEN** the extension is connected and has registered at least one Copilot model
- **THEN** the status UI SHALL indicate connected/available state

#### Scenario: Gateway disconnected
- **WHEN** the extension is not connected to the gateway
- **THEN** the status UI SHALL indicate disconnected or retrying state

#### Scenario: Copilot signed out
- **WHEN** Copilot is unavailable because the user is not signed in or the Copilot extension is disabled
- **THEN** the status UI SHALL indicate that Copilot models are unavailable

### Requirement: VS Code extension SHALL validate model prefix at startup
The extension SHALL validate that the configured `modelPrefix` matches the gateway's allowed prefixes. If the prefix is not allowed, the extension SHALL report a configuration error and SHALL NOT attempt to register models.

#### Scenario: Prefix matches allowed list
- **WHEN** the extension is configured with prefix `alazyer-` and the gateway's allowed prefixes include `alazyer-`
- **THEN** the extension SHALL proceed with model registration

#### Scenario: Prefix not in allowed list
- **WHEN** the extension is configured with prefix `team-x-` but the gateway rejects the registration because `team-x-` is not in the allowed prefixes list
- **THEN** the extension SHALL report a configuration error in VS Code UI and SHALL NOT register any models
