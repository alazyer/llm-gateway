# cors-support Specification

## Purpose
TBD - created by archiving change gateway-security-health. Update Purpose after archive.
## Requirements
### Requirement: Gateway SHALL support configurable CORS headers
The gateway SHALL add CORS headers to all responses when `cors_origin` is configured in gateway YAML.

#### Scenario: CORS origin configured — headers added
- **WHEN** `cors_origin` is set (e.g., `http://localhost:5173`) and a browser client sends a request with `Origin` header matching the configured value
- **THEN** the gateway SHALL add `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and `Access-Control-Max-Age` headers to the response

#### Scenario: CORS origin configured — preflight handled
- **WHEN** `cors_origin` is set and a browser sends an `OPTIONS` preflight request
- **THEN** the gateway SHALL respond with appropriate CORS headers and HTTP 204, without forwarding to upstream

#### Scenario: CORS not configured — no headers
- **WHEN** `cors_origin` is not set
- **THEN** the gateway SHALL NOT add CORS headers (current behavior)

### Requirement: CORS SHALL support multiple origins
The `cors_origin` configuration SHALL accept either a single origin string or an array of origin strings.

#### Scenario: Multiple origins configured
- **WHEN** `cors_origin` is an array (e.g., `["http://localhost:5173", "https://admin.example.com"]`) and a request Origin matches one entry
- **THEN** the gateway SHALL return the matching origin in `Access-Control-Allow-Origin`

#### Scenario: Wildcard origin configured
- **WHEN** `cors_origin` is `"*"`
- **THEN** the gateway SHALL return `Access-Control-Allow-Origin: *`

