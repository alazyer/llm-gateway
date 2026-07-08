## 1. Create error-senders module

- [ ] 1.1 Extract `RouteError` class to `src/routes/error-senders.ts`
- [ ] 1.2 Extract `sendError` function to `src/routes/error-senders.ts`
- [ ] 1.3 Extract `sendAnthropicError` function to `src/routes/error-senders.ts`
- [ ] 1.4 Extract `sendOpenAiError` function to `src/routes/error-senders.ts`
- [ ] 1.5 Add re-exports from `src/routes/responses.ts`

## 2. Create request-parsers module

- [ ] 2.1 Extract `parseResponseRequest` and its supporting predicates (`isResponseInput`, `isResponseInputItem`, `isResponseMessageItem`, `isResponsesTool`, `isTextContent`, `isResponseRole`, `hasUsableInput`, `hasUsableInputItemContent`, `hasUsableMessageContent`, `normalizeOptionalString`, `formatZodError`, `listUnknownResponsesTopLevelFields`, `responseRequestUsesTools`) to `src/routes/request-parsers.ts`
- [ ] 2.2 Extract `parseAnthropicMessagesRequest` and `anthropicRequestUsesTools` to `src/routes/request-parsers.ts`
- [ ] 2.3 Extract `parseChatCompletionsRequest` and `chatCompletionsRequestUsesTools` to `src/routes/request-parsers.ts`
- [ ] 2.4 Add re-exports from `src/routes/responses.ts`

## 3. Create model-records module

- [ ] 3.1 Extract `ModelRecord` and `AnthropicModelRecord` interfaces to `src/routes/model-records.ts`
- [ ] 3.2 Extract `createModelRecord`, `createCopilotModelRecord` to `src/routes/model-records.ts`
- [ ] 3.3 Extract `createModelsList`, `createAnthropicModelRecord`, `createCopilotAnthropicModelRecord`, `createAnthropicModelsList` to `src/routes/model-records.ts`
- [ ] 3.4 Extract `resolveModel` helper to `src/routes/model-records.ts`
- [ ] 3.5 Add re-exports from `src/routes/responses.ts`

## 4. Create copilot-proxy-adapter module

- [ ] 4.1 Extract `isCopilotModelName`, `resolveCopilotModel` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.2 Extract `mapCopilotUsage`, `mapChatMessageToCopilot`, `mapChatToolToCopilot`, `buildCopilotParams`, `buildCopilotRequest` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.3 Extract `applyToolCallDelta`, `buildToolCalls`, `routeErrorFromCopilotStreamError` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.4 Extract `collectCopilotChatCompletion` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.5 Extract `formatOpenAiSseData`, `createOpenAiCopilotChunk` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.6 Extract `streamCopilotOpenAiChatCompletion`, `streamCopilotAnthropicMessage`, `streamCopilotResponses` to `src/routes/copilot-proxy-adapter.ts`
- [ ] 4.7 Add re-exports from `src/routes/responses.ts`

## 5. Create stream-helpers module

- [ ] 5.1 Extract `translateStream`, `translateAnthropicStream` to `src/routes/stream-helpers.ts`
- [ ] 5.2 Extract `readableStreamToAsyncIterable`, `createDisconnectAbortSignal` to `src/routes/stream-helpers.ts`
- [ ] 5.3 Extract `buildTranslationOptions` to `src/routes/stream-helpers.ts`
- [ ] 5.4 Add re-exports from `src/routes/responses.ts`

## 6. Reduce responses.ts to thin orchestrator

- [ ] 6.1 Replace inline function bodies with imports from extracted modules
- [ ] 6.2 Remove all extracted function definitions from `responses.ts`
- [ ] 6.3 Keep route registration and handler functions in `responses.ts`
- [ ] 6.4 Add re-exports for all previously exported symbols

## 7. Verify

- [ ] 7.1 Run `npm run build` and confirm no compile errors
- [ ] 7.2 Run `npm test` and confirm all tests pass
- [ ] 7.3 Verify no logic changes — diff should contain only imports, exports, and function moves
