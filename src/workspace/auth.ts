/**
 * Workspace-scoped authentication.
 * Validates workspace API keys and checks token scopes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { WorkspaceToken, TokenScope } from "./entity.js";
import type { WorkspaceStorage } from "./storage.js";

export interface RegisterWorkspaceAuthOptions {
  storage: WorkspaceStorage;
  enabled: boolean;
  /** The global gateway auth token, if configured. Workspace tokens bypass this. */
  gatewayAuthToken?: string | undefined;
}

const WORKSPACE_TOKEN_PREFIX = "wks_";

export function extractWorkspaceToken(request: FastifyRequest): string | undefined {
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim().length > 0) {
    return xApiKey.trim();
  }

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

function isWorkspaceToken(token: string): boolean {
  return token.startsWith(WORKSPACE_TOKEN_PREFIX);
}

/**
 * Check if a token scope satisfies a required scope.
 * Admin > write > read.
 */
export function scopeSatisfies(tokenScope: TokenScope, requiredScope: TokenScope): boolean {
  const hierarchy: Record<TokenScope, number> = {
    admin: 3,
    write: 2,
    read: 1,
  };
  return hierarchy[tokenScope] >= hierarchy[requiredScope];
}

export function registerWorkspaceAuth(
  app: FastifyInstance,
  options: RegisterWorkspaceAuthOptions,
): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.enabled) {
      return;
    }

    // Skip auth for health and OPTIONS
    if (isAuthSkippedRoute(request.url, request.method)) {
      return;
    }

    const providedToken = extractWorkspaceToken(request);
    if (!providedToken) {
      // If gateway auth is configured and no token provided, reject
      if (options.gatewayAuthToken) {
        return sendAuthError(reply, request);
      }
      // No auth configured, allow through
      return;
    }

    // If the token is a workspace token, validate it against workspace storage
    if (isWorkspaceToken(providedToken)) {
      const tokenRecord = options.storage.validateToken(providedToken);
      if (!tokenRecord) {
        return sendAuthError(reply, request);
      }

      // Inject workspace context from the token
      const workspace = options.storage.getWorkspace(tokenRecord.workspaceId);
      if (!workspace || workspace.status !== "active") {
        return sendAuthError(reply, request);
      }

      request.workspace = workspace;
      request.workspaceModelConfig = options.storage.getModelConfig(tokenRecord.workspaceId) ?? undefined;

      // Store token record for scope checks
      (request as unknown as { workspaceToken: WorkspaceToken }).workspaceToken = tokenRecord;

      // Augment log context
      request.log = request.log.child({
        workspace_id: workspace.id,
        workspace_token_id: tokenRecord.id,
      });

      return;
    }

    // If not a workspace token, check against gateway auth token
    if (options.gatewayAuthToken) {
      if (providedToken !== options.gatewayAuthToken) {
        return sendAuthError(reply, request);
      }
    }
  });
}

function isAuthSkippedRoute(url: string, method: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }

  const path = url.split("?")[0] ?? "";

  if (path === "/healthz") {
    return true;
  }

  // Model listing is public
  if (path === "/models" || path === "/v1/models") {
    return true;
  }

  const segments = path.split("/").filter(Boolean);
  // /models/:model and /v1/models/:model
  if (segments.length === 2 && segments[0] === "models") {
    return true;
  }
  if (segments.length === 3 && segments[0] === "v1" && segments[1] === "models") {
    return true;
  }

  return false;
}

function sendAuthError(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  const path = request.url.split("?")[0] ?? "";
  const isAnthropic = path === "/v1/messages" || path === "/v1/messages/count_tokens";

  if (isAnthropic) {
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
