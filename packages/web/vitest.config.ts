import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Vitest config for the Nuxt web package.
//
// `@vitejs/plugin-vue` compiles the `.vue` SFCs under test (Nuxt's own
// compiler runs only inside the Nuxt build pipeline). Tests default to the
// Node environment; component tests that mount Vue components set
// `// @vitest-environment happy-dom` at the top of their file. The Nuxt
// auto-imports (`ref`, `computed`, `useRuntimeConfig`, `navigateTo`, ...)
// that the components rely on are stubbed in `tests/setup.ts`, since vitest
// does not run the Nuxt build pipeline.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "~/": new URL("./", import.meta.url).pathname,
    },
  },
});
