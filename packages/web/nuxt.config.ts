// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2026-07-19",

  modules: ["@nuxt/ui"],

  css: ["~/assets/css/main.css"],

  fonts: {
    provider: "local",
  },

  ssr: false, // Pure SPA — talks to Fastify gateway API

  // Dev server port - change via PORT env var or here
  devServer: {
    port: Number(process.env.PORT) || 3100,
  },

  runtimeConfig: {
    public: {
      // Gateway API base URL - the backend Fastify server
      gatewayBaseUrl: process.env.GATEWAY_BASE_URL || "http://localhost:3000",
    },
  },

  app: {
    head: {
      title: "LLM Gateway Dashboard",
      meta: [
        { name: "description", content: "Manage models, chains, and gateway configuration" },
      ],
    },
  },
});
