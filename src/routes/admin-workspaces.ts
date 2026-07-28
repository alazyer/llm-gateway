/**
 * Workspace management admin API routes.
 * All routes require the gateway auth token (not workspace tokens).
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import type { Workspace, WorkspaceModelConfig, WorkspaceToken, WorkspaceMember, UsageSummary, UsageByModel, DailyUsage } from "../workspace/entity.js";
import type { WorkspaceStorage } from "../workspace/storage.js";

interface AdminWorkspacesRoutesOptions {
  storage: WorkspaceStorage;
  enabled: boolean;
}

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  ownerId: z.string().trim().min(1),
  tags: z.record(z.string(), z.string()).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const modelConfigSchema = z.object({
  allowedModels: z.array(z.string().trim().min(1)),
  aliases: z.record(z.string().trim().min(1), z.string().trim().min(1)),
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1),
  scopes: z.array(z.enum(["read", "write", "admin"])).min(1),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const addMemberSchema = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

const usageQuerySchema = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
});

export const adminWorkspacesRoutes: FastifyPluginAsync<AdminWorkspacesRoutesOptions> = async (app, options) => {
  if (!options.enabled) {
    return;
  }

  const storage = options.storage;

  // ── Workspace CRUD ──────────────────────────────────────────

  app.post("/admin/workspaces", async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const workspace = storage.createWorkspace(parsed.data);
    return reply.code(201).send(workspace);
  });

  app.get("/admin/workspaces", async (request: FastifyRequest<{ Querystring: { status?: string; limit?: string; offset?: string } }>, reply: FastifyReply) => {
    const { status, limit, offset } = request.query;
    const workspaces = storage.listWorkspaces({
      status: status as Workspace["status"] | undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return reply.send({ data: workspaces });
  });

  app.get("/admin/workspaces/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }
    return reply.send(workspace);
  });

  app.put("/admin/workspaces/:id", async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
    const parsed = updateWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const updated = storage.updateWorkspace(request.params.id, parsed.data);
    if (!updated) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }
    return reply.send(updated);
  });

  app.delete("/admin/workspaces/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const deleted = storage.deleteWorkspace(request.params.id);
    if (!deleted) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }
    return reply.code(204).send();
  });

  // ── Model Configuration ────────────────────────────────────

  app.get("/admin/workspaces/:id/models", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }
    const config = storage.getModelConfig(request.params.id);
    return reply.send(config ?? { allowedModels: [], aliases: {} });
  });

  app.put("/admin/workspaces/:id/models", async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const parsed = modelConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const config = storage.setModelConfig(request.params.id, parsed.data);
    return reply.send(config);
  });

  app.get("/admin/workspaces/:id/aliases", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }
    const config = storage.getModelConfig(request.params.id);
    return reply.send(config?.aliases ?? {});
  });

  app.put("/admin/workspaces/:id/aliases", async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const aliasesSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));
    const parsed = aliasesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const existing = storage.getModelConfig(request.params.id) ?? { allowedModels: [], aliases: {} };
    const config = storage.setModelConfig(request.params.id, {
      ...existing,
      aliases: parsed.data,
    });
    return reply.send(config.aliases);
  });

  // ── Auth Management ────────────────────────────────────────

  app.post("/admin/workspaces/:id/tokens", async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const parsed = createTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const result = storage.createToken({
      workspaceId: request.params.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expiresAt ?? null,
    });

    return reply.code(201).send({
      id: result.record.id,
      token: result.token,
      name: result.record.name,
      scopes: result.record.scopes,
      expires_at: result.record.expiresAt,
      created_at: result.record.createdAt,
    });
  });

  app.get("/admin/workspaces/:id/tokens", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const tokens = storage.listTokens(request.params.id);
    // Strip hashes from the response
    const safe = tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      expires_at: t.expiresAt,
      created_at: t.createdAt,
      last_used_at: t.lastUsedAt,
    }));
    return reply.send({ data: safe });
  });

  app.delete("/admin/workspaces/:id/tokens/:tokenId", async (request: FastifyRequest<{ Params: { id: string; tokenId: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const revoked = storage.revokeToken(request.params.id, request.params.tokenId);
    if (!revoked) {
      return reply.code(404).send({
        error: `Token \`${request.params.tokenId}\` not found in this workspace.`,
      });
    }
    return reply.code(204).send();
  });

  // ── RBAC ───────────────────────────────────────────────────

  app.get("/admin/workspaces/:id/members", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const members = storage.listMembers(request.params.id);
    return reply.send({ data: members });
  });

  app.put("/admin/workspaces/:id/members/:userId", async (request: FastifyRequest<{ Params: { id: string; userId: string }; Body: unknown }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: formatZodError(parsed.error),
      });
    }

    const updated = storage.updateMemberRole(request.params.id, request.params.userId, parsed.data.role);
    if (!updated) {
      return reply.code(404).send({
        error: `Member \`${request.params.userId}\` not found in this workspace.`,
      });
    }
    return reply.send(updated);
  });

  app.delete("/admin/workspaces/:id/members/:userId", async (request: FastifyRequest<{ Params: { id: string; userId: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const removed = storage.removeMember(request.params.id, request.params.userId);
    if (!removed) {
      return reply.code(404).send({
        error: `Member \`${request.params.userId}\` not found in this workspace.`,
      });
    }
    return reply.code(204).send();
  });

  // ── Usage Reporting ────────────────────────────────────────

  app.get("/admin/workspaces/:id/usage", async (request: FastifyRequest<{ Params: { id: string }; Querystring: { periodStart?: string; periodEnd?: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const { periodStart, periodEnd } = resolvePeriod(request.query.periodStart, request.query.periodEnd);
    const summary = storage.getUsageSummary(request.params.id, periodStart, periodEnd);
    return reply.send(summary);
  });

  app.get("/admin/workspaces/:id/usage/daily", async (request: FastifyRequest<{ Params: { id: string }; Querystring: { periodStart?: string; periodEnd?: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const { periodStart, periodEnd } = resolvePeriod(request.query.periodStart, request.query.periodEnd);
    const daily = storage.getDailyUsage(request.params.id, periodStart, periodEnd);
    return reply.send({ data: daily });
  });

  app.get("/admin/workspaces/:id/usage/models", async (request: FastifyRequest<{ Params: { id: string }; Querystring: { periodStart?: string; periodEnd?: string } }>, reply: FastifyReply) => {
    const workspace = storage.getWorkspace(request.params.id);
    if (!workspace) {
      return reply.code(404).send({
        error: `Workspace \`${request.params.id}\` not found.`,
      });
    }

    const { periodStart, periodEnd } = resolvePeriod(request.query.periodStart, request.query.periodEnd);
    const byModel = storage.getUsageByModel(request.params.id, periodStart, periodEnd);
    return reply.send({ data: byModel });
  });
};

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "body";
    return `${path}: ${issue.message}`;
  });
  return `Invalid request: ${issues.join("; ")}`;
}

function resolvePeriod(periodStart?: string, periodEnd?: string): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
  return {
    periodStart: periodStart ?? thirtyDaysAgo.toISOString(),
    periodEnd: periodEnd ?? now.toISOString(),
  };
}
