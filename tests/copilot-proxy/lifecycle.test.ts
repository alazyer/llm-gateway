/**
 * Phase 9 - Task 9.4: Integration tests for Copilot lifecycle
 *
 * Tests for:
 * - Connect → register → disconnect → mark inactive
 * - Reconnect → reactivate
 * - Chain status updates on Copilot model status change
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CopilotProxyModel } from "@llm-gateway/shared";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDatabase, closeDatabase } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrations/index.js";
import { allMigrations } from "../../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow } from "../../src/db/types.js";
import {
  getAllModels,
  getModelByName,
  insertModel,
  insertChain,
  getChainByName,
} from "../../src/db/repository.js";
import { CopilotProxyConnectionRegistry } from "../../src/copilot-proxy/registry.js";

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
  const now = Math.floor(Date.now() / 1000);
  return {
    upstream_model: overrides.upstream_model ?? overrides.name,
    base_url: overrides.base_url ?? "https://api.example.com",
    api_key_env: overrides.api_key_env ?? "API_KEY",
    owned_by: overrides.owned_by ?? "llm-gateway",
    created: overrides.created ?? now,
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
    updated_at: overrides.updated_at ?? now,
    ...overrides,
  };
}

function makeChain(overrides: Partial<ModelChainRow> & { name: string }): ModelChainRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    timeout_ms: overrides.timeout_ms ?? 30000,
    max_retries: overrides.max_retries ?? 0,
    chain_timeout_ms: overrides.chain_timeout_ms ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    updated_at: overrides.updated_at ?? now,
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
  tempDir = join(tmpdir(), `llm-gateway-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// Connect → register → disconnect → mark inactive
// ---------------------------------------------------------------------------

describe("Connect → register → disconnect → mark inactive", () => {
  it("inserts new models into the database when persistenceEnabled", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    const model = getModelByName("copilot-gpt-4o")!;
    expect(model).not.toBeNull();
    expect(model.source).toBe("copilot-proxy");
    expect(model.connection_id).toBe("conn-1");
    expect(model.status).toBe("active");
  });

  it("marks copilot-proxy models as inactive on disconnect", () => {
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

  it("does not persist when persistenceEnabled is false", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: false });

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    expect(getModelByName("copilot-gpt-4o")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect → reactivate
// ---------------------------------------------------------------------------

describe("Reconnect → reactivate", () => {
  it("reactivates existing inactive models on reconnect", () => {
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
});

// ---------------------------------------------------------------------------
// Chain status updates on Copilot model status change
// ---------------------------------------------------------------------------

describe("Chain status updates on Copilot model status change", () => {
  it("recalculates chains when models are registered", () => {
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

    const chain = getChainByName("fallback-chain")!;
    expect(chain.status).toBe("active");
  });

  it("recalculates affected chains on disconnect", () => {
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

    const chain = getChainByName("fallback-chain")!;
    expect(chain.status).toBe("degraded");
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
});

// ---------------------------------------------------------------------------
// Full reconnect lifecycle
// ---------------------------------------------------------------------------

describe("Full reconnect lifecycle", () => {
  it("marks models inactive on disconnect, then reactivates on reconnect", () => {
    const registry = new CopilotProxyConnectionRegistry({ persistenceEnabled: true });
    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);

    let model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.connection_id).toBe("conn-1");

    registry.removeConnection("conn-1");
    model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("inactive");

    registry.addConnection("conn-2");
    registry.replaceRegistration("conn-2", [copilotModel]);

    model = getModelByName("copilot-gpt-4o")!;
    expect(model.status).toBe("active");
    expect(model.connection_id).toBe("conn-2");
    expect(getAllModels()).toHaveLength(1);
  });

  it("recalculates chain status through disconnect and reconnect", () => {
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

    registry.addConnection("conn-1");
    registry.replaceRegistration("conn-1", [copilotModel]);
    expect(getChainByName("test-chain")!.status).toBe("active");

    registry.removeConnection("conn-1");
    expect(getChainByName("test-chain")!.status).toBe("degraded");

    registry.addConnection("conn-2");
    registry.replaceRegistration("conn-2", [copilotModel]);
    expect(getChainByName("test-chain")!.status).toBe("active");
  });
});
