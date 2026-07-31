## Why

The `Dockerfile` is currently broken and cannot build a working container image. It uses `pnpm` for package installation and `corepack enable` to activate it, but the project uses `npm` with `package-lock.json` — there is no `pnpm-lock.yaml` file. This means:

1. The `COPY package.json pnpm-lock.yaml* ./` line copies a non-existent lockfile.
2. `RUN pnpm install --frozen-lockfile` fails because there is no pnpm lockfile and the project is not configured as a pnpm workspace in the context of the Dockerfile.
3. Even if pnpm install somehow succeeded, the `npm run build` scripts and `package.json` workspaces configuration expect npm, not pnpm.

Additionally, the Dockerfile does not copy the `packages/shared` workspace package that `npm run build` depends on, so even with npm the build would fail.

Without a working Dockerfile, the gateway cannot be deployed to any containerized environment — which is the primary deployment target for a network service.

## What Changes

- Replace `pnpm` commands with `npm` throughout the Dockerfile to match the project's actual package manager.
- Remove `corepack enable` since npm is bundled with the Node.js Alpine image.
- Copy `package-lock.json` instead of `pnpm-lock.yaml`.
- Add `COPY` steps for the `packages/shared` workspace package required by the build.
- Use multi-stage build correctly: deps stage installs all dependencies, build stage compiles TypeScript, runner stage installs production-only dependencies and copies compiled output.
- Add `.env` handling notes: the container expects `GATEWAY_CONFIG_PATH` to be set and the config file to be mounted.

## Capabilities

### New Capabilities

- `dockerfile-build-fix`: A working multi-stage Dockerfile that produces a minimal production container image for the llm-gateway.

### Modified Capabilities

- `openai-chat-completions-transport`: No API changes, but the deployment artifact (container image) is now actually buildable.

## Impact

- **Code**: `Dockerfile` (complete rewrite), `.dockerignore` (ensure `packages/shared` is not excluded)
- **APIs**: No API changes
- **Dependencies**: No new dependencies (removes implicit pnpm dependency)
- **Config**: No new config fields; `GATEWAY_CONFIG_PATH` env var already expected
- **Tests**: Add a CI step that builds the Docker image and runs the health check
