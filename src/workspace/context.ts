/**
 * Workspace context middleware.
 * Extracts workspace ID from request headers (X-Workspace-Id),
 * validates the workspace exists and is active, and injects
 * workspace context into the request.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Workspace, WorkspaceModelConfig } from "./entity.js";
import type { WorkspaceStorage } from "./storage.js";

declare module "fastify" {
  interface FastifyRequest {
    workspace?: Workspace | undefined;
    workspaceModelConfig?: WorkspaceModelConfig | undefined;
  }
}

export interface RegisterWorkspaceContextOptions {
  storage: WorkspaceStorage;
  enabled: boolean;
}

const WORKSPACE_HEADER = "x-workspace-id";

export function registerWorkspaceContext(
  app: FastifyInstance,
  options: RegisterWorkspaceContextOptions,
): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip workspace context for health check and admin routes
    if (isAdminOrHealthRoute(request.url)) {
      return;
    }

    // If workspace support is disabled, skip entirely
    if (!options.enabled) {
      return;
    }

    const workspaceId = request.headers[WORKSPACE_HEADER];
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      // No workspace header — allow request through without workspace context
      // (falls back to global config)
      return;
    }

    const trimmed = workspaceId.trim();
    const workspace = options.storage.getWorkspace(trimmed);
    if (!workspace) {
      return reply.code(404).send({
        error: {
          message: `Workspace \`${trimmed}\` not found.`,
          type: "invalid_request_error",
        },
      });
    }

    if (workspace.status !== "active") {
      return reply.code(403).send({
        error: {
          message: `Workspace \`${workspace.name}\` is ${workspace.status}.`,
          type: "invalid_request_error",
        },
      });
    }

    request.workspace = workspace;
    request.workspaceModelConfig = options.storage.getModelConfig(trimmed) ?? undefined;

    // Augment log context with workspace_id
    request.log = request.log.child({ workspace_id: workspace.id });
  });
}

/**
 * Routes that should skip workspace context injection.
 */
function isAdminOrHealthRoute(url: string): boolean {
  const path = url.split("?")[0] ?? "";

  if (path === "/healthz") {
    return true;
  }

  // Admin workspace management routes
  if (path.startsWith("/admin/workspaces")) {
    return true;
  }

  return false;
}
