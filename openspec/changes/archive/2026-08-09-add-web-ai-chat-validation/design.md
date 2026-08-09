## Context

llm-gateway already exposes model discovery and chat-style inference endpoints. Operators need a fast visual way to validate whether configured models are usable now, without building raw API payloads manually. This change defines a gateway-hosted Web AI Chat workflow specifically for rapid availability validation, not a full conversation platform.

## Goals / Non-Goals

**Goals:**
- Provide a first-party web UI for quick, authenticated model checks.
- Reuse existing gateway model registry and chat-completions-compatible inference behavior.
- Make failure modes explicit so users can quickly diagnose unavailable models.
- Define concrete security, latency, and observability constraints for the feature.

**Non-Goals:**
- Long-lived chat history, team collaboration, or knowledge management features.
- New model lifecycle/configuration management workflows.
- Custom auth system separate from existing gateway authentication.

## Decisions

1. **Thin UI over existing gateway APIs**
   - Web AI Chat is a lightweight interface layered over existing model list and inference contracts.
   - Rationale: avoids endpoint proliferation and keeps model-routing logic in one place.

2. **Validation-first interaction model**
   - UX emphasizes fast “model works / model fails” outcomes with concise diagnostics.
   - Rationale: issue scope is operational validation, not rich conversation experience.

3. **Strict same-policy auth boundary**
   - Web AI Chat follows existing incoming auth requirements and request validation rules.
   - Rationale: prevents a weaker browser-specific access path.

4. **No browser persistence of sensitive auth material**
   - Tokens/secrets used for requests must stay in process memory only and be cleared on refresh/close.
   - Rationale: reduces credential leakage risk from local storage.

5. **Observability uses metadata, not prompt/response payload by default**
   - Request IDs, model ID, status, and latency are logged/metriced; full prompt/response content is excluded by default.
   - Rationale: preserve debuggability while minimizing sensitive content exposure.

6. **Default rollout posture**
   - Web AI Chat is enabled by default in production deployments.
   - Rationale: this capability is intended as a standard operator validation path rather than an opt-in experimental surface.

7. **Default validation timeout**
   - The initial default validation timeout is 120 seconds.
   - Rationale: enterprise backends can have higher cold-start or queue latency; a 120-second default reduces false negatives during readiness checks.

## Architecture

1. Browser loads the Web AI Chat page from the gateway.
2. UI requests available models from existing gateway model discovery endpoint.
3. User selects a model and submits a short validation prompt.
4. UI sends chat request to existing gateway inference endpoint.
5. UI maps outcome into validation status:
   - success: valid response/stream completed
   - failure: auth error, model unavailable, validation error, upstream failure/timeout
6. Gateway logs request metadata with request ID and latency for traceability.

## Integrated UX Direction (from COM-251)

1. **Single-page, three-zone layout**
   - Header (model picker + model status), message area, and fixed input bar.
   - Rationale: supports the primary validation flow with minimal navigation overhead.

2. **Header-embedded model picker**
   - Model picker stays visible in the header and supports low-friction switching.
   - The selected model updates immediately, and conversation history is retained with a visible "model switched" divider.
   - Rationale: enables quick cross-model checks without losing validation context.

3. **Stream-first interaction**
   - Validation requests use streaming chat behavior as the primary mode.
   - UI shows pending/typing state, progressively renders output, and supports explicit stop/cancel during generation.
   - Rationale: first-token arrival is itself a strong model-availability signal.

4. **Session-scoped model usability cues**
   - Each model has an untested/available/unavailable session status indicator visible near the selected model.
   - Successful responses move model state to available; failed attempts move it to unavailable until next success.
   - Rationale: operators should be able to scan model readiness without reading full transcripts.

5. **Error diagnostics as user-readable guidance**
   - UI maps common failure classes (auth, timeout/network, provider unavailable, model not found, rate limit) to concise diagnostic language plus request ID.
   - Rationale: the feature is operational validation, so actionable error framing is required.

6. **Accessibility and responsive baseline**
   - Keyboard-first operation, live-region announcements for streaming/error updates, and non-color-only status signaling are required.
   - Mobile behavior prioritizes touch-friendly model selection and full-width chat readability.
   - Rationale: validation tooling must be operable and interpretable across device and accessibility contexts.

## Error Handling

- **Auth failures**: shown as explicit unauthorized/forbidden validation failure.
- **Model unavailable**: shown as unavailable/not-registered failure.
- **Request validation errors**: shown as input-invalid failure with actionable summary.
- **Upstream/service failures**: shown as temporary failure with request ID for debugging.
- **Interrupted stream**: shown as incomplete validation result, not silent success.

## Non-Functional Constraints

- **Security**:
  - MUST enforce existing gateway auth and input validation on all chat requests.
  - MUST NOT persist credentials in browser storage by default.
  - MUST escape/render model output safely to prevent script injection in the chat UI.
- **Latency**:
  - SHOULD surface first response token (or first response body for non-stream) within 8 seconds for healthy models under normal load.
  - MUST use a 120-second default validation timeout unless explicitly overridden by operator configuration.
  - MUST display a visible timeout/failure state if validation exceeds configured timeout.
- **Observability boundaries**:
  - MUST emit request ID, selected model ID, final status, and latency metrics.
  - MUST NOT log full prompt/response content by default.
  - MUST return user-visible request ID/error correlation for failed validations.
  - SHOULD capture model-switch and model-status transitions as metadata events without logging prompt/response bodies.

## Risks / Trade-offs

- Browser UX may imply “product chat” expectations; mitigated by explicit validation-oriented labeling.
- Different models vary in latency/stream semantics; mitigated by status normalization and timeout handling.
- Reusing existing endpoints limits UI-specific control knobs; accepted to keep backend behavior consistent.

## Open Questions

None at this stage.
