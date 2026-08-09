## 1. Gateway validation surface

- [x] 1.1 Add or confirm a browser-accessible Web AI Chat route in the web app and wire it through the existing auth middleware.
- [x] 1.2 Ensure gateway config exposes the feature as enabled by default in production, with an override path to disable it.
- [x] 1.3 Enforce the 120-second default validation timeout and keep request metadata aligned with existing tracing/logging behavior.
- [x] 1.4 Source selectable models from the existing gateway model registry so the UI reflects routable models only.

## 2. Validation-first chat UX

- [x] 2.1 Implement the header model picker, session model status labels, and model-switch divider behavior in the chat surface.
- [x] 2.2 Implement the validation flow for streaming and non-streaming models, including stop/cancel and retry-after-failure actions.
- [x] 2.3 Map auth, timeout, unavailable-model, rate-limit, and upstream failures into user-readable validation states with request IDs.
- [x] 2.4 Keep message rendering safe, accessible, and responsive with keyboard support, live-region announcements, and mobile-friendly layout.

## 3. Verification and regression coverage

- [x] 3.1 Add or update tests for auth enforcement, model discovery, and no-model/unavailable-model states.
- [x] 3.2 Add or update tests for successful validation, timeout/interruption, retry behavior, and model status transitions.
- [x] 3.3 Add or update tests for error classification, request-id propagation, and safe rendering of assistant output.
