## Context

The llm-gateway supports three API surfaces, each with its own error response format: gateway-style (for `/responses`), Anthropic-style (for `/v1/messages`), and OpenAI-style (for `/v1/chat/completions`). Currently, each format has its own error sender function in `src/routes/responses.ts`. These functions share identical control flow but differ in the shape of the error body they produce.

Additionally, three `*RequestUsesTools` predicates check whether a parsed request includes tool usage. These share the same logic — check for non-empty `tools` array, then check `tool_choice` — but are typed for different request shapes.

## Goals / Non-Goals

**Goals:**
- Eliminate the three-way duplication of error sender functions
- Eliminate the three-way duplication of tools-detection predicates
- Preserve identical error response bodies for each format — this is a pure refactor
- Make the error handling easy to extend (e.g., adding a new error category or a new API surface)

**Non-Goals:**
- Changing error response formats or adding new error categories
- Changing the `RouteError` class or `UpstreamHttpError` handling
- Restructuring the translation layer or route handlers
- Deduplicating other shared patterns in `responses.ts` (those are covered by the `split-monolithic-responses` change)

## Decisions

### 1. Parameterized `sendRouteError` function

**Decision**: Replace `sendError`, `sendAnthropicError`, and `sendOpenAiError` with a single `sendRouteError(reply, error, log, format, requestId?)` function where `format` is `"gateway" | "anthropic" | "openai"`.

**Rationale**: The three functions have identical control flow — the only difference is the error body shape. A parameterized function eliminates the duplication while keeping the format-specific logic readable via a switch or lookup table.

**Implementation sketch**:
```
function sendRouteError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyReply["log"],
  format: "gateway" | "anthropic" | "openai",
  requestId?: string,
): FastifyReply {
  reply.type("application/json; charset=utf-8");

  if (error instanceof UpstreamHttpError) {
    // log + return format-specific upstream error body
  }

  if (error instanceof RouteError) {
    // log + return format-specific route error body
  }

  // log + return format-specific 500 error body
}
```

**Alternative considered**: Keep three functions but extract shared logic into a `classifyError` helper that returns a structured result (`{ statusCode, logLevel, message, details }`), then have each sender format it. Rejected — this creates an intermediate data structure that's just a different shape of the same information, adding complexity without reducing the total number of functions.

**Alternative considered**: Use a strategy pattern with `ErrorFormatter` objects. Rejected — over-engineered for three simple output formats.

### 2. Error body builders

**Decision**: Extract three small pure functions — `formatGatewayError`, `formatAnthropicError`, `formatOpenAiError` — that take classified error info and return the response body object. These are called by `sendRouteError` based on the format parameter.

**Rationale**: Separating the "what happened" logic (error classification) from the "how to format it" logic (body construction) makes both testable independently. The body builders are pure functions with no side effects, making them trivial to unit test.

**Alternative considered**: Inline the format logic in `sendRouteError` with a switch statement. Acceptable for a first pass, but the body builders are cleaner for testing and future extension.

### 3. Unified `requestUsesTools` predicate

**Decision**: Replace `responseRequestUsesTools`, `anthropicRequestUsesTools`, and `chatCompletionsRequestUsesTools` with a single `requestUsesTools(request: { tools?: unknown[]; tool_choice?: unknown })` function.

**Rationale**: All three predicates implement the same logic: check `tools` array is non-empty, then check `tool_choice` is not `"none"`. The type differences are superficial — `unknown[]` and `unknown` cover all three request types. The function can be overloaded or use a generic if stricter typing is desired later.

**Alternative considered**: Keep three predicates for type safety. Rejected — the predicates are simple enough that the type widening to `unknown` is safe, and the deduplication benefit outweighs the minor type precision loss.

### 4. Placement in error-senders.ts

**Decision**: If the `split-monolithic-responses` change has been applied, `RouteError` and the error senders already live in `src/routes/error-senders.ts`. This change modifies that module. If not yet applied, this change extracts them from `responses.ts` into `src/routes/error-senders.ts` as part of its implementation.

**Rationale**: The two changes are independent but complementary. If this change is implemented first, it creates `error-senders.ts` which the split change would later reference. If the split is implemented first, this change modifies the already-extracted module. Either ordering works.

## Risks / Trade-offs

- **Format-specific behavior must be preserved**: The three error formats have subtle differences (e.g., Anthropic wraps errors in `{ type: "error", error: { ... } }`, OpenAI uses `{ error: { message, type } }`). The unified function must produce byte-identical output. Mitigated by testing all three formats exhaustively.
- **Type widening in unified predicate**: Moving from `ResponsesTool[]` to `unknown[]` loses some compile-time safety. Mitigated by the predicate's simplicity — the only operations are `Array.isArray` and string equality checks.
- **Dependency on split change ordering**: If both changes are implemented in parallel, the `error-senders.ts` module could be created by either. The task list accounts for this by checking whether the module already exists.

## Open Questions

1. Should `sendRouteError` also accept a `requestId` parameter for inclusion in error response bodies? (Current functions log it but don't include it in the body. Recommended: keep current behavior, don't add to body.)
2. Should the error body builders be exported for direct unit testing, or kept as private implementation details of `sendRouteError`? (Recommended: export for testability.)
