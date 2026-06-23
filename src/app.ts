import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import { registerAuthHook } from "./auth.js";
import { registerCorsHook } from "./cors.js";
import { responsesRoutes } from "./routes/responses.js";
import type { ChatCompletionsTransport } from "./upstream/chat-completions-client.js";

export interface CreateAppOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
}

export function createApp(options: CreateAppOptions) {
  const app = Fastify({
    bodyLimit: options.config.maxBodySizeKb * 1024,
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

  if (options.config.corsOrigin) {
    registerCorsHook(app, options.config.corsOrigin);
  }

  if (options.config.gatewayAuthToken) {
    registerAuthHook(app, options.config.gatewayAuthToken);
  }

  app.get("/healthz", async (request, reply) => {
    app.log.debug("Serving health check response.");

    if (options.config.models.length === 0) {
      return reply.code(503).send({
        ok: false,
        error: "No models configured.",
      });
    }

    const healthResponse: { ok: boolean; models: number; upstream?: string } = {
      ok: true,
      models: options.config.models.length,
    };

    if (options.config.healthProbeEnabled) {
      try {
        const probeUrl = `${options.config.upstreamBaseUrl}/models`;
        const fetchToUse = options.fetchFn ?? fetch;
        const probeResponse = await fetchToUse(probeUrl, {
          signal: AbortSignal.timeout(5000),
        });

        if (probeResponse.ok) {
          healthResponse.upstream = "reachable";
        } else {
          healthResponse.upstream = "unreachable";
          return reply.code(503).send({
            ok: false,
            error: "Upstream unreachable.",
            upstream: "unreachable",
          });
        }
      } catch {
        return reply.code(503).send({
          ok: false,
          error: "Upstream unreachable.",
          upstream: "unreachable",
        });
      }
    }

    return healthResponse;
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
