## ADDED Requirements

### Requirement: Gateway SHALL maintain dynamic Copilot model registrations per extension connection
The gateway SHALL maintain Copilot model registrations reported by connected VS Code extensions and associate each registered model with the connection that reported it.

#### Scenario: Model registration creates registry entry
- **WHEN** an extension registers model `copilot-gpt-4o`
- **THEN** the gateway SHALL add a registry entry for `copilot-gpt-4o` associated with that extension connection

#### Scenario: Re-registration replaces connection models
- **WHEN** an extension sends a new valid registration after a prior registration
- **THEN** the gateway SHALL replace that connection's previous Copilot model set with the new model set

#### Scenario: Disconnect removes connection models
- **WHEN** an extension WebSocket disconnects
- **THEN** the gateway SHALL immediately remove all Copilot model registry entries associated with that connection

### Requirement: Copilot model names SHALL use the `copilot-` prefix
The gateway SHALL expose Copilot-backed models with a `copilot-` prefix and SHALL NOT use unprefixed native Copilot model identifiers as public gateway model names.

#### Scenario: Native model mapped to gateway model
- **WHEN** an extension discovers native Copilot model `gpt-4o`
- **THEN** it SHALL register the public gateway model identifier `copilot-gpt-4o`

#### Scenario: Prefix avoids direct model collision
- **WHEN** the gateway has a direct configured model named `gpt-4o` and a Copilot-backed model for native `gpt-4o`
- **THEN** `/v1/models` SHALL expose them as distinct model identifiers `gpt-4o` and `copilot-gpt-4o`

### Requirement: Model discovery endpoints SHALL include available Copilot models
The gateway SHALL include currently available Copilot-backed models in model discovery endpoint responses when at least one healthy extension has registered those models.

#### Scenario: OpenAI-compatible model list includes Copilot model
- **WHEN** a healthy extension has registered `copilot-gpt-4o`
- **THEN** `GET /v1/models` SHALL include a model record for `copilot-gpt-4o`

#### Scenario: Root model list includes Copilot source
- **WHEN** a healthy extension has registered a Copilot model
- **THEN** `GET /models` SHALL include that model with source metadata identifying `copilot-proxy`

#### Scenario: Disconnected extension model disappears
- **WHEN** an extension that registered `copilot-gpt-4o` disconnects and no other extension registered the same model
- **THEN** `GET /v1/models` SHALL no longer include `copilot-gpt-4o`

### Requirement: Model capability metadata SHALL reflect extension-reported Copilot capabilities
The gateway SHALL store and expose capability metadata reported by the extension for each Copilot model, including streaming and tool support where known.

#### Scenario: Tool support advertised
- **WHEN** an extension registers a Copilot model with `supports_tools: true`
- **THEN** the gateway SHALL allow tool-bearing requests for that model subject to endpoint validation

#### Scenario: Tool support unavailable
- **WHEN** an extension registers a Copilot model with `supports_tools: false`
- **THEN** the gateway SHALL reject tool-bearing requests for that model before dispatching to the extension

#### Scenario: Responses API support advertised
- **WHEN** a healthy extension has registered a Copilot model
- **THEN** OpenAI-compatible model metadata for that model SHALL advertise `supports_responses_api: true`

#### Scenario: Unknown capability uses safe default
- **WHEN** an extension cannot determine whether a model supports a capability
- **THEN** the gateway SHALL treat that capability as unavailable unless the protocol explicitly marks it supported
