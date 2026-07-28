/**
 * Workspace entity definitions for multi-tenant support.
 */

export type WorkspaceStatus = "active" | "suspended" | "deleted";

export interface Workspace {
  id: string;
  name: string;
  displayName: string;
  ownerId: string;
  status: WorkspaceStatus;
  tags: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceModelConfig {
  /** List of allowed model names. Empty means all global models are allowed. */
  allowedModels: string[];
  /** Model alias mappings: alias → target model name. */
  aliases: Record<string, string>;
}

export type TokenScope = "read" | "write" | "admin";

export interface WorkspaceToken {
  id: string;
  workspaceId: string;
  tokenHash: string;
  name: string;
  scopes: TokenScope[];
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  addedAt: string;
}

export interface UsageRecord {
  workspaceId: string;
  model: string;
  route: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: string;
}

export interface UsageSummary {
  workspaceId: string;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  periodStart: string;
  periodEnd: string;
}

export interface UsageByModel {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface DailyUsage {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}
