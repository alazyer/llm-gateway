# Spec: Model Lifecycle

## Requirements

### REQ-LIFECYCLE-001: Model status values
Each model SHALL have a `status` field with one of the following values:
- `active`: The model is available for routing requests.
- `inactive`: The model is not available for routing. It may be reactivated later.

**Rationale**: A binary status keeps the mental model simple. Richer states like `deprecated` or `provisioning` can be represented via `status_reason` text and added as explicit states in future changes if needed.

### REQ-LIFECYCLE-002: Static models default to active
Models seeded from `gateway.config.yaml` SHALL have `status='active'` by default. They remain active until explicitly set to `inactive` via the admin API.

### REQ-LIFECYCLE-003: Self-registered models default to active
When a Copilot proxy extension registers models, those models SHALL have `status='active'` upon registration.

### REQ-LIFECYCLE-004: Copilot disconnection marks models inactive
When a Copilot proxy WebSocket connection closes (cleanly or due to error/timeout), the gateway SHALL mark all models associated with that `connection_id` as `inactive`. The `status_reason` SHALL be set to `"Copilot proxy connection closed"` and `status_changed_at` SHALL be set to the current timestamp.

**Rationale**: Marking inactive rather than deleting preserves model metadata (capabilities, source prefix) for potential reconnection. It also allows operators to see which models were previously available.

### REQ-LIFECYCLE-005: Copilot reconnection reactivates matching models
When a Copilot proxy extension reconnects and registers models, the gateway SHALL check if a model with the same `name` already exists with `source='copilot-proxy'` and `status='inactive'`. If so:
- The gateway SHALL update the existing row to `status='active'`.
- The `connection_id` SHALL be updated to the new connection.
- The `capabilities_json` SHALL be updated from the new registration.
- The `status_reason` SHALL be set to `"Copilot proxy reconnected"`.

If no matching inactive model exists, a new row SHALL be inserted as per REQ-LIFECYCLE-003.

**Rationale**: Reactivation preserves model identity across connection drops. Chains referencing this model can resume using it without reconfiguration.

### REQ-LIFECYCLE-006: Inactive models excluded from routing
The `resolveModel()` function SHALL NOT return an inactive model for request routing. If a client requests an inactive model by name, the gateway SHALL return a 503 error with message `"Model '<name>' is inactive: <status_reason>"`.

### REQ-LIFECYCLE-007: Inactive models in /models listing
The `/models` and `/v1/models` endpoints SHALL include inactive models by default, with a `status` field in the response body. Callers MAY pass a query parameter `?status=active` to filter to active models only.

**Rationale**: Operators need visibility into inactive models to understand what was previously available and potentially reactivate them.

### REQ-LIFECYCLE-008: Manual status transition via admin API
The admin API SHALL provide an endpoint to transition a model's status:
- `POST /admin/models/<name>/activate` — sets status to `active`
- `POST /admin/models/<name>/deactivate` — sets status to `inactive`, with optional `reason` body parameter

These endpoints SHALL update `status`, `status_reason`, and `status_changed_at` in the database.

### REQ-LIFECYCLE-009: Status transition audit trail
The gateway SHALL log all status transitions with the model name, old status, new status, reason, and timestamp at INFO level.

### REQ-LIFECYCLE-010: Connection ID tracking for self-registered models
The `connection_id` column SHALL be populated for models with `source='copilot-proxy'`. When a connection closes, the gateway uses this column to identify which models to mark inactive. When a model is reactivated on reconnection, the `connection_id` is updated to the new connection.

## Scenarios

### Scenario: Copilot proxy connects, registers models, disconnects
**Given** no Copilot proxy models exist
**When** a Copilot proxy extension connects and registers `copilot-gpt-4` and `copilot-claude`
**Then** two rows are inserted with `status='active'`, `source='copilot-proxy'`, and the current `connection_id`
**When** the WebSocket connection closes
**Then** both models are updated to `status='inactive'` with `status_reason="Copilot proxy connection closed"`

### Scenario: Copilot proxy reconnects with same models
**Given** `copilot-gpt-4` exists with `status='inactive'` from a prior connection
**When** a Copilot proxy extension reconnects and registers `copilot-gpt-4` with a new `connection_id`
**Then** the existing row is updated to `status='active'`, `connection_id` is updated, and `status_reason="Copilot proxy reconnected"`
**And** no new row is inserted

### Scenario: Client requests inactive model
**Given** `copilot-gpt-4` has `status='inactive'` with `status_reason="Copilot proxy connection closed"`
**When** a client sends `POST /v1/chat/completions` with `"model": "copilot-gpt-4"`
**Then** the gateway returns 503 with `{"error": "Model 'copilot-gpt-4' is inactive: Copilot proxy connection closed"}`

### Scenario: Admin deactivates a static model
**Given** `glm-5.1` is a static model with `status='active'`
**When** an admin calls `POST /admin/models/glm-5.1/deactivate` with body `{"reason": "Upstream provider maintenance"}`
**Then** the model is updated to `status='inactive'` with `status_reason="Upstream provider maintenance"`
**And** subsequent requests to that model return 503

### Scenario: Admin reactivates a static model
**Given** `glm-5.1` has `status='inactive'`
**When** an admin calls `POST /admin/models/glm-5.1/activate`
**Then** the model is updated to `status='active'` with `status_reason="Manual activation"`
**And** subsequent requests to that model succeed
