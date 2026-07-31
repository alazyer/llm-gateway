## MODIFIED Requirements

### Requirement: Copilot model names SHALL use an operator-allowed prefix
The gateway SHALL expose Copilot-backed models with an allowed prefix from the `copilot_proxy_allowed_prefixes` configuration and SHALL NOT use unprefixed native Copilot model identifiers as public gateway model names. The default allowed prefix list is `["copilot-"]`.

#### Scenario: Native model mapped to gateway model with default prefix
- **WHEN** an extension discovers native Copilot model `gpt-4o` and the allowed prefixes list is `["copilot-"]` (default)
- **THEN** it SHALL register the public gateway model identifier `copilot-gpt-4o`

#### Scenario: Native model mapped to gateway model with custom prefix
- **WHEN** an extension discovers native Copilot model `copilot-auto` and the extension is configured with prefix `alazyer-`
- **THEN** it SHALL register the public gateway model identifier `alazyer-copilot-auto`

#### Scenario: Prefix avoids direct model collision
- **WHEN** the gateway has a direct configured model named `gpt-4o` and a Copilot-backed model for native `gpt-4o` registered with prefix `copilot-`
- **THEN** `/v1/models` SHALL expose them as distinct model identifiers `gpt-4o` and `copilot-gpt-4o`

#### Scenario: Multiple extensions register same model under different prefixes
- **WHEN** one extension registers `alazyer-copilot-auto` and another registers `team-b-copilot-auto`
- **THEN** `/v1/models` SHALL expose both `alazyer-copilot-auto` and `team-b-copilot-auto` as separate model entries

### Requirement: Gateway SHALL maintain dynamic Copilot model registrations per extension connection
The gateway SHALL maintain Copilot model registrations reported by connected VS Code extensions and associate each registered model with the connection that reported it.

#### Scenario: Model registration creates registry entry
- **WHEN** an extension registers model `alazyer-copilot-auto`
- **THEN** the gateway SHALL add a registry entry for `alazyer-copilot-auto` associated with that extension connection

#### Scenario: Re-registration replaces connection models
- **WHEN** an extension sends a new valid registration after a prior registration
- **THEN** the gateway SHALL replace that connection's previous model set with the new model set

#### Scenario: Disconnect removes connection models
- **WHEN** an extension WebSocket disconnects
- **THEN** the gateway SHALL immediately remove all model registry entries associated with that connection

### Requirement: Model discovery endpoints SHALL include available Copilot models
The gateway SHALL include currently available Copilot-backed models in model discovery endpoint responses when at least one healthy extension has registered those models.

#### Scenario: OpenAI-compatible model list includes Copilot model
- **WHEN** a healthy extension has registered `alazyer-copilot-auto`
- **THEN** `GET /v1/models` SHALL include a model record for `alazyer-copilot-auto`

#### Scenario: Root model list includes source metadata
- **WHEN** a healthy extension has registered a Copilot model with prefix `alazyer-`
- **THEN** `GET /models` SHALL include that model with `source` metadata identifying `alazyer-`

#### Scenario: Disconnected extension model disappears
- **WHEN** an extension that registered `alazyer-copilot-auto` disconnects and no other extension registered the same model
- **THEN** `GET /v1/models` SHALL no longer include `alazyer-copilot-auto`

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
