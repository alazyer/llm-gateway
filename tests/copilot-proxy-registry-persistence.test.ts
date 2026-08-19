/**
 * Phase 5 tests: Copilot proxy registry persistence integration.
 *
 * Tests that `replaceRegistration` and `removeConnection` correctly
 * persist model status to the database when `persistenceEnabled` is true,
 * and that affected chains are recalculated.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CopilotProxyModel } from "@llm-gateway/shared";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { openDatabase, closeDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow } from "../src/db/types.js";
import {
  getAllModels,
  getModelByName,
  insertModel,
  insertChain,
  getChainByName,
  getModelsByConnection,
  updateModelStatus,
  recalculateChainStatus,
} from "../src/db/repository.js";
import { CopilotProxyConnectionRegistry } from "../src/copilot-proxy/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const copilotModel: CopilotProxyModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

const copilotModel2: CopilotProxyModel = {
  id: "copilot-claude-3",
  name: "Claude 3 via Copilot",
  native_id: "claude-3-opus",
  source: "copilot-",
  capabilities: {
    supports_streaming: true,
    supports_tools: false,
    supports_usage: true,
    supports_progress: false,
  },
};

function makeModel(overrides: Partial<ModelRow> & { name: string }): ModelRow {
  return {
    upstream_model: overrides.upstream_model ?? overrides.name,
    base_url: overrides.base_url ?? "https://api.example.com",
    api_key_env: overrides.api_key_env ?? "API_KEY",
    owned_by: overrides.owned_by ?? "llm-gateway",
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    supports_tools: overrides.supports_tools ?? 1,
    supports_streaming: overrides.supports_streaming ?? 1,
    input_modalities: overrides.input_modalities ?? "text",
    output_modalities: overrides.output_modalities ?? "text",
    unknown_field_mode: overrides.unknown_field_mode ?? "warn",
    unknown_field_window_requests: overrides.unknown_field_window_requests ?? 100,
    source: overrides.source ?? null,
    source_prefix: overrides.source_prefix ?? null,
    connection_id: overrides.connection_id ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    capabilities_json: overrides.capabilities_json ?? null,
    updated_at: overrides.updated_at ?? Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeChain(overrides: Partial<ModelChainRow> & { name: string }): ModelChainRow {
  return {
    timeout_ms: overrides.timeout_ms ?? 30000,
    max_retries: overrides.max_retries ?? 0,
    chain_timeout_ms: overrides.chain_timeout_ms ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    updated_at: overrides.updated_at ?? Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeChainModel(overrides: Partial<ChainModelRow> & { chain_name: string; position: number; model_name: string }): ChainModelRow {
  return {
    timeout_ms: overrides.timeout_ms ?? null,
    max_retries: overrides.max_retries ?? null,
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-persistence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(db, allMigrations);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 5 — replaceRegistration persistence tests
// ---------------------------------------------------------------------------

describe("Phase 5: replaceRegistration persistence", () => {
  it("inserts new models into the database when persistenceEnabled", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    const model = getModelByName("copilot-gpt-4o")!;
    expect(model).not.toBeNull();
    expect(model.source).toBe("copilot-proxy");
    expect(model.source_prefix).toBe("copilot-");
    expect(model.connection_id).toBe("conn-1");
    expect(model.status).toBe("active");
    expect(model.capabilities_json).toContain("supports_streaming");
  });

  it("reactivates existing inactive models on reconnect", () => {
    // Pre-insert an inactive copilot-proxy model.
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-old",
      status: "inactive",
      status_reason: "Copilot proxy connection closed",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-new");
    registry.replaceRegistration("conn-new", [copilotModel]);

    const model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.status_reason).toBe("Copilot proxy reconnected");
    expect(model.connection_id).toBe("conn-new");
    // Should not have created a duplicate.
    expect(getAllModels()).toHaveLength(1);
  });

  it("updates connection for already-active models", () => {
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-old",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-new");
    registry.replaceRegistration("conn-new", [copilotModel]);

    const model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.connection_id).toBe("conn-new");
    expect(getAllModels()).toHaveLength(1);
  });

  it("persists multiple models in one registration", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel, copilotModel2]);

    const models = getAllModels();
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.name).sort()).toEqual(["copilot-claude-3", "copilot-gpt-4o"]);
    for (const m of models) {
      expect(m.source).toBe("copilot-proxy");
      expect(m.connection_id).toBe("conn-1");
    }
  });

  it("recalculates chains when models are registered", () => {
    // Create a chain referencing the copilot model (currently inactive).
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      status: "inactive",
      status_reason: "Copilot proxy connection closed",
    }));
    insertModel(makeModel({ name: "static-model", status: "active" }));
    insertChain(makeChain({ name: "fallback-chain", status: "degraded" }), [
      makeChainModel({ chain_name: "fallback-chain", position: 0, model_name: "copilot-gpt-4o" }),
      makeChainModel({ chain_name: "fallback-chain", position: 1, model_name: "static-model" }),
    ]);

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    // Chain should now be active since both models are active.
    const chain = getChainByName("fallback-chain")!;
    expect(chain.status).toBe("active");
  });

  it("does not persist when persistenceEnabled is false", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: false });

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    // No database entries should exist.
    expect(getModelByName("copilot-gpt-4o")).toBeNull();
  });

  it("does not persist when persistenceEnabled is not specified (default)", () => {
    const registry = new CopilotProxyConnectionRegistry();

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    expect(getModelByName("copilot-gpt-4o")).toBeNull();
  });

  it("continues to work even if a model persist fails (error in one model)", () => {
    // Pre-insert a static model with the same name — will cause a PRIMARY KEY conflict.
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "static",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");

    // This should not throw — the error is caught and logged internally.
    expect(() => registry.replaceRegistration("conn-1", [copilotModel])).not.toThrow();

    // The in-memory registry should still have the model.
    expect(registry.findModel("copilot-gpt-4o")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — removeConnection persistence tests
// ---------------------------------------------------------------------------

describe("Phase 5: removeConnection persistence", () => {
  it("marks copilot-proxy models as inactive on disconnect", () => {
    // Pre-insert active copilot-proxy models.
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);
    registry.removeConnection("conn-1");

    const model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("inactive");
    expect(model.status_reason).toBe("Copilot proxy connection closed");
  });

  it("recalculates affected chains on disconnect", () => {
    // Set up: active copilot model in a chain.
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));
    insertModel(makeModel({ name: "static-model", status: "active" }));
    insertChain(makeChain({ name: "fallback-chain", status: "active" }), [
      makeChainModel({ chain_name: "fallback-chain", position: 0, model_name: "copilot-gpt-4o" }),
      makeChainModel({ chain_name: "fallback-chain", position: 1, model_name: "static-model" }),
    ]);

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);
    registry.removeConnection("conn-1");

    // Chain should now be degraded (one model inactive).
    const chain = getChainByName("fallback-chain")!;
    expect(chain.status).toBe("degraded");
    expect(chain.status_reason).toContain("1 of 2 models inactive");
  });

  it("sets chain to inactive when all models go inactive on disconnect", () => {
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));
    insertChain(makeChain({ name: "copilot-chain", status: "active" }), [
      makeChainModel({ chain_name: "copilot-chain", position: 0, model_name: "copilot-gpt-4o" }),
    ]);

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);
    registry.removeConnection("conn-1");

    const chain = getChainByName("copilot-chain")!;
    expect(chain.status).toBe("inactive");
  });

  it("marks multiple models inactive from the same connection", () => {
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));
    insertModel(makeModel({
      name: "copilot-claude-3",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel, copilotModel2]);
    registry.removeConnection("conn-1");

    expect(getModelByName("copilot-gpt-4o")!.status).toBe("inactive");
    expect(getModelByName("copilot-claude-3")!.status).toBe("inactive");
  });

  it("does not mark static models as inactive on disconnect", () => {
    // A static model that happens to have the same connection_id should not be affected.
    insertModel(makeModel({
      name: "static-model",
      source: "static",
      connection_id: "conn-1",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.removeConnection("conn-1");

    // The static model should still be active.
    expect(getModelByName("static-model")!.status).toBe("active");
  });

  it("does not persist disconnect when persistenceEnabled is false", () => {
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
    }));

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: false });
    registry.addConnection("conn-1");
    registry.removeConnection("conn-1");

    // The model should still be active in the database.
    expect(getModelByName("copilot-gpt-4o")!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — Reconnect lifecycle test
// ---------------------------------------------------------------------------

describe("Phase 5: Full reconnect lifecycle", () => {
  it("marks models inactive on disconnect, then reactivates on reconnect", () => {
    // Register a connection.
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    // Verify model is active.
    let model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.connection_id).toBe("conn-1");

    // Disconnect.
    registry.removeConnection("conn-1");
    model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("inactive");
    expect(model.status_reason).toBe("Copilot proxy connection closed");

    // Reconnect with new connection ID.
    registry.addConnection("conn-2");
    registry.replaceRegistration("conn-2", [copilotModel]);

    model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.status_reason).toBe("Copilot proxy reconnected");
    expect(model.connection_id).toBe("conn-2");

    // No duplicate rows.
    expect(getAllModels()).toHaveLength(1);
  });

  it("recalculates chain status through disconnect and reconnect", () => {
    // Pre-insert both models so the chain's FK constraints are satisfied.
    insertModel(makeModel({
      name: "copilot-gpt-4o",
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-old",
      status: "inactive",
      status_reason: "Previous session ended",
    }));
    insertModel(makeModel({ name: "static-model", status: "active" }));
    insertChain(makeChain({ name: "test-chain", status: "degraded" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "copilot-gpt-4o" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "static-model" }),
    ]);

    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });

    // Connect: both models active → chain active.
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);
    expect(getChainByName("test-chain")!.status).toBe("active");

    // Disconnect: one model inactive → chain degraded.
    registry.removeConnection("conn-1");
    expect(getChainByName("test-chain")!.status).toBe("degraded");

    // Reconnect: both models active again → chain active.
    registry.addConnection("conn-2");
    registry.replaceRegistration("conn-2", [copilotModel]);
    expect(getChainByName("test-chain")!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — Status transition logging tests
// ---------------------------------------------------------------------------

describe("Phase 5: Status transition logging", () => {
  it("logs model status transitions via updateModelStatus", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    insertModel(makeModel({ name: "test-model", status: "active" }));
    updateModelStatus("test-model", "inactive", "Testing log");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[db] Model status transition: name=test-model old_status=active new_status=inactive"),
    );

    logSpy.mockRestore();
  });

  it("logs chain status transitions via recalculateChainStatus", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Down" }));
    insertChain(makeChain({ name: "test-chain", status: "active" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
    ]);

    recalculateChainStatus("test-chain");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[db] Chain status transition: name=test-chain old_status=active new_status=degraded"),
    );

    logSpy.mockRestore();
  });
});
