/**
 * Workspace storage interface and in-memory implementation.
 * Follows the same pattern as CopilotProxyTokenStore.
 */

import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  Workspace,
  WorkspaceModelConfig,
  WorkspaceToken,
  WorkspaceToken as WorkspaceTokenType,
  TokenScope,
  WorkspaceMember,
  WorkspaceRole,
  UsageRecord,
  UsageSummary,
  UsageByModel,
  DailyUsage,
} from "./entity.js";

// ── Storage Interface ──────────────────────────────────────────────

export interface WorkspaceStorage {
  // Workspace CRUD
  createWorkspace(input: CreateWorkspaceInput): Workspace;
  getWorkspace(id: string): Workspace | undefined;
  listWorkspaces(options?: ListWorkspacesOptions): Workspace[];
  updateWorkspace(id: string, input: UpdateWorkspaceInput): Workspace | undefined;
  deleteWorkspace(id: string): boolean;

  // Model configuration
  getModelConfig(workspaceId: string): WorkspaceModelConfig | undefined;
  setModelConfig(workspaceId: string, config: WorkspaceModelConfig): WorkspaceModelConfig;

  // Auth tokens
  createToken(input: CreateTokenInput): { token: string; record: WorkspaceToken };
  listTokens(workspaceId: string): WorkspaceToken[];
  validateToken(token: string): WorkspaceToken | undefined;
  revokeToken(workspaceId: string, tokenId: string): boolean;

  // RBAC
  addMember(input: AddMemberInput): WorkspaceMember;
  listMembers(workspaceId: string): WorkspaceMember[];
  updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): WorkspaceMember | undefined;
  removeMember(workspaceId: string, userId: string): boolean;
  getMemberRole(workspaceId: string, userId: string): WorkspaceRole | undefined;

  // Usage
  recordUsage(record: Omit<UsageRecord, "timestamp">): void;
  getUsageSummary(workspaceId: string, periodStart: string, periodEnd: string): UsageSummary;
  getUsageByModel(workspaceId: string, periodStart: string, periodEnd: string): UsageByModel[];
  getDailyUsage(workspaceId: string, periodStart: string, periodEnd: string): DailyUsage[];
}

// ── Input Types ────────────────────────────────────────────────────

export interface CreateWorkspaceInput {
  name: string;
  displayName: string;
  ownerId: string;
  tags?: Record<string, string> | undefined;
}

export interface UpdateWorkspaceInput {
  name?: string | undefined;
  displayName?: string | undefined;
  status?: Workspace["status"] | undefined;
  tags?: Record<string, string> | undefined;
}

export interface ListWorkspacesOptions {
  status?: Workspace["status"] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CreateTokenInput {
  workspaceId: string;
  name: string;
  scopes: TokenScope[];
  expiresAt?: string | null | undefined;
}

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

// ── Helpers ────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createTokenValue(): string {
  return `wks_${randomBytes(24).toString("base64url")}`;
}

