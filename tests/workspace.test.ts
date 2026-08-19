import { describe, expect, it, vi, beforeEach } from "vitest";

import { InMemoryWorkspaceStorage } from "../src/workspace/storage.js";
import { roleHasPermission, scopeToRole, scopeHasPermission, userHasPermission } from "../src/workspace/rbac.js";
import { estimateCostUsd } from "../src/workspace/usage.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const baseConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider.example/v1",
  defaultModel: "glm-5.1",
  requestTimeoutMs: 30000,
  maxRetries: 0,
  maxBodySizeKb: 1024,
  healthProbeEnabled: false,
  workspace: { enabled: false },
  models: [
    {
      name: "glm-5.1",
      upstreamModel: "glm-5.1",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret-key",
      ownedBy: "zhipu",
      created: 1_718_000_000,
      supportsTools: true,
supportsStreaming: true,
inputModalities: ["text"],
outputModalities: ["text"],
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
    },
  ],
};

describe("Workspace Storage", () => {
  let storage: InMemoryWorkspaceStorage;

  beforeEach(() => {
    storage = new InMemoryWorkspaceStorage();
  });

  describe("Workspace CRUD", () => {
    it("creates a workspace", () => {
      const ws = storage.createWorkspace({
        name: "test-workspace",
        displayName: "Test Workspace",
        ownerId: "user-1",
      });

      expect(ws.id).toBeDefined();
      expect(ws.name).toBe("test-workspace");
      expect(ws.displayName).toBe("Test Workspace");
      expect(ws.ownerId).toBe("user-1");
      expect(ws.status).toBe("active");
    });

    it("lists workspaces", () => {
      storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.createWorkspace({ name: "ws2", displayName: "WS2", ownerId: "u2" });

      const list = storage.listWorkspaces();
      expect(list).toHaveLength(2);
    });

    it("updates a workspace", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const updated = storage.updateWorkspace(ws.id, { displayName: "Updated" });

      expect(updated?.displayName).toBe("Updated");
    });

    it("soft deletes a workspace", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const deleted = storage.deleteWorkspace(ws.id);

      expect(deleted).toBe(true);
      const found = storage.getWorkspace(ws.id);
      expect(found?.status).toBe("deleted");
    });
  });

  describe("Model Configuration", () => {
    it("sets and gets model config", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const config = storage.setModelConfig(ws.id, {
        allowedModels: ["glm-5.1"],
        aliases: { "my-model": "glm-5.1" },
      });

      expect(config.allowedModels).toEqual(["glm-5.1"]);
      expect(config.aliases["my-model"]).toBe("glm-5.1");

      const retrieved = storage.getModelConfig(ws.id);
      expect(retrieved?.allowedModels).toEqual(["glm-5.1"]);
    });
  });

  describe("Auth Tokens", () => {
    it("creates and validates a token", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const { token, record } = storage.createToken({
        workspaceId: ws.id,
        name: "test-token",
        scopes: ["read", "write"],
      });

      expect(token.startsWith("wks_")).toBe(true);
      expect(record.name).toBe("test-token");
      expect(record.scopes).toEqual(["read", "write"]);

      const validated = storage.validateToken(token);
      expect(validated).toBeDefined();
      expect(validated?.id).toBe(record.id);
    });

    it("rejects invalid token", () => {
      const validated = storage.validateToken("wks_invalid");
      expect(validated).toBeUndefined();
    });

    it("revokes a token", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const { token, record } = storage.createToken({
        workspaceId: ws.id,
        name: "test-token",
        scopes: ["read"],
      });

      const revoked = storage.revokeToken(ws.id, record.id);
      expect(revoked).toBe(true);

      const validated = storage.validateToken(token);
      expect(validated).toBeUndefined();
    });

    it("lists tokens", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.createToken({ workspaceId: ws.id, name: "t1", scopes: ["read"] });
      storage.createToken({ workspaceId: ws.id, name: "t2", scopes: ["write"] });

      const tokens = storage.listTokens(ws.id);
      expect(tokens).toHaveLength(2);
    });
  });

  describe("RBAC", () => {
    it("adds and lists members", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.addMember({ workspaceId: ws.id, userId: "u2", role: "member" });

      const members = storage.listMembers(ws.id);
      expect(members).toHaveLength(2); // owner + added member
    });

    it("updates member role", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.addMember({ workspaceId: ws.id, userId: "u2", role: "member" });

      const updated = storage.updateMemberRole(ws.id, "u2", "admin");
      expect(updated?.role).toBe("admin");
    });

    it("removes a member", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.addMember({ workspaceId: ws.id, userId: "u2", role: "member" });

      const removed = storage.removeMember(ws.id, "u2");
      expect(removed).toBe(true);

      const members = storage.listMembers(ws.id);
      expect(members).toHaveLength(1);
    });

    it("gets member role", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      const role = storage.getMemberRole(ws.id, "u1");
      expect(role).toBe("owner");
    });
  });

  describe("Usage Tracking", () => {
    it("records and summarizes usage", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.recordUsage({
        workspaceId: ws.id,
        model: "glm-5.1",
        route: "/v1/responses",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.001,
      });

      const summary = storage.getUsageSummary(ws.id, "2000-01-01T00:00:00Z", "2099-12-31T23:59:59Z");
      expect(summary.totalRequests).toBe(1);
      expect(summary.totalPromptTokens).toBe(100);
      expect(summary.totalCompletionTokens).toBe(50);
    });

    it("groups usage by model", () => {
      const ws = storage.createWorkspace({ name: "ws1", displayName: "WS1", ownerId: "u1" });
      storage.recordUsage({
        workspaceId: ws.id,
        model: "glm-5.1",
        route: "/v1/responses",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.001,
      });
      storage.recordUsage({
        workspaceId: ws.id,
        model: "claude-sonnet-4-5",
        route: "/v1/responses",
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        estimatedCostUsd: 0.002,
      });

      const byModel = storage.getUsageByModel(ws.id, "2000-01-01T00:00:00Z", "2099-12-31T23:59:59Z");
      expect(byModel).toHaveLength(2);
    });
  });
});

