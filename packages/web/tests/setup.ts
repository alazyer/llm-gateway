/**
 * Test setup for the Nuxt web package.
 *
 * Components under test rely on Nuxt auto-imports (`ref`, `computed`,
 * `useRuntimeConfig`, `navigateTo`, `definePageMeta`, `useGatewayApi`, ...).
 * Vitest does not run the Nuxt build pipeline, so this setup provides minimal
 * global stubs so the logic can run in isolation. Vue's reactivity primitives
 * (`ref`, `computed`, `watch`, `onMounted`, `nextTick`) are exposed directly
 * from `vue` — they are the same APIs Nuxt auto-imports.
 */
import { ref, computed, watch, onMounted, nextTick } from "vue";

// Expose Vue reactivity primitives as globals (Nuxt auto-imports them).
(globalThis as Record<string, unknown>).ref = ref;
(globalThis as Record<string, unknown>).computed = computed;
(globalThis as Record<string, unknown>).watch = watch;
(globalThis as Record<string, unknown>).onMounted = onMounted;
(globalThis as Record<string, unknown>).nextTick = nextTick;

// `definePageMeta` is a Nuxt compile-time macro; no-op in tests.
(globalThis as Record<string, unknown>).definePageMeta = () => {};

// `navigateTo` is a Nuxt router helper; no-op redirect in tests.
(globalThis as Record<string, unknown>).navigateTo = () => {};

// `useRuntimeConfig` returns the public runtime config the components read.
(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
  public: {
    gatewayBaseUrl: "http://localhost:3000",
    webAiChatEnabled: true,
  },
});

// `import.meta.client` is a Vite env condition (true in the browser bundle).
// Tests can set this via Vite's `define` if needed; default to true so the
// client-only branches in `useGatewayApi` resolve like a browser build.
(globalThis as Record<string, unknown>).__VITEST_CLIENT__ = true;
