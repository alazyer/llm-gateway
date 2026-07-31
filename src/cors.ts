import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, PATCH, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, x-api-key, anthropic-version";
const MAX_AGE = 86400;

function isOriginAllowed(origin: string, corsOrigin: string | string[]): boolean {
  if (corsOrigin === "*") {
    return true;
  }

  if (typeof corsOrigin === "string") {
    return origin === corsOrigin;
  }

  if (Array.isArray(corsOrigin)) {
    return corsOrigin.includes(origin);
  }

  return false;
}

export function registerCorsHook(app: FastifyInstance, corsOrigin: string | string[]): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers["origin"];

    if (!origin) {
      return;
    }

    if (!isOriginAllowed(origin, corsOrigin)) {
      return;
    }

    // Handle CORS for all responses
    reply.header("Access-Control-Allow-Origin", corsOrigin === "*" ? "*" : origin);
    reply.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
    reply.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    reply.header("Access-Control-Max-Age", String(MAX_AGE));

    // Handle preflight OPTIONS requests
    if (request.method === "OPTIONS") {
      reply.code(204);
      return reply.send();
    }
  });
}
