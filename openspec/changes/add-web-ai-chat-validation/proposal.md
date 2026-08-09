## Why

Operators can verify gateway APIs with curl, but this is slow for model-by-model checks and hard for non-CLI workflows. A built-in Web AI Chat surface gives a fast, low-friction way to confirm whether configured models are currently usable.

## What Changes

- Add a browser-accessible Web AI Chat entrypoint hosted by the gateway for quick model validation.
- Add a model selection flow that reads from models already exposed by the gateway model registry.
- Add validation-focused success/failure behavior so users can quickly distinguish reachable/working models from unavailable/misconfigured ones.
- Incorporate COM-251 UI/UX guidance for chat layout, model-switch behavior, streaming/error states, usability status cues, accessibility, and responsive behavior.
- Define non-functional constraints for security, latency expectations, and observability boundaries.

## Capabilities

### New Capabilities

- `web-ai-chat-validation`: A gateway-hosted chat UI for lightweight model availability checks.

### Modified Capabilities

- `chat-completions-client-api`: Web AI Chat uses existing chat-completions-compatible gateway behavior as its inference backend contract.
- `incoming-auth`: Web AI Chat applies existing gateway authentication requirements and does not introduce weaker auth paths.
- `request-tracing`: Web AI Chat requests participate in standard request IDs and trace/log context.

## Impact

- **Code**: Adds a UI delivery path and request handling for chat-validation UX while reusing existing model routing and inference flows.
- **APIs**: No mandatory new public model or inference contract; Web AI Chat relies on existing gateway model and chat endpoints.
- **Config**: Web AI Chat is enabled by default in production; operators MAY explicitly disable it via configuration override when needed.
- **UX Contract**: Aligns with COM-251 design direction (single-page chat layout, header model picker, stream-first interaction, and explicit model-availability cues).
- **Security**: No persistence of model provider secrets in browser storage; no bypass of existing auth policies.
- **Operations**: Provides a first-party smoke-test path for model readiness without introducing a full conversational product surface.

## Non-Goals

- Building a full chat product with persistent conversations, file attachments, or tool orchestration workflows.
- Replacing existing API endpoints or CLI validation scripts.
- Creating tenant-specific RBAC beyond current gateway auth policy.
