# llm-gateway

`llm-gateway` is a Fastify gateway that lets clients call `/responses`-style, OpenAI `/v1/chat/completions`, or Anthropic `/v1/messages` APIs while the upstream model provider only supports `/chat/completions`.

## What it does

- Accepts `POST /responses` and `POST /v1/responses`
- Accepts `POST /v1/chat/completions` for OpenAI-compatible clients
- Accepts `POST /v1/messages` for Anthropic-compatible clients such as Claude Code
- Accepts `POST /v1/messages/count_tokens` for Anthropic-compatible token estimation
- Exposes `GET /models`, `GET /v1/models`, and per-model detail endpoints for metadata discovery
- Translates `/responses` input into `/chat/completions` messages
- Translates Anthropic `/v1/messages` requests into `/chat/completions`, including tool definitions and tool result messages
- Proxies requests to the configured upstream provider
- Optionally proxies `copilot-*` model requests through a connected VS Code extension using VS Code's Copilot `vscode.lm` API
- Translates both JSON and streaming SSE output back into a practical `/responses` shape
- Translates Anthropic JSON and streaming message responses back into Claude-compatible message/event shapes
- Exposes `GET /healthz` for basic runtime checks
- Optionally enforces gateway auth, CORS, request-size limits, retries, timeouts, and upstream health probing
- Advertises compatibility metadata such as `personality`, `model_messages`, and `base_instructions` on model records
- Persists models, model chains, and runtime state to SQLite for durability across restarts

## Configuration

The gateway uses SQLite for persistence. On first startup, it seeds the database from `gateway.config.yaml`. After seeding, the database is the source of truth and the YAML file is not read again.

Copy `.env.example` to `.env`, copy `gateway.config.example.yaml` to `gateway.config.yaml`, then set:

- `HOST` - bind host, defaults to `0.0.0.0`
- `PORT` - bind port, defaults to `3000`
- `LOG_LEVEL` - Fastify/Pino log level, one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`
- `GATEWAY_CONFIG_PATH` - path to your YAML seed file (only used on first startup when database is empty)
- `GATEWAY_DB_PATH` - path to SQLite database file, defaults to `./data/gateway.db`
- provider secret env vars referenced by `api_key_env` in the YAML file

Keep actual secrets in your shell or `.env`, not in tracked YAML files. The recommended `gateway.config.yaml` file is local-only and gitignored.

### Database persistence

The gateway persists all configuration and runtime state to SQLite:

- **Models**: Static models from YAML (`source='static'`) and Copilot proxy models (`source='copilot-proxy'`)
- **Model chains**: Chain definitions and their model membership
- **Gateway config**: Top-level settings (default_model, timeouts, CORS, etc.)
- **Model status**: Each model has a status (`active` or `inactive`) that persists across restarts

On first startup (no database exists), the gateway:

1. Creates the database at `GATEWAY_DB_PATH` (default: `./data/gateway.db`)
2. Applies schema migrations
3. Seeds from `gateway.config.yaml` (validated before persisting)
4. Starts serving requests

On subsequent startups, the gateway opens the existing database and applies any pending migrations. The YAML file is **not** re-read. To change configuration after first startup, use the admin API.

#### Model lifecycle

Models have a binary status: `active` or `inactive`.

- **Static models** (from YAML) start as `active` and remain active unless manually deactivated via the admin API.
- **Copilot proxy models** are `active` while their WebSocket connection is open. When the connection closes, the model is marked `inactive` (not deleted). If the same model reconnects, it is reactivated.

Inactive models:

- Return HTTP 503 when requested directly
- Are skipped during chain fallback execution
- Still appear in `/models` listings with their status

#### Chain status

Chain status is derived from the status of its constituent models:

- `active`: All models in the chain are active
- `degraded`: Some models are active, some are inactive
- `inactive`: All models in the chain are inactive

When a model's status changes, all chains referencing that model have their status recalculated automatically.

Top-level YAML settings:

- `default_model` - optional public model name used when a request omits `model`
- `request_timeout_ms` - upstream request timeout, defaults to `30000`
- `max_retries` - retry attempts for transient upstream failures (`429`, `502`, `503`), defaults to `0`
- `max_body_size_kb` - maximum request body size, defaults to `1024`
- `gateway_auth_token_env` - optional env var name for the gateway auth token
- `health_probe_enabled` - optional, defaults to `false`; probes upstream `/models` during `/healthz`
- `cors_origin` - optional browser CORS allowlist: `"*"`, a single origin string, or an array of origin strings
- `copilot_proxy_enabled` - optional, defaults to `false`; enables scoped proxy-token issuance for the VS Code Copilot proxy extension
- `copilot_proxy_require_token_auth` - optional, defaults to `true`; requires a scoped proxy token on `/ws/copilot-proxy` connections
- `copilot_proxy_token_ttl_seconds` - optional proxy-token lifetime, defaults to `86400`
- `copilot_proxy_heartbeat_interval_ms` - optional WebSocket heartbeat interval, defaults to `30000`
- `copilot_proxy_heartbeat_timeout_ms` - optional WebSocket heartbeat timeout, defaults to `10000`
- `copilot_proxy_max_inflight_per_connection` - optional per-extension in-flight request cap, defaults to `4`
- `copilot_proxy_allowed_prefixes` - optional list of model ID prefixes the gateway accepts from extension registrations, defaults to `["copilot-"]`
- `models` - YAML model catalog entries

Each YAML entry supports:

- `name` - public model name exposed by `/v1/models`
- `upstream_model` - optional upstream model name to send to `/chat/completions`
- `base_url` - upstream provider base URL
- `api_key_env` - environment variable name holding the secret
- `owned_by` - owner string returned in model discovery
- `created` - optional Unix timestamp returned in model discovery; defaults to startup time
- `supports_tools` - optional, defaults to `true`; reject tool requests when `false`
- `supports_streaming` - optional, defaults to `true`; reject streaming requests when `false`
- `unknown_field_mode` - optional, one of `warn` or `enforce` (defaults to `warn`) for `/responses` top-level unknown fields
- `unknown_field_window_requests` - optional request window for unknown-field warning counters, defaults to `100`

Inline `api_key` values are rejected; use `api_key_env` instead.

### Gateway auth

When `gateway_auth_token_env` is set and the referenced environment variable has a value, request routes require either:

- `x-api-key: <token>`
- `Authorization: Bearer <token>`

`GET /healthz`, `GET /models`, `GET /v1/models`, and model detail routes stay public. `OPTIONS` preflight requests also skip auth.

Anthropic routes return Anthropic-shaped authentication errors; OpenAI-compatible routes return OpenAI-shaped authentication errors.

### Admin API

Admin API endpoints provide runtime management of models and chains. All admin endpoints require gateway auth.

#### List models with status

```bash
curl http://localhost:3000/admin/models \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Response includes status fields for each model:

