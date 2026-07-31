# llm-gateway

`llm-gateway` is a Fastify gateway that lets clients call `/responses`-style, OpenAI `/v1/chat/completions`, or Anthropic `/v1/messages` APIs while the upstream model provider only supports `/chat/completions`.

## What it does

- Accepts `POST /responses` and `POST /v1/responses`
- Accepts `POST /v1/chat/completions` for OpenAI-compatible clients
- Accepts `POST /v1/messages` for Anthropic-compatible clients such as Claude Code
- Exposes `GET /models`, `GET /v1/models`, and per-model detail endpoints for metadata discovery
- Translates `/responses` input into `/chat/completions` messages
- Translates Anthropic `/v1/messages` requests into `/chat/completions`, including tool definitions and tool result messages
- Proxies requests to the configured upstream provider
- Translates both JSON and streaming SSE output back into a practical `/responses` shape
- Translates Anthropic JSON and streaming message responses back into Claude-compatible message/event shapes
- Exposes `GET /healthz` for basic runtime checks
- Advertises compatibility metadata such as `personality`, `model_messages`, and `base_instructions` on model records

## Configuration

The gateway uses a YAML model catalog as the only model-configuration path.

Copy `.env.example` to `.env`, copy `gateway.config.example.yaml` to `gateway.config.yaml`, then set:

- `HOST` - bind host, defaults to `0.0.0.0`
- `PORT` - bind port, defaults to `3000`
- `LOG_LEVEL` - Fastify/Pino log level, one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`
- `GATEWAY_CONFIG_PATH` - path to your YAML model catalog
- provider secret env vars referenced by `api_key_env` in the YAML file

Keep actual secrets in your shell or `.env`, not in tracked YAML files. The recommended `gateway.config.yaml` file is local-only and gitignored.

Each YAML entry supports:

- `name` - public model name exposed by `/v1/models`
- `upstream_model` - optional upstream model name to send to `/chat/completions`
- `base_url` - upstream provider base URL
- `api_key_env` - environment variable name holding the secret
- `owned_by` - owner string returned in model discovery
- `supports_tools` - optional, defaults to `true`; reject tool requests when `false`
- `supports_streaming` - optional, defaults to `true`; reject streaming requests when `false`
- `unknown_field_mode` - optional, one of `warn` or `enforce` (defaults to `warn`) for `/responses` top-level unknown fields

The gateway uses `default_model` when a request omits `model`.

### Unknown `/responses` top-level fields

Unknown top-level keys in `/responses` requests are handled per model using `unknown_field_mode`:

- `warn` (default): ignore unknown keys, continue request processing, and log field names + count only.
- `enforce`: reject with HTTP `400` and body:

```json
{
  "error": "Unknown /responses fields.",
  "unknown_fields": ["<field_name>"]
}
```

No raw field values are logged in either mode.

### Promotion gate: `warn` → `enforce`

Before promoting a model to `unknown_field_mode: enforce`, require all of:

- `/responses` regression tests pass (stream + non-stream)
- `/v1/messages` regression tests pass (stream + non-stream)
- Claude runtime compatibility tests pass
- Soak gate: zero unknown-field warnings for 3 days with at least 300 requests for that model

### Operator runbook: promote model to `enforce`

1. Keep model in `warn` and monitor unknown-field warning logs.
2. Confirm warning count is zero over the 3-day soak window with at least 300 requests.
3. Run regression tests and Claude compatibility tests.
4. Update the model entry in `gateway.config.yaml` to `unknown_field_mode: enforce`.
5. Roll out and watch logs/metrics for new 400 responses carrying `unknown_fields`.

## Run it

```bash
cp .env.example .env
cp gateway.config.example.yaml gateway.config.yaml
npm install
npm run dev
```

Build and run the compiled server:

```bash
npm run build
npm start
```

## Health check

```bash
curl http://localhost:3000/healthz
```

## Logging

The gateway logs:

- incoming HTTP requests through Fastify
- `/responses` routing decisions such as selected public/upstream model
- upstream `/chat/completions` calls, failures, and status codes
- model discovery requests
- common auth headers and `apiKey` fields are redacted from logs

Suggested levels:

- `info` - normal operations and upstream calls
- `debug` - include routing and model-discovery detail
- `warn` - only warnings and errors
- `silent` - disable logs

Example response:

```json
{
  "ok": true
}
```

## Model discovery

```bash
curl http://localhost:3000/v1/models
curl http://localhost:3000/v1/models/glm-5.1
```

When a request includes the `anthropic-version` header, `/v1/models` and `/v1/models/:id` return Anthropic-style model records instead of the OpenAI-compatible shape.

Example list response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "glm-5.1",
      "object": "model",
      "created": 1718000000,
      "owned_by": "zhipu",
      "permission": [],
      "root": "glm-5.1",
      "parent": null
    }
  ]
}
```

## Example JSON request

```bash
curl http://localhost:3000/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model": "glm-5.1",
    "instructions": "Reply in one sentence.",
    "input": "Explain what this gateway does."
  }'
```

## Example Chat Completions request

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "glm-5.1",
    "messages": [
      { "role": "user", "content": "Say hello." }
    ]
  }'
```

## Example streaming request

```bash
curl http://localhost:3000/responses \
  -H 'content-type: application/json' \
  -N \
  -d '{
    "model": "glm-5.1",
    "input": "Say hello in two short chunks.",
    "stream": true
  }'
```

## Stream events

The gateway emits these event names for streaming calls:

- `response.created`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`

## Claude Code

Claude Code can target the gateway through `ANTHROPIC_BASE_URL` as long as the YAML catalog exposes a Claude-facing public model name such as `claude-sonnet-4-5`.

```bash
HTTP_PROXY= \
HTTPS_PROXY= \
ALL_PROXY= \
NO_PROXY=127.0.0.1,localhost \
no_proxy=127.0.0.1,localhost \
ANTHROPIC_BASE_URL=http://127.0.0.1:3000 \
ANTHROPIC_AUTH_TOKEN=dummy-local-token \
/opt/homebrew/bin/claude -p --model claude-sonnet-4-5 --debug api "Reply with OK only."
```

Notes:

- `ANTHROPIC_AUTH_TOKEN` only needs to be non-empty for the local gateway; upstream provider auth still comes from the YAML model catalog.
- `NO_PROXY` matters in environments with a corporate HTTP proxy, otherwise Claude Code may never reach `localhost`.
- The gateway should expose a public model id beginning with `claude` or `anthropic` if you want to use `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- `GET /v1/models` returns Anthropic-compatible data when Claude sends `anthropic-version`.
- `POST /v1/messages?beta=true` is the main Claude Code runtime path, and Claude starts with `stream: true`, so streaming support is part of the practical validation path.
- `POST /v1/messages` maps Anthropic tool definitions and tool results onto OpenAI-compatible chat-completions tool calls, so Claude Code can use the gateway when the upstream provider supports tool calling.
