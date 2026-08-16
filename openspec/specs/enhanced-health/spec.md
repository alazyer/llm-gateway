# enhanced-health Specification

## Purpose
TBD - created by archiving change gateway-security-health. Update Purpose after archive.
## Requirements
### Requirement: Health check SHALL validate gateway configuration state
The `/healthz` endpoint SHALL verify that gateway configuration is loaded and SHALL return process health independently of whether models are configured.

#### Scenario: Healthy gateway returns config details
- **WHEN** the gateway is running with valid configuration and at least one model loaded
- **THEN** `/healthz` SHALL return `{ok: true, models: <count>, configured: true}` with the number of configured models

#### Scenario: Gateway with no models remains healthy
- **WHEN** the gateway is running but has zero models configured
- **THEN** `/healthz` SHALL return `{ok: true, models: 0, configured: false}` with HTTP 200

### Requirement: Health check SHALL optionally probe upstream connectivity
When `health_probe_enabled` is configured, the `/healthz` endpoint SHALL attempt a lightweight upstream connectivity check only when at least one model is available; if no models are configured, health remains HTTP 200 and reports unconfigured state.

#### Scenario: Probe enabled and upstream reachable
- **WHEN** `health_probe_enabled` is true and at least one upstream responds successfully
- **THEN** `/healthz` SHALL return `{ok: true, models: <count>, configured: true, upstream: "reachable"}`

#### Scenario: Probe enabled and upstream unreachable
- **WHEN** `health_probe_enabled` is true, at least one model is configured, and no upstream is reachable
- **THEN** `/healthz` SHALL return `{ok: false, error: "Upstream unreachable.", upstream: "unreachable"}` with HTTP 503

#### Scenario: Probe enabled but no models configured
- **WHEN** `health_probe_enabled` is true and zero models are configured
- **THEN** `/healthz` SHALL return `{ok: true, models: 0, configured: false}` with HTTP 200 and SHALL NOT fail health due to missing upstream targets

#### Scenario: Probe disabled (default)
- **WHEN** `health_probe_enabled` is not configured
- **THEN** `/healthz` SHALL validate process/configuration state without upstream probing

