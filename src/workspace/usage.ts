/**
 * Workspace usage tracking.
 * Provides a Fastify hook to record per-workspace request metrics
 * and a helper to compute estimated costs.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { WorkspaceStorage } from "./storage.js";

export interface RegisterUsageTrackingOptions {
  storage: WorkspaceStorage;
  enabled: boolean;
}

/**
 * Model pricing per 1K tokens (simplified, USD).
 * Only used for estimation; users should verify against actual provider invoices.
 */
const MODEL_PRICING: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  "glm-5.1": { inputPer1k: 0.001, outputPer1k: 0.002 },
  "claude-sonnet-4-5": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-opus-5": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "coder-alias": { inputPer1k: 0.001, outputPer1k: 0.002 },
};

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Default: minimal estimate for unknown models
    return (promptTokens + completionTokens) * 0.000_001;
  }
  return (promptTokens / 1_000) * pricing.inputPer1k + (completionTokens / 1_000) * pricing.outputPer1k;
}

/**
 * Register an onResponse hook to record usage metrics per workspace.
 * Only records when workspace context is present (i.e., request included
 * X-Workspace-Id header or was authenticated with a workspace token).
 */
export function registerUsageTracking(
  app: FastifyInstance,
  options: RegisterUsageTrackingOptions,
): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.enabled) {
      return;
    }

    const workspace = request.workspace;
    if (!workspace) {
      return;
    }

    // Only record for successful proxy requests to model endpoints
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      return;
    }

    const path = request.url.split("?")[0] ?? "";
    if (!isModelRoute(path)) {
      return;
    }

    // Extract model name from request body (best-effort)
    const body = request.body as Record<string, unknown> | undefined;
    const model = typeof body?.["model"] === "string" ? body["model"] : "unknown";

    // Extract token usage from reply if available
    // The gateway doesn't always have the usage data at this point
    // (streaming responses may not), so we record what we can.
    const usage = extractUsageFromReply(reply);
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;

    options.storage.recordUsage({
      workspaceId: workspace.id,
      model,
      route: path,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: estimateCostUsd(model, promptTokens, completionTokens),
    });
  });
}

function isModelRoute(path: string): boolean {
  return (
    path === "/responses" ||
    path === "/v1/responses" ||
    path === "/v1/chat/completions" ||
    path === "/v1/messages" ||
    path === "/v1/messages/count_tokens"
  );
}

interface UsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function extractUsageFromReply(reply: FastifyReply): UsageData | undefined {
  // The Fastify reply payload may contain usage data from the upstream response.
  // For non-streaming responses, we can try to parse it.
  // This is best-effort — streaming responses won't have usage here.
  try {
    const payload = reply.raw.statusCode >= 200 && reply.raw.statusCode < 300
      ? undefined // Payload is already sent, not accessible
      : undefined;
    // In practice, Fastify's onResponse hook doesn't expose the serialized payload.
    // Usage will be recorded from the route handler where the upstream response is available.
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record usage from a route handler where the upstream response is available.
 * This is the reliable way to capture usage data.
 */
export function recordRequestUsage(
  storage: WorkspaceStorage,
  workspaceId: string,
  model: string,
  route: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): void {
  storage.recordUsage({
    workspaceId,
    model,
    route,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: estimateCostUsd(model, usage.promptTokens, usage.completionTokens),
  });
}