```json
{
  "object": "list",
  "data": [
    {
      "name": "glm-5.1",
      "source": "static",
      "status": "active",
      "status_reason": null,
      "status_changed_at": null,
      "upstream_model": "glm-5.1",
      "base_url": "https://...",
      "owned_by": "beacon",
      "supports_tools": true,
      "supports_streaming": true
    },
    {
      "name": "copilot-gpt-4o",
      "source": "copilot-proxy",
      "status": "inactive",
      "status_reason": "Copilot proxy connection closed",
      "status_changed_at": 1721234567,
      "connection_id": null
    }
  ]
}
```

Query parameters:

- `?status=active` — filter to active models only
- `?status=inactive` — filter to inactive models only
- `?source=static` — filter to static models only
- `?source=copilot-proxy` — filter to Copilot proxy models only

#### Get single model

```bash
curl http://localhost:3000/admin/models/glm-5.1 \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

#### Activate model

```bash
curl -X POST http://localhost:3000/admin/models/glm-5.1/activate \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Sets the model to `active` with `status_reason="Manual activation"`. Recalculates status of all chains referencing this model.

#### Deactivate model

```bash
curl -X POST http://localhost:3000/admin/models/glm-5.1/deactivate \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"reason": "Scheduled maintenance"}'
```

Sets the model to `inactive` with the provided reason. Recalculates status of all chains referencing this model.

#### List chains with status

```bash
curl http://localhost:3000/admin/chains \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Response includes status and model membership:

```json
{
  "object": "list",
  "data": [
    {
      "name": "primary-fallback",
      "status": "degraded",
      "status_reason": "1 of 2 models inactive: deepseek-v4-flash",
      "status_changed_at": 1721234567,
      "active_models": 1,
      "total_models": 2,
      "models": [
        {"name": "glm-5.1", "status": "active", "position": 0},
        {"name": "deepseek-v4-flash", "status": "inactive", "position": 1}
      ]
    }
  ]
}
```

Query parameters:

- `?status=active` — filter to active chains only
- `?status=degraded` — filter to degraded chains only
- `?status=inactive` — filter to inactive chains only

#### Get single chain

```bash
curl http://localhost:3000/admin/chains/primary-fallback \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

#### Gateway status summary

