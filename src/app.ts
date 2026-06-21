import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import { responsesRoutes } from "./routes/responses.js";
import type { ChatCompletionsTransport } from "./upstream/chat-completions-client.js";

export interface CreateAppOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
}

export function createApp(options: CreateAppOptions) {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers[\"x-api-key\"]",
        "req.headers[\"api-key\"]",
        "req.headers[\"proxy-authorization\"]",
        "res.headers[\"set-cookie\"]",
        "authorization",
        "apiKey",
      ],
    },
  });

  app.get("/healthz", async () => {
    app.log.debug("Serving health check response.");

    return {
      ok: true,
    };
  });

  const routeOptions: {
    config: AppConfig;
    client?: ChatCompletionsTransport;
    fetchFn?: typeof fetch;
  } = {
    config: options.config,
  };

  if (options.client) {
    routeOptions.client = options.client;
  }

  if (options.fetchFn) {
    routeOptions.fetchFn = options.fetchFn;
  }

  void app.register(responsesRoutes, routeOptions);

  return app;
}
