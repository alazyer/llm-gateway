## 1. Create unified error sender

- [ ] 1.1 Create `src/routes/error-senders.ts` (if it doesn't already exist from the split change)
- [ ] 1.2 Implement `sendRouteError(reply, error, log, format, requestId?)` with format parameter
- [ ] 1.3 Implement `formatGatewayError(statusCode, message, details?)` pure function
- [ ] 1.4 Implement `formatAnthropicError(statusCode, message)` pure function
- [ ] 1.5 Implement `formatOpenAiError(statusCode, message)` pure function
- [ ] 1.6 Ensure `RouteError` class is exported from the same module
- [ ] 1.7 Add unit tests for each format: upstream error, route error (< 500), route error (>= 500), unknown error
- [ ] 1.8 Add unit tests for each body builder pure function

## 2. Create unified tools predicate

- [ ] 2.1 Implement `requestUsesTools(request: { tools?: unknown[]; tool_choice?: unknown }): boolean`
- [ ] 2.2 Add unit tests: non-empty tools, empty tools, tool_choice "auto", tool_choice "none", tool_choice object, neither present

## 3. Replace usages in responses.ts

- [ ] 3.1 Replace `sendError` calls with `sendRouteError(..., "gateway", ...)`
- [ ] 3.2 Replace `sendAnthropicError` calls with `sendRouteError(..., "anthropic", ...)`
- [ ] 3.3 Replace `sendOpenAiError` calls with `sendRouteError(..., "openai", ...)`
- [ ] 3.4 Replace `responseRequestUsesTools` with `requestUsesTools`
- [ ] 3.5 Replace `anthropicRequestUsesTools` with `requestUsesTools`
- [ ] 3.6 Replace `chatCompletionsRequestUsesTools` with `requestUsesTools`
- [ ] 3.7 Remove the three old error sender function definitions
- [ ] 3.8 Remove the three old tools predicate function definitions
- [ ] 3.9 Add re-exports from `responses.ts` for backward compatibility

## 4. Verify

- [ ] 4.1 Run `npm run build` and confirm no compile errors
- [ ] 4.2 Run `npm test` and confirm all existing tests pass
- [ ] 4.3 Verify no logic changes — diff should show only function consolidation and import updates
