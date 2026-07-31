## 1. Shared Protocol Types

- [ ] 1.1 Change `CopilotProxyModel.id` type from `` `copilot-${string}` `` to `string` in `packages/shared/src/protocol.ts`
- [ ] 1.2 Change `CopilotProxySource` type from `"copilot-proxy"` literal to `string` in `packages/shared/src/protocol.ts`
- [ ] 1.3 Update `packages/shared/src/protocol.typecheck.ts`:
  - Remove the stale `@ts-expect-error` on line 72 (the compile error it expects no longer exists once `CopilotProxyModel.id` and `CopilotProxyRequestMessage.model` change from `` `copilot-${string}` `` to `string`; keeping it causes a new compile error "Unused '@ts-expect-error' directive")
  - Update `validRegister.models[0].id` from `"copilot-gpt-4o"` to a generic prefixed model ID consistent with the new `string` type
  - Update `validRegister.models[0].source` from `"copilot-proxy"` to match the new generalized `source` value (the registering prefix, e.g., `"copilot-"`)
  - Update `validRequest.model` accordingly
  - Remove or replace the `invalidModelPrefix` test variable — with `model: string` the `"gpt-4o"` assignment is now valid at compile time; consider converting it to a runtime prefix-validation test or removing it
- [ ] 1.4 Rebuild `@llm-gateway/shared` package and verify no downstream compile errors

## 2. Gateway Configuration

- [ ] 2.1 Add `copilot_proxy_allowed_prefixes` field to the YAML schema in `src/config.ts` with Zod validation (array of strings, default `["copilot-"]`)
- [ ] 2.2 Add `allowedPrefixes: string[]` to `CopilotProxyConfig` interface in `src/config.ts`
- [ ] 2.3 Wire `allowedPrefixes` from YAML parsing into `AppConfig.copilotProxy` in `loadYamlConfig()`

## 3. Gateway Registry Validation

- [ ] 3.1 Replace hardcoded `copilot-` prefix check in `assertValidModel()` (`src/copilot-proxy/registry.ts`) with validation against the `allowedPrefixes` list
- [ ] 3.2 Set model `source` field to the matching prefix string instead of `"copilot-proxy"` in `replaceRegistration()`
- [ ] 3.3 Pass `allowedPrefixes` from `CopilotProxyConfig` through to the registry (constructor parameter or registration method parameter)

## 4. Gateway Route Handlers

- [ ] 4.1 Replace `isCopilotModelName()` in `src/routes/responses.ts` with `isProxiedModelName(model, allowedPrefixes)` that checks against all allowed prefixes
- [ ] 4.2 Thread `allowedPrefixes` from `AppConfig.copilotProxy` through `ResponsesRoutesOptions` to the route handlers
- [ ] 4.3 Update `createCopilotModelRecord()` and `createCopilotAnthropicModelRecord()` to use the model's `source` field instead of hardcoded `"copilot-proxy"`

## 5. Gateway Management Endpoint

- [ ] 5.1 Add `GET /api/channels` route in `src/app.ts` that returns active prefixes, extension counts, and model IDs per prefix
- [ ] 5.2 Add gateway auth requirement to the `/api/channels` endpoint
- [ ] 5.3 Add tests for `/api/channels` endpoint (authenticated success, 401 unauthenticated rejection, 403 when proxy disabled, 403 when gateway auth not configured, empty channels)

## 6. VS Code Extension Configuration

- [ ] 6.1 Add `modelPrefix` field to `ExtensionConfig` interface in `packages/vscode-extension/src/config.ts`
- [ ] 6.2 Add `llmGatewayCopilotProxy.modelPrefix` setting to `packages/vscode-extension/package.json` with default `"copilot-"` and validation pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]*-$`
- [ ] 6.3 Update `loadExtensionConfig()` to read the new setting
- [ ] 6.4 Update `isExtensionConfigComplete()` to accept any non-empty prefix

## 7. VS Code Extension Model Registration

- [ ] 7.1 Update `toGatewayModel()` in `packages/vscode-extension/src/model-registry.ts` to use `config.modelPrefix` instead of hardcoded `"copilot-"`
- [ ] 7.2 Thread `modelPrefix` config through to `CopilotBridge` and then to `toGatewayModel()`
- [ ] 7.3 Handle prefix rejection: if the gateway closes the WebSocket with code `1008` during registration, surface a configuration error in VS Code UI

## 8. Tests

- [ ] 8.1 Add unit tests for `assertValidModel` with multiple allowed prefixes and disallowed prefixes
- [ ] 8.2 Add unit tests for `isProxiedModelName` with multiple allowed prefixes
- [ ] 8.3 Add unit tests for `toGatewayModel` with custom prefix
- [ ] 8.4 Update existing copilot-proxy registration tests to use the default `["copilot-"]` allowlist
- [ ] 8.5 Add integration test: two extensions with different prefixes register distinct models
- [ ] 8.6 Add integration test: extension with disallowed prefix gets connection rejected
