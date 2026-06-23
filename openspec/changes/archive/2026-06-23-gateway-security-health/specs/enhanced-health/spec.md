## Purpose
Define an enhanced health check that validates gateway state and optionally probes upstream connectivity.

## ADDED Requirements

### Requirement: Health check SHALL validate gateway configuration state
The `/healthz` endpoint SHALL verify that gateway configuration is loaded and at least one model is available, beyond just returning `{ok: true}`.

#### Scenario: Healthy gateway returns config details
- **WHEN** the gateway is running with valid configuration and at least one model loaded
- **THEN** `/healthz` SHALL return `{ok: true, models: <count>}` with the number of configured models

#### Scenario: Gateway with no models returns degraded status
- **WHEN** the gateway is running but has zero models configured
- **THEN** `/healthz` SHALL return `{ok: false, error: "No models configured."}` with HTTP 503

### Requirement: Health check SHALL optionally probe upstream connectivity
When `health_probe_enabled` is configured, the `/healthz` endpoint SHALL attempt a lightweight upstream connectivity check (e.g., a models list call to one configured upstream) to verify the upstream provider is reachable.

#### Scenario: Probe enabled and upstream reachable
- **WHEN** `health_probe_enabled` is true and at least one upstream responds successfully
- **THEN** `/healthz` SHALL return `{ok: true, models: <count>, upstream: "reachable"}`

#### Scenario: Probe enabled and upstream unreachable
- **WHEN** `health_probe_enabled` is true and no upstream is reachable
- **THEN** `/healthz` SHALL return `{ok: false, error: "Upstream unreachable.", upstream: "unreachable"}` with HTTP 503

#### Scenario: Probe disabled (default)
- **WHEN** `health_probe_enabled` is not configured
- **THEN** `/healthz` SHALL only validate gateway state without probing upstream
