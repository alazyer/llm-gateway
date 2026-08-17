import type {
  CopilotProxyGatewayMessage,
  CopilotProxyModel,
  CopilotProxyRequestMessage,
  CopilotProxyStreamDeltaMessage,
  CopilotProxyStreamDoneMessage,
  CopilotProxyStreamErrorMessage,
} from "@llm-gateway/shared";
import type { ModelRow } from "../db/types.js";
import {
  reactivateOrInsertModel,
  updateModelStatus,
  getModelsByConnection,
  getChainsReferencingModel,
  recalculateChainStatus,
} from "../db/repository.js";

export interface RegisteredCopilotProxyModel extends CopilotProxyModel {
  connectionId: string;
  created: number;
}

export interface ChannelInfo {
  prefix: string;
  connectionCount: number;
  modelIds: string[];
}

interface CopilotProxyConnection {
  id: string;
  status: "healthy" | "unhealthy" | "closing";
  registeredAt: number;
  inFlight: number;
  models: Map<string, CopilotProxyModel>;
  sendMessage?: (message: CopilotProxyGatewayMessage) => void;
}

export type CopilotProxyStreamMessage =
  | CopilotProxyStreamDeltaMessage
  | CopilotProxyStreamDoneMessage
  | CopilotProxyStreamErrorMessage;

export interface CopilotProxyRequestHandle {
  connectionId: string;
  events: AsyncIterable<CopilotProxyStreamMessage>;
  cancel(): void;
}

