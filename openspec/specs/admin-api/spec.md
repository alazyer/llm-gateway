# Spec: Admin API

## Purpose
Define authenticated administrative endpoints for inspecting and managing gateway models, chains, status, and database metadata.

## Requirements

### REQ-ADMIN-001: Admin API authentication
All admin API endpoints SHALL require authentication. The gateway SHALL use the existing `gateway_auth_token_env` configuration. If gateway auth is not configured, admin endpoints SHALL return 403.

**Rationale**: Admin endpoints modify runtime state and must be protected. Reusing the existing gateway auth mechanism avoids introducing a second auth system.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-002: Admin API prefix
All admin API endpoints SHALL be prefixed with `/admin`. This namespace separates administrative operations from the public model/chat endpoints.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-003: List models with status
`GET /admin/models` SHALL return a list of all models with their full metadata including status fields:

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
      "name": "copilot-gpt-4",
      "source": "copilot-proxy",
      "status": "inactive",
      "status_reason": "Copilot proxy connection closed",
      "status_changed_at": 1721234567,
      "connection_id": null,
      ...
    }
  ]
}
```

Query parameters:
- `?status=active` — filter to active models only
- `?status=inactive` — filter to inactive models only
- `?source=static` — filter to static models only
- `?source=copilot-proxy` — filter to Copilot proxy models only
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-004: Get single model detail
`GET /admin/models/<name>` SHALL return the full metadata for a single model, including status fields. If the model does not exist, return 404.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-005: Activate model
`POST /admin/models/<name>/activate` SHALL:
- Set the model's `status` to `active`
- Set `status_reason` to `"Manual activation"`
- Set `status_changed_at` to the current timestamp
- Recalculate status of all chains referencing this model
- Return 200 with the updated model object

If the model does not exist, return 404.
If the model is already active, return 200 (idempotent).
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-006: Deactivate model
`POST /admin/models/<name>/deactivate` SHALL:
- Set the model's `status` to `inactive`
- Set `status_reason` to the provided `reason` body parameter, or `"Manual deactivation"` if not provided
- Set `status_changed_at` to the current timestamp
- Recalculate status of all chains referencing this model
- Return 200 with the updated model object

Request body (optional):
```json
{
  "reason": "Upstream provider maintenance scheduled"
}
```

If the model does not exist, return 404.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-007: List chains with status
`GET /admin/chains` SHALL return a list of all chains with their status and model membership:

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
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-008: Get single chain detail
`GET /admin/chains/<name>` SHALL return the full metadata for a single chain, including status and model membership. If the chain does not exist, return 404.
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-009: Gateway status endpoint
`GET /admin/status` SHALL return a summary of gateway health:

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
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

### REQ-ADMIN-010: Database info endpoint
`GET /admin/database` SHALL return information about the database:

```json
{
  "path": "/data/gateway.db",
  "schema_version": 5,
  "size_bytes": 24576,
  "last_migration_at": 1721234567
}
```
#### Scenario: Requirement behavior is enforced
- **WHEN** the gateway evaluates this requirement
- **THEN** the gateway SHALL enforce the behavior described by this requirement

## Scenarios

### Scenario: Admin lists models with mixed status
**Given** 3 static models (all active) and 2 Copilot models (1 active, 1 inactive)
**When** admin calls `GET /admin/models`
**Then** response includes all 5 models with their respective status fields

### Scenario: Admin deactivates model with reason
**Given** model `glm-5.1` is active
**When** admin calls `POST /admin/models/glm-5.1/deactivate` with `{"reason": "Scheduled maintenance"}`
**Then** model status is `inactive` with `status_reason="Scheduled maintenance"`
**And** any chains referencing this model are recalculated

### Scenario: Admin activates inactive model
**Given** model `copilot-gpt-4` is inactive
**When** admin calls `POST /admin/models/copilot-gpt-4/activate`
**Then** model status is `active` with `status_reason="Manual activation"`

### Scenario: Unauthenticated admin request
**Given** gateway auth is configured
**When** a request to `GET /admin/models` has no `Authorization` header
**Then** response is 401

### Scenario: Admin gateway status
**Given** 5 models (3 active, 2 inactive) and 2 chains (1 active, 1 degraded)
**When** admin calls `GET /admin/status`
**Then** response includes accurate counts of models, chains, and their status breakdowns
