# dockerfile-build-fix Specification

## Purpose
A working multi-stage Dockerfile that produces a minimal production container image for the llm-gateway, using npm to match the project's package manager.

## Requirements

### Requirement: Dockerfile SHALL produce a working container image

The Dockerfile SHALL use a multi-stage build to compile the TypeScript gateway and produce a minimal production image that starts successfully.

#### Scenario: Container builds and starts successfully
- **WHEN** `docker build .` is run from the project root
- **THEN** the build SHALL complete without errors
- **AND** `docker run -e GATEWAY_CONFIG_PATH=/app/gateway.yaml -v ./gateway.yaml:/app/gateway.yaml <image>` SHALL start the gateway on port 3000

#### Scenario: Container responds to health check
- **WHEN** the container is running and a GET request is made to `/healthz`
- **THEN** the container SHALL respond with HTTP 200 and `{ ok: true, models: N }` where N is the number of configured models

### Requirement: Dockerfile SHALL use npm as the package manager

The Dockerfile SHALL use `npm install` and `npm run build` exclusively. It SHALL NOT reference pnpm, yarn, or corepack.

#### Scenario: No pnpm references in Dockerfile
- **WHEN** the Dockerfile is inspected
- **THEN** it SHALL NOT contain the strings `pnpm` or `corepack`

#### Scenario: npm install resolves workspace dependencies
- **WHEN** `npm install` runs in the deps or build stage
- **THEN** it SHALL successfully resolve the `@llm-gateway/shared` workspace dependency from `packages/shared`

### Requirement: Dockerfile SHALL copy the packages/shared workspace

The Dockerfile SHALL copy the `packages/shared` directory into each build stage that runs `npm install` or `npm run build`.

#### Scenario: Build stage has packages/shared available
- **WHEN** `npm run build` executes in the build stage
- **THEN** the `@llm-gateway/shared` package SHALL be resolvable from `node_modules`
- **AND** the TypeScript compilation SHALL succeed

#### Scenario: Runner stage has packages/shared for npm install
- **WHEN** `npm install --omit=dev` executes in the runner stage
- **THEN** it SHALL successfully resolve the `@llm-gateway/shared` workspace dependency

### Requirement: Final image SHALL contain only production dependencies

The runner stage SHALL install production-only dependencies. Dev dependencies used during build SHALL NOT appear in the final image.

#### Scenario: Dev dependencies absent from final image
- **WHEN** the final image is inspected
- **THEN** `node_modules` SHALL NOT contain `vitest`, `tsx`, `typescript`, or `@types/node`

### Requirement: Dockerfile SHALL NOT include config files or secrets

The Dockerfile SHALL NOT `COPY` `.env`, `gateway.config.yaml`, or any file containing secrets into the image.

#### Scenario: No config files in image
- **WHEN** the final image is inspected
- **THEN** it SHALL NOT contain `.env` or `gateway.config.yaml` files