interface PendingCopilotProxyRequest {
  connectionId: string;
  queue: AsyncMessageQueue<CopilotProxyStreamMessage>;
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  public push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) {
          return Promise.resolve({ value, done: false });
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

export function findMatchingPrefix(modelId: string, allowedPrefixes: readonly string[]): string | undefined {
  return allowedPrefixes.find((prefix) => modelId.startsWith(prefix));
}

function assertValidModel(model: CopilotProxyModel, allowedPrefixes: readonly string[]): void {
  const matchingPrefix = findMatchingPrefix(model.id, allowedPrefixes);
  if (!matchingPrefix) {
    throw new Error(
      `Copilot proxy model id \`${model.id}\` does not match any allowed prefix: [${allowedPrefixes.join(", ")}].`,
    );
  }

  if (model.source !== matchingPrefix) {
    throw new Error(
      `Copilot proxy model \`${model.id}\` must use source \`${matchingPrefix}\` (got \`${model.source}\`).`,
    );
  }
}

export class CopilotProxyConnectionRegistry {
  private readonly connections = new Map<string, CopilotProxyConnection>();
  private readonly pendingRequests = new Map<string, PendingCopilotProxyRequest>();
  private readonly allowedPrefixes: readonly string[];
  private readonly persistenceEnabled: boolean;

  public constructor(
    options: { allowedPrefixes?: readonly string[]; persistenceEnabled?: boolean } = {},
  ) {
    this.allowedPrefixes = options.allowedPrefixes ?? ["copilot-"];
    this.persistenceEnabled = options.persistenceEnabled ?? false;
  }

  public addConnection(
    connectionId: string,
    sendMessage?: (message: CopilotProxyGatewayMessage) => void,
    now: Date = new Date(),
  ): void {
    this.connections.set(connectionId, {
      id: connectionId,
      status: "healthy",
      registeredAt: Math.floor(now.getTime() / 1000),
      inFlight: 0,
      models: new Map(),
      ...(sendMessage ? { sendMessage } : {}),
    });
  }

  public removeConnection(connectionId: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.connectionId === connectionId) {
        pending.queue.push({
          type: "stream_error",
          id: requestId,
          partial: true,
          error: {
            code: "copilot_proxy_connection_closed",
            message: "Copilot proxy extension disconnected before the request completed.",
            status: 503,
            retryable: true,
          },
        });
        pending.queue.close();
        this.pendingRequests.delete(requestId);
      }
    }

    // Mark models as inactive and recalculate affected chains (Phase 5).
    if (this.persistenceEnabled) {
      this.persistDisconnect(connectionId);
    }

    this.connections.delete(connectionId);
  }

  public markHealthy(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = "healthy";
    }
  }

  public markUnhealthy(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = "unhealthy";
    }
  }

  public markClosing(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = "closing";
    }
  }

  public replaceRegistration(connectionId: string, models: CopilotProxyModel[]): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Copilot proxy connection \`${connectionId}\` is not registered.`);
    }

    const replacement = new Map<string, CopilotProxyModel>();
    for (const model of models) {
      assertValidModel(model, this.allowedPrefixes);
      replacement.set(model.id, model);
    }

    connection.models = replacement;
    connection.status = "healthy";

    // Persist model reactivation/insertion (Phase 5).
    if (this.persistenceEnabled) {
      this.persistRegistration(connectionId, models);
    }
  }

  public clearRegistration(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.models.clear();
    }
  }

  public listModels(): RegisteredCopilotProxyModel[] {
    const deduped = new Map<string, RegisteredCopilotProxyModel>();

    for (const connection of this.connections.values()) {
      if (connection.status !== "healthy") {
        continue;
      }

      for (const model of connection.models.values()) {
        if (!deduped.has(model.id)) {
          deduped.set(model.id, {
            ...model,
            connectionId: connection.id,
            created: connection.registeredAt,
          });
        }
      }
    }

    return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public findModel(modelId: string): RegisteredCopilotProxyModel | undefined {
    return this.listModels().find((model) => model.id === modelId);
  }

  public selectConnectionForModel(modelId: string): string | undefined {
    const candidates = [...this.connections.values()].filter(
      (connection) => connection.status === "healthy" && connection.models.has(modelId),
    );

    candidates.sort((left, right) => left.inFlight - right.inFlight);
    return candidates[0]?.id;
  }

  public incrementInFlight(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.inFlight += 1;
    }
  }

  public decrementInFlight(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection && connection.inFlight > 0) {
      connection.inFlight -= 1;
    }
  }

  public dispatchRequest(
    request: CopilotProxyRequestMessage,
  ): CopilotProxyRequestHandle | undefined {
    const connectionId = this.selectConnectionForModel(request.model);
    if (!connectionId) {
      return undefined;
    }

    const connection = this.connections.get(connectionId);
    if (!connection?.sendMessage) {
      return undefined;
    }

    const queue = new AsyncMessageQueue<CopilotProxyStreamMessage>();
    this.pendingRequests.set(request.id, { connectionId, queue });
    this.incrementInFlight(connectionId);
    connection.sendMessage(request);

    return {
      connectionId,
      events: queue,
      cancel: () => {
        connection.sendMessage?.({
          type: "cancel",
          id: request.id,
        });
        this.completePendingRequest(request.id);
      },
    };
  }

  public handleStreamMessage(
    connectionId: string,
    message: CopilotProxyStreamMessage,
  ): boolean {
    const pending = this.pendingRequests.get(message.id);
    if (!pending || pending.connectionId !== connectionId) {
      return false;
    }

    pending.queue.push(message);

    if (message.type === "stream_done" || message.type === "stream_error") {
      this.completePendingRequest(message.id);
    }

    return true;
  }

  public getChannelsInfo(): ChannelInfo[] {
    const prefixMap = new Map<string, { connectionCount: number; modelIds: Set<string> }>();

    for (const prefix of this.allowedPrefixes) {
      prefixMap.set(prefix, { connectionCount: 0, modelIds: new Set() });
    }

    for (const connection of this.connections.values()) {
      if (connection.status !== "healthy") {
        continue;
      }

      const connectionPrefixes = new Set<string>();
      for (const model of connection.models.values()) {
        const matchingPrefix = findMatchingPrefix(model.id, this.allowedPrefixes);
        if (matchingPrefix) {
          connectionPrefixes.add(matchingPrefix);
          prefixMap.get(matchingPrefix)?.modelIds.add(model.id);
        }
      }

      for (const prefix of connectionPrefixes) {
        const entry = prefixMap.get(prefix);
        if (entry) {
          entry.connectionCount += 1;
        }
      }
    }

    return [...prefixMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([prefix, info]) => ({
        prefix,
        connectionCount: info.connectionCount,
        modelIds: [...info.modelIds].sort(),
      }));
  }

  private completePendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    pending.queue.close();
    this.pendingRequests.delete(requestId);
    this.decrementInFlight(pending.connectionId);
  }

  /**
   * Persist model registration/reactivation to the database.
   * Called from `replaceRegistration` when persistence is enabled.
   */
  private persistRegistration(connectionId: string, models: CopilotProxyModel[]): void {
    const now = Math.floor(Date.now() / 1000);

    for (const model of models) {
      const modelRow: ModelRow = {
        name: model.id,
        upstream_model: model.native_id,
        base_url: "",
        api_key_env: "",
        owned_by: "copilot-proxy",
        created: now,
        supports_tools: model.capabilities.supports_tools ? 1 : 0,
        supports_streaming: model.capabilities.supports_streaming ? 1 : 0,
        // Copilot proxy registrations do not declare image input today; default
        // to text-only. `createCopilotModelRecord` derives input_modalities from
        // this column (see src/routes/responses.ts).
        supports_image_input: 0,
        unknown_field_mode: "warn",
        unknown_field_window_requests: 100,
        source: "copilot-proxy",
        source_prefix: model.source,
        connection_id: connectionId,
        status: "active",
        status_reason: "Copilot proxy registered",
        status_changed_at: now,
        capabilities_json: JSON.stringify(model.capabilities),
        updated_at: now,
      };

      try {
        reactivateOrInsertModel(modelRow);

        // Recalculate chains that reference this model.
        const chainNames = getChainsReferencingModel(model.id);
        for (const chainName of chainNames) {
          recalculateChainStatus(chainName);
        }
      } catch (error) {
        console.error(
          `[registry] Failed to persist model registration for ${model.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Mark all models belonging to a connection as inactive and
   * recalculate affected chain statuses.
   * Called from `removeConnection` when persistence is enabled.
   */
  private persistDisconnect(connectionId: string): void {
    try {
      const models = getModelsByConnection(connectionId);
      const affectedChains = new Set<string>();

      for (const model of models) {
        // Only mark copilot-proxy models as inactive (not static models).
        if (model.source !== "copilot-proxy") {
          continue;
        }

        updateModelStatus(model.name, "inactive", "Copilot proxy connection closed");

        // Collect chains that need recalculation.
        const chainNames = getChainsReferencingModel(model.name);
        for (const chainName of chainNames) {
          affectedChains.add(chainName);
        }
      }

      // Recalculate all affected chains.
      for (const chainName of affectedChains) {
        recalculateChainStatus(chainName);
      }
    } catch (error) {
      console.error(
        `[registry] Failed to persist disconnect for connection ${connectionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