function randomBytes(n: number): Buffer {
  const buf = Buffer.alloc(n);
  // Use Node.js crypto.randomFillSync for synchronous random bytes
  const { randomFillSync } = require("node:crypto");
  randomFillSync(buf);
  return buf;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── In-Memory Implementation ───────────────────────────────────────

export class InMemoryWorkspaceStorage implements WorkspaceStorage {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly modelConfigs = new Map<string, WorkspaceModelConfig>();
  private readonly tokens = new Map<string, WorkspaceToken>(); // tokenHash → record
  private readonly tokenById = new Map<string, WorkspaceToken>(); // id → record (for listing/revocation)
  private readonly members = new Map<string, WorkspaceMember>(); // "wsId:userId" → member
  private readonly usageRecords: UsageRecord[] = [];

  // ── Workspace CRUD ─────────────────────────────────────────────

  public createWorkspace(input: CreateWorkspaceInput): Workspace {
    const id = randomUUID();
    const now = isoNow();
    const workspace: Workspace = {
      id,
      name: input.name,
      displayName: input.displayName,
      ownerId: input.ownerId,
      status: "active",
      tags: input.tags ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.workspaces.set(id, workspace);

    // Owner is automatically a member with owner role
    this.addMember({ workspaceId: id, userId: input.ownerId, role: "owner" });

    // Default model config: all models allowed, no aliases
    this.modelConfigs.set(id, { allowedModels: [], aliases: {} });

    return workspace;
  }

  public getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  public listWorkspaces(options?: ListWorkspacesOptions): Workspace[] {
    let results = [...this.workspaces.values()];

    if (options?.status) {
      results = results.filter((ws) => ws.status === options.status);
    }

    // Sort by creation date descending
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  public updateWorkspace(id: string, input: UpdateWorkspaceInput): Workspace | undefined {
    const existing = this.workspaces.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: Workspace = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.tags !== undefined && { tags: input.tags }),
      updatedAt: isoNow(),
    };

    this.workspaces.set(id, updated);
    return updated;
  }

  public deleteWorkspace(id: string): boolean {
    const existing = this.workspaces.get(id);
    if (!existing) {
      return false;
    }

    // Soft delete
    this.workspaces.set(id, {
      ...existing,
      status: "deleted",
      updatedAt: isoNow(),
    });

    return true;
  }

  // ── Model Configuration ────────────────────────────────────────

  public getModelConfig(workspaceId: string): WorkspaceModelConfig | undefined {
    return this.modelConfigs.get(workspaceId);
  }

  public setModelConfig(workspaceId: string, config: WorkspaceModelConfig): WorkspaceModelConfig {
    this.modelConfigs.set(workspaceId, config);
    return config;
  }

  // ── Auth Tokens ────────────────────────────────────────────────

  public createToken(input: CreateTokenInput): { token: string; record: WorkspaceToken } {
    const tokenValue = createTokenValue();
    const id = randomUUID();
    const now = isoNow();
    const record: WorkspaceToken = {
      id,
      workspaceId: input.workspaceId,
      tokenHash: hashToken(tokenValue),
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      lastUsedAt: null,
    };

    this.tokens.set(record.tokenHash, record);
    this.tokenById.set(id, record);

    return { token: tokenValue, record };
  }

  public listTokens(workspaceId: string): WorkspaceToken[] {
    const result: WorkspaceToken[] = [];
    for (const record of this.tokenById.values()) {
      if (record.workspaceId === workspaceId) {
        result.push(record);
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public validateToken(token: string): WorkspaceToken | undefined {
    const hash = hashToken(token);
    const record = this.tokens.get(hash);
    if (!record) {
      return undefined;
    }

    // Check expiration
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      this.tokens.delete(hash);
      this.tokenById.delete(record.id);
      return undefined;
    }

    // Check workspace is active
    const workspace = this.workspaces.get(record.workspaceId);
    if (!workspace || workspace.status !== "active") {
      return undefined;
    }

    // Update lastUsedAt
    const updated: WorkspaceToken = { ...record, lastUsedAt: isoNow() };
    this.tokens.set(hash, updated);
    this.tokenById.set(record.id, updated);

    return updated;
  }

  public revokeToken(workspaceId: string, tokenId: string): boolean {
    const record = this.tokenById.get(tokenId);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }

    this.tokens.delete(record.tokenHash);
    this.tokenById.delete(tokenId);
    return true;
  }

  // ── RBAC ───────────────────────────────────────────────────────

  private memberKey(workspaceId: string, userId: string): string {
    return `${workspaceId}:${userId}`;
  }

  public addMember(input: AddMemberInput): WorkspaceMember {
    const key = this.memberKey(input.workspaceId, input.userId);
    const member: WorkspaceMember = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      addedAt: isoNow(),
    };

    this.members.set(key, member);
    return member;
  }

  public listMembers(workspaceId: string): WorkspaceMember[] {
    const result: WorkspaceMember[] = [];
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId) {
        result.push(member);
      }
    }
    return result;
  }

  public updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): WorkspaceMember | undefined {
    const key = this.memberKey(workspaceId, userId);
    const existing = this.members.get(key);
    if (!existing) {
      return undefined;
    }

    const updated: WorkspaceMember = { ...existing, role };
    this.members.set(key, updated);
    return updated;
  }

  public removeMember(workspaceId: string, userId: string): boolean {
    const key = this.memberKey(workspaceId, userId);
    return this.members.delete(key);
  }

  public getMemberRole(workspaceId: string, userId: string): WorkspaceRole | undefined {
    return this.members.get(this.memberKey(workspaceId, userId))?.role;
  }

  // ── Usage Tracking ─────────────────────────────────────────────

  public recordUsage(record: Omit<UsageRecord, "timestamp">): void {
    this.usageRecords.push({ ...record, timestamp: isoNow() });
  }

  public getUsageSummary(workspaceId: string, periodStart: string, periodEnd: string): UsageSummary {
    const records = this.filterRecords(workspaceId, periodStart, periodEnd);
    return {
      workspaceId,
      totalRequests: records.length,
      totalPromptTokens: records.reduce((sum, r) => sum + r.promptTokens, 0),
      totalCompletionTokens: records.reduce((sum, r) => sum + r.completionTokens, 0),
      totalTokens: records.reduce((sum, r) => sum + r.totalTokens, 0),
      estimatedCostUsd: records.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
      periodStart,
      periodEnd,
    };
  }

  public getUsageByModel(workspaceId: string, periodStart: string, periodEnd: string): UsageByModel[] {
    const records = this.filterRecords(workspaceId, periodStart, periodEnd);
    const byModel = new Map<string, UsageByModel>();

    for (const r of records) {
      const existing = byModel.get(r.model) ?? {
        model: r.model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };
      existing.requests += 1;
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      existing.estimatedCostUsd += r.estimatedCostUsd;
      byModel.set(r.model, existing);
    }

    return [...byModel.values()].sort((a, b) => b.requests - a.requests);
  }

  public getDailyUsage(workspaceId: string, periodStart: string, periodEnd: string): DailyUsage[] {
    const records = this.filterRecords(workspaceId, periodStart, periodEnd);
    const byDay = new Map<string, DailyUsage>();

    for (const r of records) {
      const date = r.timestamp.slice(0, 10); // YYYY-MM-DD
      const existing = byDay.get(date) ?? {
        date,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };
      existing.requests += 1;
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      existing.estimatedCostUsd += r.estimatedCostUsd;
      byDay.set(date, existing);
    }

    return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  private filterRecords(workspaceId: string, periodStart: string, periodEnd: string): UsageRecord[] {
    return this.usageRecords.filter(
      (r) =>
        r.workspaceId === workspaceId &&
        r.timestamp >= periodStart &&
        r.timestamp <= periodEnd,
    );
  }
}
