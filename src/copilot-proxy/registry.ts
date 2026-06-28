import type {
  CopilotProxyGatewayMessage,
  CopilotProxyModel,
  CopilotProxyRequestMessage,
  CopilotProxyStreamDeltaMessage,
  CopilotProxyStreamDoneMessage,
  CopilotProxyStreamErrorMessage,
} from "@llm-gateway/shared";

export interface RegisteredCopilotProxyModel extends CopilotProxyModel {
  connectionId: string;
  created: number;
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

function assertValidModel(model: CopilotProxyModel): void {
  if (!model.id.startsWith("copilot-")) {
    throw new Error(`Copilot proxy model id \`${model.id}\` must use the copilot- prefix.`);
  }

  if (model.source !== "copilot-proxy") {
    throw new Error(`Copilot proxy model \`${model.id}\` must use source copilot-proxy.`);
  }
}

export class CopilotProxyConnectionRegistry {
  private readonly connections = new Map<string, CopilotProxyConnection>();
  private readonly pendingRequests = new Map<string, PendingCopilotProxyRequest>();

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
      assertValidModel(model);
      replacement.set(model.id, model);
    }

    connection.models = replacement;
    connection.status = "healthy";
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

  private completePendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    pending.queue.close();
    this.pendingRequests.delete(requestId);
    this.decrementInFlight(pending.connectionId);
  }
}
