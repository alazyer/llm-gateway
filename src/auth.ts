import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const SKIP_AUTH_URLS = new Set([
  "/healthz",
  "/models",
  "/v1/models",
  "/ws/copilot-proxy",
]);

function isAuthSkippedPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";

  if (SKIP_AUTH_URLS.has(path)) {
    return true;
  }

  // Model detail routes: /models/:model and /v1/models/:model
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "models") {
    return true;
  }
  if (segments.length === 3 && segments[0] === "v1" && segments[1] === "models") {
    return true;
  }

  return false;
}

function extractAuthToken(request: FastifyRequest): string | undefined {
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim().length > 0) {
    return xApiKey.trim();
  }

  // Array of x-api-key headers — use the first
  if (Array.isArray(xApiKey) && xApiKey.length > 0 && typeof xApiKey[0] === "string") {
    return xApiKey[0].trim();
  }

  const authorization = request.headers["authorization"];
  if (typeof authorization === "string") {
    const trimmed = authorization.trim();
    if (trimmed.startsWith("Bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  // Array of Authorization headers
  if (Array.isArray(authorization) && authorization.length > 0 && typeof authorization[0] === "string") {
    const trimmed = authorization[0].trim();
    if (trimmed.startsWith("Bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  return undefined;
}

function isAnthropicMessagesPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === "/v1/messages" || path === "/v1/messages/count_tokens";
}

function sendAuthError(
  reply: FastifyReply,
  request: FastifyRequest,
): FastifyReply {
  if (isAnthropicMessagesPath(request.url)) {
    return reply.code(401).send({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing authentication token.",
      },
    });
  }

  return reply.code(401).send({
    error: {
      message: "Invalid or missing authentication token.",
      type: "authentication_error",
    },
  });
}

export function registerAuthHook(app: FastifyInstance, gatewayAuthToken: string): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isAuthSkippedPath(request.url)) {
      return;
    }

    // OPTIONS requests are CORS preflight — skip auth so the CORS plugin can respond
    if (request.method === "OPTIONS") {
      return;
    }

    const providedToken = extractAuthToken(request);
    if (!providedToken || providedToken !== gatewayAuthToken) {
      sendAuthError(reply, request);
      return reply;
    }
  });
}
