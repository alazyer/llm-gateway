## ADDED Requirements

### Requirement: Gateway SHALL expose a Web AI Chat validation surface

The gateway SHALL provide an authenticated browser-accessible Web AI Chat surface intended for operational model validation.

#### Scenario: Production default enablement
- **WHEN** the gateway runs in production with no explicit Web AI Chat disable override
- **THEN** the Web AI Chat validation surface SHALL be enabled by default

#### Scenario: Authorized user opens Web AI Chat
- **WHEN** an authenticated user requests the Web AI Chat page
- **THEN** the gateway SHALL return the Web AI Chat UI

#### Scenario: Unauthorized access is rejected
- **WHEN** an unauthenticated or unauthorized user requests the Web AI Chat page or chat actions
- **THEN** the gateway SHALL reject the request using existing auth policy behavior

### Requirement: Web AI Chat SHALL source selectable models from existing gateway model definitions

Web AI Chat SHALL fetch model options from the gateway's existing model discovery outputs and SHALL NOT rely on a separate static UI model list.

#### Scenario: Model list loads successfully
- **WHEN** Web AI Chat loads and model discovery succeeds
- **THEN** the UI SHALL present discovered models for selection

#### Scenario: No models are available
- **WHEN** model discovery returns zero routable models
- **THEN** the UI SHALL show a no-models-available state and SHALL prevent sending validation prompts

#### Scenario: Model becomes unavailable before send
- **WHEN** a previously shown model is no longer routable at send time
- **THEN** the validation attempt SHALL fail with an unavailable-model result

#### Scenario: Model switch preserves validation context
- **WHEN** the user switches from one selected model to another
- **THEN** the active model label SHALL update immediately
- **AND** prior conversation messages SHALL remain visible
- **AND** the UI SHALL show a visible model-switch marker before subsequent messages

### Requirement: Web AI Chat SHALL execute validation prompts through existing gateway chat inference behavior

When a user submits a validation message, Web AI Chat SHALL invoke existing gateway chat-inference-compatible behavior using the selected model and SHALL preserve endpoint-compatible success/error semantics.

#### Scenario: Validation succeeds
- **WHEN** a user submits a valid prompt for a healthy model
- **THEN** Web AI Chat SHALL show a success result with returned model output

#### Scenario: Request validation fails
- **WHEN** a user submits an invalid request payload
- **THEN** Web AI Chat SHALL show a failed validation result with an input-error classification

#### Scenario: Upstream failure occurs
- **WHEN** inference fails because of upstream/provider failure
- **THEN** Web AI Chat SHALL show a failed validation result with service-failure classification and request correlation ID

### Requirement: Web AI Chat SHALL provide explicit quick-validation outcome states

Web AI Chat SHALL normalize request outcomes into clear validation states so users can quickly distinguish usable versus unusable models.

#### Scenario: Successful completion state
- **WHEN** the model response completes successfully
- **THEN** the UI SHALL mark the model check as success

#### Scenario: Timeout or interruption state
- **WHEN** response streaming/body does not complete before timeout or stream interruption
- **THEN** the UI SHALL mark the model check as failed and SHALL indicate timeout/interrupted classification

#### Scenario: Auth failure state
- **WHEN** inference request fails with authorization/authentication error
- **THEN** the UI SHALL mark the model check as failed and SHALL indicate auth-failure classification

#### Scenario: Unavailable model state
- **WHEN** inference request fails because selected model is not available/routable
- **THEN** the UI SHALL mark the model check as failed and SHALL indicate model-unavailable classification

#### Scenario: Session model-status indicator updates on result
- **WHEN** a selected model returns a successful response
- **THEN** the model status indicator SHALL move to "available" for that model in the current session

#### Scenario: Session model-status indicator marks failure
- **WHEN** a selected model validation attempt fails
- **THEN** the model status indicator SHALL move to "unavailable" for that model in the current session

#### Scenario: Untested model status is distinguishable
- **WHEN** a model has not yet been used in the current session
- **THEN** the UI SHALL present a distinct "untested" state for that model

### Requirement: Web AI Chat SHALL provide validation-oriented interaction states

Web AI Chat SHALL present clear UI behavior for idle, pending/streaming, success, and failure phases of a validation flow.

#### Scenario: Idle state guidance
- **WHEN** no conversation has started
- **THEN** the UI SHALL present guidance to select a model and send a validation message

#### Scenario: Streaming pending state
- **WHEN** a validation request is in progress
- **THEN** the UI SHALL display an in-progress assistant state and incremental response rendering
- **AND** the UI SHALL provide a user control to stop/cancel the in-flight response

#### Scenario: Failure state offers immediate recovery
- **WHEN** a validation request fails
- **THEN** the UI SHALL provide a retry path without requiring a full page reload

### Requirement: Web AI Chat SHALL satisfy security constraints for browser-based validation

Web AI Chat SHALL enforce existing gateway security controls and SHALL avoid unsafe handling of user input and model output.

#### Scenario: Existing auth policy is enforced
- **WHEN** Web AI Chat requests are processed
- **THEN** the gateway SHALL apply existing incoming auth and request validation controls

#### Scenario: Sensitive credentials are not persisted
- **WHEN** a user provides auth material for validation requests
- **THEN** Web AI Chat SHALL keep it in runtime memory only and SHALL NOT store it in browser persistent storage by default

#### Scenario: Model output is rendered safely
- **WHEN** model output includes markup-like or script-like content
- **THEN** Web AI Chat SHALL render escaped/safe content and SHALL NOT execute embedded scripts

### Requirement: Web AI Chat SHALL satisfy accessibility and responsive UX baselines

Web AI Chat SHALL be operable with keyboard and assistive technologies and SHALL remain usable across desktop and mobile viewport sizes.

#### Scenario: Keyboard-first model validation flow
- **WHEN** a keyboard-only user interacts with Web AI Chat
- **THEN** model selection, message entry, send, and stop/cancel actions SHALL be reachable and operable via keyboard

#### Scenario: Assistive announcement for streaming and errors
- **WHEN** streaming response updates or validation errors occur
- **THEN** the UI SHALL expose assistive announcements suitable for screen-reader users

#### Scenario: Non-color-only model status semantics
- **WHEN** model availability status is shown
- **THEN** the status SHALL include non-color cues so untested/available/unavailable states are distinguishable without relying on color alone

#### Scenario: Mobile model selection usability
- **WHEN** Web AI Chat is used on narrow/mobile viewports
- **THEN** model selection and message interaction SHALL remain touch-usable without horizontal layout breakage

### Requirement: Web AI Chat SHALL satisfy latency and observability boundaries

Web AI Chat SHALL expose operationally useful timing/status signals without logging sensitive prompt/response content by default.

#### Scenario: Healthy-model responsiveness
- **WHEN** a healthy model validation request is processed under normal load
- **THEN** the system SHALL target first response token/body visibility within 8 seconds

#### Scenario: Timeout visibility
- **WHEN** validation exceeds configured timeout
- **THEN** the UI SHALL present explicit timeout failure and request correlation ID

#### Scenario: Default timeout configuration
- **WHEN** no explicit validation-timeout override is configured
- **THEN** the system SHALL apply a default validation timeout of 120 seconds

#### Scenario: Request metadata observability
- **WHEN** a validation request completes (success or failure)
- **THEN** the gateway SHALL emit request ID, model ID, final status, and latency metrics/log fields

#### Scenario: Prompt/response privacy by default
- **WHEN** request observability data is recorded
- **THEN** prompt and response bodies SHALL be excluded from default logs