describe("RBAC Permissions", () => {
  it("owner has all permissions", () => {
    expect(roleHasPermission("owner", "workspace:admin")).toBe(true);
    expect(roleHasPermission("owner", "workspace:delete")).toBe(true);
    expect(roleHasPermission("owner", "tokens:write")).toBe(true);
  });

  it("admin cannot delete workspace", () => {
    expect(roleHasPermission("admin", "workspace:delete")).toBe(false);
    expect(roleHasPermission("admin", "workspace:admin")).toBe(false);
  });

  it("member cannot manage tokens", () => {
    expect(roleHasPermission("member", "tokens:write")).toBe(false);
    expect(roleHasPermission("member", "members:write")).toBe(false);
  });

  it("viewer is read-only", () => {
    expect(roleHasPermission("viewer", "requests:read")).toBe(true);
    expect(roleHasPermission("viewer", "requests:write")).toBe(false);
    expect(roleHasPermission("viewer", "tokens:read")).toBe(false);
  });

  it("scope maps to role correctly", () => {
    expect(scopeToRole("admin")).toBe("admin");
    expect(scopeToRole("write")).toBe("member");
    expect(scopeToRole("read")).toBe("viewer");
  });

  it("scope permission checks", () => {
    expect(scopeHasPermission("admin", "tokens:write")).toBe(true);
    expect(scopeHasPermission("write", "tokens:write")).toBe(false);
    expect(scopeHasPermission("read", "requests:read")).toBe(true);
  });
});

describe("Usage Cost Estimation", () => {
  it("estimates cost for known models", () => {
    const cost = estimateCostUsd("glm-5.1", 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });

  it("estimates minimal cost for unknown models", () => {
    const cost = estimateCostUsd("unknown-model", 1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });
});

describe("Workspace Admin API", () => {
  const workspaceConfig: AppConfig = {
    ...baseConfig,
    workspace: { enabled: true },
    gatewayAuthToken: "admin-token",
  };

  it("creates a workspace via admin API", async () => {
    const app = createApp({ config: workspaceConfig });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/workspaces",
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-ws",
          displayName: "Test Workspace",
          ownerId: "user-1",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.name).toBe("test-ws");
    } finally {
      await app.close();
    }
  });

  it("lists workspaces via admin API", async () => {
    const app = createApp({ config: workspaceConfig });

    try {
      // Create a workspace first
      await app.inject({
        method: "POST",
        url: "/admin/workspaces",
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-ws",
          displayName: "Test Workspace",
          ownerId: "user-1",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/admin/workspaces",
        headers: { "x-api-key": "admin-token" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("creates a token via admin API", async () => {
    const app = createApp({ config: workspaceConfig });

    try {
      // Create workspace
      const createResponse = await app.inject({
        method: "POST",
        url: "/admin/workspaces",
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-ws",
          displayName: "Test Workspace",
          ownerId: "user-1",
        },
      });
      const ws = createResponse.json();

      // Create token
      const tokenResponse = await app.inject({
        method: "POST",
        url: `/admin/workspaces/${ws.id}/tokens`,
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-token",
          scopes: ["read", "write"],
        },
      });

      expect(tokenResponse.statusCode).toBe(201);
      const body = tokenResponse.json();
      expect(body.token.startsWith("wks_")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects admin API without auth", async () => {
    const app = createApp({ config: workspaceConfig });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/workspaces",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("Workspace Token Auth", () => {
  const workspaceConfig: AppConfig = {
    ...baseConfig,
    workspace: { enabled: true },
    gatewayAuthToken: "admin-token",
  };

  it("authenticates with workspace token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "glm-5.1",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const app = createApp({ config: workspaceConfig, fetchFn: fetchMock as typeof fetch });

    try {
      // Create workspace
      const createResponse = await app.inject({
        method: "POST",
        url: "/admin/workspaces",
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-ws",
          displayName: "Test Workspace",
          ownerId: "user-1",
        },
      });
      const ws = createResponse.json();

      // Create token
      const tokenResponse = await app.inject({
        method: "POST",
        url: `/admin/workspaces/${ws.id}/tokens`,
        headers: { "x-api-key": "admin-token" },
        payload: {
          name: "test-token",
          scopes: ["read", "write"],
        },
      });
      const { token } = tokenResponse.json();

      // Use token to make request
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "x-api-key": token },
        payload: { input: "Hello" },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
