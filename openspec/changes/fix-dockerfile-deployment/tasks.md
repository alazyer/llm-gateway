## 1. Rewrite Dockerfile

- [ ] 1.1 Replace the `FROM base AS deps` stage: use `npm install` with `package-lock.json`, copy `packages/shared/package.json` and `packages/shared` source
- [ ] 1.2 Replace the `FROM base AS build` stage: copy `node_modules` from deps, copy full source including `packages/shared`, run `npm run build`
- [ ] 1.3 Replace the `FROM base AS runner` stage: copy `package.json`, `package-lock.json`, and `packages/shared`, run `npm install --omit=dev`, copy `dist/` from build stage
- [ ] 1.4 Remove `corepack enable` and all `pnpm` references
- [ ] 1.5 Verify `CMD ["node", "dist/server.js"]` starts successfully with a mounted config

## 2. Update .dockerignore

- [ ] 2.1 Ensure `.dockerignore` does not exclude `packages/shared` or `package-lock.json`
- [ ] 2.2 Ensure `.dockerignore` excludes `.env`, `*.env`, `gateway.config.yaml`, `.git`, `node_modules`, `dist`, and test files

## 3. Verify Build

- [ ] 3.1 Run `docker build -t llm-gateway-test .` from the project root and confirm success
- [ ] 3.2 Run the container with a valid config mounted and verify `/healthz` returns 200
- [ ] 3.3 Verify the final image does not contain dev dependencies (`vitest`, `typescript`, etc.)
- [ ] 3.4 Verify the final image does not contain `.env` or `gateway.config.yaml`

## 4. Documentation

- [ ] 4.1 Update `README.md` deployment section with Docker build and run instructions
- [ ] 4.2 Add example `docker run` command showing config file mount and env var passthrough