```bash
curl http://localhost:3000/admin/status \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Returns aggregate status:

```json
{
  "models": {
    "total": 5,
    "active": 3,
    "inactive": 2,
    "by_source": {
      "static": {"total": 2, "active": 2, "inactive": 0},
      "copilot-proxy": {"total": 3, "active": 1, "inactive": 2}
    }
  },
  "chains": {
    "total": 2,
    "active": 1,
    "degraded": 1,
    "inactive": 0
  },
  "copilot_proxy": {
    "enabled": true,
    "connections": 1
  }
}
```

#### Database info

```bash
curl http://localhost:3000/admin/database \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Returns database metadata:

```json
{
  "path": "/data/gateway.db",
  "schema_version": 1,
  "size_bytes": 24576
}
```

### Copilot proxy

The Copilot proxy lets normal gateway clients use GitHub Copilot models through `copilot-*` model IDs. The gateway still serves the HTTP APIs (`/responses`, `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, `/models`), while a VS Code extension connects outward to the gateway over WebSocket and executes requests through VS Code's `vscode.lm` Copilot model API.

```text
HTTP client / gateway web/API
        |
        | POST /v1/responses or /v1/chat/completions model=copilot-...
        v
llm-gateway Fastify server
        |
        | WebSocket /ws/copilot-proxy
        v
VS Code extension
        |
        | vscode.lm.selectChatModels() + model.sendRequest()
        v
GitHub Copilot in VS Code
```

When `copilot_proxy_enabled: true` and `copilot_proxy_require_token_auth: true` (default), `POST /api/proxy-token` issues a scoped, expiring token for VS Code extension WebSocket connections. The endpoint requires the same gateway auth token as data routes. Proxy tokens are only valid for Copilot proxy extension connections and do not grant access to HTTP data endpoints.

If `copilot_proxy_require_token_auth: false`, the gateway accepts `/ws/copilot-proxy` connections without proxy tokens. Use this only in trusted local/dev environments.

Copilot authentication remains managed entirely by VS Code and the GitHub Copilot extension. Do not export Copilot or VS Code credentials into gateway configuration, `.env`, logs, or proxy-token requests.

#### Use the gateway and VS Code extension together

1. Enable gateway auth and the Copilot proxy in `gateway.config.yaml`:

```yaml
gateway_auth_token_env: GATEWAY_AUTH_TOKEN
copilot_proxy_enabled: true
copilot_proxy_require_token_auth: true
copilot_proxy_token_ttl_seconds: 86400
copilot_proxy_heartbeat_interval_ms: 30000
copilot_proxy_heartbeat_timeout_ms: 10000
copilot_proxy_max_inflight_per_connection: 4
copilot_proxy_allowed_prefixes:
  - copilot-
```

2. Set the gateway auth token in `.env` or your shell, then start the gateway web/API server:

```bash
export GATEWAY_AUTH_TOKEN="replace-with-a-local-secret"
npm run dev
```

3. Issue a scoped proxy token with the existing gateway auth token:

```bash
curl -X POST http://localhost:3000/api/proxy-token \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

The response contains a `token` value to put in VS Code settings:

```json
{
  "token": "cpx_...",
  "token_type": "copilot_proxy",
  "expires_at": "2026-06-27T07:00:00.000Z"
}
```

4. Build/package the VS Code extension from this repository and install the generated VSIX:

```bash
npm run package --workspace llm-gateway-copilot-proxy
code --install-extension packages/vscode-extension/dist/llm-gateway-copilot-proxy-0.1.0.vsix
```

5. In VS Code settings, configure the extension to connect to the gateway:

```json
{
  "llmGatewayCopilotProxy.gatewayUrl": "ws://localhost:3000/ws/copilot-proxy",
  "llmGatewayCopilotProxy.proxyToken": "<proxy-token>",
  "llmGatewayCopilotProxy.enableGatewayAuth": true,
  "llmGatewayCopilotProxy.modelPrefix": "copilot-"
}
```

6. Ensure the GitHub Copilot extension is installed, enabled, and signed in inside VS Code. The extension status bar item should show that the proxy is connected. If Copilot is unavailable or the token is rejected, use the command **LLM Gateway Copilot Proxy: Show Output** for details.
7. Discover Copilot-backed models through the gateway web/API server:

```bash
curl http://localhost:3000/v1/models
```

Connected Copilot models appear with `copilot-` IDs and `source` metadata matching the registering prefix (e.g., `"copilot-"` for the default prefix). Use one of those IDs in normal gateway requests:

```bash
curl http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "copilot-gpt-4o",
    "instructions": "Reply in one sentence.",
    "input": "Explain what this gateway does."
  }'
```

#### Configurable model prefixes

By default, all Copilot models are registered with the `copilot-` prefix. You can configure additional allowed prefixes in `gateway.config.yaml`:

```yaml
copilot_proxy_allowed_prefixes:
  - copilot-
  - alazyer-
```

Then configure the VS Code extension to use a specific prefix:

```json
{
  "llmGatewayCopilotProxy.modelPrefix": "alazyer-"
}
```

Models will appear with IDs like `alazyer-gpt-4o` and `source: "alazyer-"`. This allows multiple teams or extensions to register distinct model namespaces on the same gateway.

Extensions registering models with a prefix not on the allowlist are rejected with WebSocket close code `1008`.

#### Channel management endpoint

When the Copilot proxy is enabled and gateway auth is configured, `GET /api/channels` returns information about active prefixes and their connections:

```bash
curl http://localhost:3000/api/channels \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Response:

```json
[
  { "prefix": "alazyer-", "connectionCount": 1, "modelIds": ["alazyer-gpt-4o"] },
  { "prefix": "copilot-", "connectionCount": 2, "modelIds": ["copilot-gpt-4o", "copilot-claude-3-5-sonnet"] }
]
```

OpenAI-compatible clients can use the same `copilot-*` model IDs through `/v1/chat/completions`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "copilot-gpt-4o",
    "messages": [
      { "role": "user", "content": "Reply with one sentence from Copilot through llm-gateway." }
    ]
  }'
```

Anthropic-compatible clients can use the same `copilot-*` model IDs through `/v1/messages`:

```bash
curl http://localhost:3000/v1/messages \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "copilot-gpt-4o",
    "max_tokens": 256,
    "messages": [
      { "role": "user", "content": "Reply with one sentence from Copilot through the Anthropic-compatible gateway route." }
    ]
  }'
```

Use `copilot-*` exactly as you would use any other gateway model. If no VS Code extension is connected or no extension can serve the requested model, the gateway returns an endpoint-native unavailable-model error instead of falling back to a direct upstream model.

Failure modes surface through the extension status bar and gateway responses:

| State                        | Meaning                                                                                           | Action                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Extension disconnected       | VS Code extension is not connected to`/ws/copilot-proxy`                                        | Start VS Code, check`gatewayUrl`, or run the reconnect command                              |
| Copilot unavailable          | VS Code has no available Copilot language models                                                  | Sign in to Copilot, enable the Copilot extension, or wait for Copilot availability to recover |
| Gateway unreachable          | WebSocket connection failed or closed unexpectedly                                                | Check gateway process, network, and proxy URL                                                 |
| Proxy token expired/rejected | Gateway closed the WebSocket with policy violation                                                | Issue a new proxy token and update VS Code settings                                           |
| Stream interrupted           | The extension disconnected or Copilot failed mid-request                                          | Retry after confirming the extension is connected                                             |
| Unsupported tools            | A client requested tools for a Copilot model while the extension reports`supports_tools: false` | Retry without tools or use a direct gateway model that supports tools                         |
| Capacity exhausted           | All healthy extension connections are at the configured in-flight limit                           | Wait, lower client concurrency, or connect another VS Code extension instance                 |

The gateway never accepts GitHub Copilot credentials. Copilot auth stays in VS Code; only scoped llm-gateway proxy tokens belong in extension settings.

### CORS

Set `cors_origin` for browser-based clients. It can be:

- `"*"` to allow any origin
- a single origin such as `http://localhost:5173`
- an array of allowed origins

Allowed CORS request headers are `Content-Type`, `Authorization`, `x-api-key`, and `anthropic-version`.

### Request limits and upstream resilience

`max_body_size_kb` controls Fastify's request body limit. `request_timeout_ms` applies to upstream `/chat/completions` calls, and `max_retries` retries transient upstream responses (`429`, `502`, `503`) before surfacing the upstream failure.

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

Example response:

```json
{
  "ok": true,
  "models": 3
}
```

When `health_probe_enabled: true`, `/healthz` also probes the first configured upstream provider's `/models` endpoint. A reachable upstream adds `"upstream": "reachable"`; an unreachable upstream returns HTTP `503`.

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
- `POST /v1/messages/count_tokens` returns an estimated `{ "input_tokens": number }` response for Anthropic-compatible clients.
- `POST /v1/messages` maps Anthropic tool definitions and tool results onto OpenAI-compatible chat-completions tool calls, so Claude Code can use the gateway when the upstream provider supports tool calling.
