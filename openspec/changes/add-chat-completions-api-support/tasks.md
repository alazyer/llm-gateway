## 1. Route and Request Handling

- [ ] 1.1 Add `POST /v1/chat/completions` route registration in the existing routes module
- [ ] 1.2 Implement handler flow that parses request body and resolves configured model context
- [ ] 1.3 Reuse existing pre-dispatch capability checks (e.g., streaming/tool support) for chat completions requests

## 2. Upstream Dispatch and Response Path

- [ ] 2.1 Wire `/v1/chat/completions` handler to existing OpenAI SDK-backed transport for non-stream requests
- [ ] 2.2 Wire `/v1/chat/completions` handler to existing OpenAI SDK-backed streaming path for `stream=true`
- [ ] 2.3 Ensure response payload/stream frames are returned in OpenAI Chat Completions-compatible shape

## 3. Error Normalization and Safety

- [ ] 3.1 Extend endpoint-aware error mapping to include `/v1/chat/completions` transport failures
- [ ] 3.2 Add validation error mapping for invalid chat completions request payloads
- [ ] 3.3 Verify raw upstream error bodies are not logged or echoed for this endpoint

## 4. Tests and Documentation

- [ ] 4.1 Add server tests for `/v1/chat/completions` non-stream success path
- [ ] 4.2 Add server tests for `/v1/chat/completions` streaming success path
- [ ] 4.3 Add server tests for model-not-found, validation error, and upstream failure mapping cases
- [ ] 4.4 Update `README.md` endpoint documentation to include `POST /v1/chat/completions`
