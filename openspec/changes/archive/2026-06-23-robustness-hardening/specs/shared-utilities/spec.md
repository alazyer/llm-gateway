## Purpose
Centralize duplicated validation and formatting utility functions into a single shared module, eliminating copy-paste across 6+ files.

## ADDED Requirements

### Requirement: Shared validation utilities SHALL be provided from a single module
The gateway SHALL export `isRecord`, `expectString`, `expectNumber`, `expectBoolean`, and `toErrorMessage` from a single `src/shared.ts` module. All other modules SHALL import these from the shared module instead of defining their own copies.

#### Scenario: Translation modules use shared utilities
- **WHEN** any translation or stream module needs `isRecord`, `expectString`, `expectNumber`, or similar
- **THEN** it SHALL import from `src/shared.ts` and SHALL NOT define its own local version

#### Scenario: Shared utilities are type-safe
- **WHEN** shared utilities are used
- **THEN** they SHALL preserve the same TypeScript type signatures as the current inline versions

### Requirement: Shared SSE formatting utilities SHALL be provided from a single module
The gateway SHALL export `formatSseEvent` and `extractDataFrame` from `src/shared.ts`. All stream translator modules SHALL import these from the shared module.

#### Scenario: Stream translators use shared SSE utilities
- **WHEN** a stream translator module needs `formatSseEvent` or `extractDataFrame`
- **THEN** it SHALL import from `src/shared.ts` and SHALL NOT define its own local version

#### Scenario: SSE formatting produces identical output
- **WHEN** the shared `formatSseEvent` and `extractDataFrame` are used
- **THEN** they SHALL produce identical output to the current inline versions
