import * as vscode from "vscode";
import type {
  CopilotProxyExtensionMessage,
  CopilotProxyModel,
  CopilotProxyRequestMessage,
} from "@llm-gateway/shared";

import { toGatewayModel } from "./model-registry.js";
import type { ExtensionLogger } from "./logger.js";
import { adaptLanguageModelStreamPart } from "./stream-adapter.js";

type SendExtensionMessage = (message: CopilotProxyExtensionMessage) => void;

interface DiscoverModelsOptions {
  reason?: string;
  log?: boolean;
}

export class CopilotBridge {
  private readonly activeRequests = new Map<string, vscode.CancellationTokenSource>();
  private readonly models = new Map<string, vscode.LanguageModelChat>();

  public constructor(private readonly logger?: ExtensionLogger) {}

  public async discoverModels(options: DiscoverModelsOptions = {}): Promise<CopilotProxyModel[]> {
    const shouldLog = options.log ?? true;
    const reason = options.reason ? ` for ${options.reason}` : "";
    if (shouldLog) {
      this.logger?.info(`Discovering Copilot language models${reason}.`);
    }

    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    this.models.clear();

    const gatewayModels = models.map((model) => {
      const gatewayModel = toGatewayModel(model);
      this.models.set(gatewayModel.id, model);
      return gatewayModel;
    });

    if (shouldLog) {
      this.logger?.info(`Discovered ${gatewayModels.length} Copilot language model(s)${reason}.`);
    }

    return gatewayModels;
  }

  public async executeRequest(
    request: CopilotProxyRequestMessage,
    send: SendExtensionMessage,
  ): Promise<void> {
    this.logger?.info(
      `Starting Copilot request ${request.id}: model=${request.model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}.`,
    );

    if (request.tools && request.tools.length > 0) {
      this.logger?.warn(
        `Rejecting Copilot request ${request.id}: ${request.tools.length} tool(s) requested but tool support is disabled.`,
      );
      send({
        type: "stream_error",
        id: request.id,
        partial: false,
        error: {
          code: "tools_unsupported",
          message: "This Copilot bridge does not currently advertise tool support.",
          status: 400,
        },
      });
      return;
    }

    const model = await this.getModel(request.model);
    if (!model) {
      this.logger?.warn(
        `Rejecting Copilot request ${request.id}: model ${request.model} is unavailable.`,
      );
      send({
        type: "stream_error",
        id: request.id,
        partial: false,
        error: {
          code: "model_unavailable",
          message: `Copilot model ${request.model} is unavailable.`,
          status: 503,
          retryable: true,
        },
      });
      return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.activeRequests.set(request.id, cancellation);
    let partial = false;
    let streamParts = 0;

    try {
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        justification: "Proxy a user-authorized llm-gateway request through VS Code Copilot.",
      };
      if (request.params) {
        requestOptions.modelOptions = request.params;
      }

      const response = await model.sendRequest(
        request.messages.map(toLanguageModelMessage),
        requestOptions,
        cancellation.token,
      );

      for await (const part of response.stream) {
        const delta = adaptLanguageModelStreamPart(request.id, part);
        if (delta) {
          partial = true;
          streamParts += 1;
          send(delta);
        }
      }

      send({
        type: "stream_done",
        id: request.id,
      });
      this.logger?.info(
        `Completed Copilot request ${request.id}: streamed ${streamParts} part(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Copilot request ${request.id} failed: ${message}`);
      send({
        type: "stream_error",
        id: request.id,
        partial,
        error: {
          code: "copilot_request_failed",
          message,
          status: 502,
          retryable: false,
        },
      });
    } finally {
      this.activeRequests.delete(request.id);
      cancellation.dispose();
    }
  }

  public cancel(id: string): void {
    const cancellation = this.activeRequests.get(id);
    if (!cancellation) {
      this.logger?.warn(`Cancellation requested for unknown Copilot request ${id}.`);
      return;
    }

    this.logger?.info(`Cancelling Copilot request ${id}.`);
    cancellation.cancel();
  }

  private async getModel(id: string): Promise<vscode.LanguageModelChat | undefined> {
    const cached = this.models.get(id);
    if (cached) {
      return cached;
    }

    await this.discoverModels();
    return this.models.get(id);
  }
}

function toLanguageModelMessage(
  message: CopilotProxyRequestMessage["messages"][number],
): vscode.LanguageModelChatMessage {
  if (message.role === "assistant") {
    return vscode.LanguageModelChatMessage.Assistant(message.content);
  }

  return vscode.LanguageModelChatMessage.User(message.content);
}
