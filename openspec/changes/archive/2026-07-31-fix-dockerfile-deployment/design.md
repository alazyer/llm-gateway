## Context

The llm-gateway is a Fastify-based proxy service. Its `Dockerfile` uses `pnpm` but the project uses `npm` with `package-lock.json` and npm workspaces. The project has a workspace dependency on `@llm-gateway/shared` (located at `packages/shared`) that must be present for the TypeScript build to succeed. Currently the Dockerfile cannot produce a working image, making containerized deployment impossible.

## Goals / Non-Goals

**Goals:**
- Produce a working Dockerfile that builds and runs the gateway in a container
- Use npm to match the project's actual package manager
- Correctly handle the `packages/shared` workspace dependency in the multi-stage build
- Minimize final image size (Alpine-based, production dependencies only)
- Ensure the container starts correctly with `node dist/server.js`

**Non-Goals:**
- Switching the project to pnpm — that is a separate decision
- Adding docker-compose or Kubernetes manifests — deployment orchestration is out of scope
- Hot-reload or development-mode Docker support — the Dockerfile is for production builds only
- Multi-architecture builds (arm64/amd64) — can be added later with `docker buildx`

## Decisions

### 1. Use npm throughout the Dockerfile

**Decision**: Replace all `pnpm` references with `npm`. Remove `corepack enable`.

**Rationale**: The project uses `package-lock.json` and npm workspaces. Using pnpm in the Dockerfile creates a mismatch with the lockfile, CI, and developer workflows. npm is already included in the `node:24-alpine` image.

**Alternative considered**: Switch the project to pnpm. Rejected — that's a larger change affecting all developers and CI. The Dockerfile should match the project's current package manager.

### 2. Multi-stage build with explicit workspace package copy

**Decision**: Use three stages (deps, build, runner). Copy `packages/shared` into both the deps and build stages so `npm install` and `npm run build` can resolve the workspace dependency.

**Rationale**: npm workspaces require the workspace packages to be present on disk for `npm install` to resolve `file:` references. The current Dockerfile only copies `package.json` and the lockfile, so `npm install` would fail trying to resolve `@llm-gateway/shared`.

**Alternative considered**: Use `npm pack` to create a tarball of the shared package and install it as a dependency. Rejected — more complex than just copying the directory, and npm workspaces handle this naturally when the files are present.

### 3. Production-only install in runner stage

**Decision**: In the runner stage, run `npm install --omit=dev` with only the root `package.json`, `package-lock.json`, and `packages/shared` copied. Then copy `dist/` from the build stage.

**Rationale**: This produces the smallest possible image with only runtime dependencies. The `packages/shared` directory is still needed because npm resolves the `file:` workspace reference at install time.

**Alternative considered**: Use `npm prune --omit=dev` in the build stage and copy the entire `node_modules`. Rejected — this includes dev dependencies that were needed for build but aren't needed at runtime, bloating the image.

### 4. Do not bundle `.env` or config files in the image

**Decision**: The Dockerfile does not `COPY` `.env` or `gateway.config.yaml`. These are expected to be mounted or provided via environment variables at runtime.

**Rationale**: Config files contain secrets (API key env var names) and environment-specific values. Baking them into the image would leak secrets and require rebuilding for each environment.

### 5. Keep `CMD ["node", "dist/server.js"]`

**Decision**: The entrypoint remains `node dist/server.js`. No process manager (e.g., dumb-init, tini).

**Rationale**: Node.js handles signals correctly for graceful shutdown since the server already listens for `SIGINT`/`SIGTERM`. Adding a process manager is unnecessary complexity for a single-process container.

**Alternative considered**: Use `dumb-init` as PID 1. Rejected — not needed since `server.ts` already registers signal handlers and Fastify closes gracefully.

## Risks / Trade-offs

- **npm install in runner stage duplicates work**: The deps and runner stages both run `npm install`. This is intentional — the deps stage includes dev dependencies needed for build, while the runner stage installs production-only. The trade-off is slightly longer build time for a significantly smaller final image.
- **packages/shared must be kept in sync**: If new files are added to `packages/shared`, the Dockerfile's `COPY` commands already cover the full directory. No Dockerfile changes needed.
- **No health check in Dockerfile**: The `HEALTHCHECK` instruction is not included because orchestration systems (Kubernetes, ECS) have their own health check mechanisms that should use `/healthz`. Adding a Docker-level health check can interfere with orchestration-level checks.

## Open Questions

1. Should we add a `docker-compose.yaml` for local development? (Out of scope for this change but a natural follow-up.)
2. Should the Dockerfile support a `PORT` build arg for the exposed port? (Currently hardcoded to 3000 — matches the default in `config.ts`.)
