import * as vscode from "vscode";
import type {
  CopilotProxyExtensionMessage,
  CopilotProxyModel,
  CopilotProxyRequestMessage,
  CopilotProxyTool,
  CopilotProxyToolChoice,
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

  public constructor(
    private readonly modelPrefix: string = "copilot-",
    private readonly logger?: ExtensionLogger,
  ) {}

  public async discoverModels(options: DiscoverModelsOptions = {}): Promise<CopilotProxyModel[]> {
    const shouldLog = options.log ?? true;
    const reason = options.reason ? ` for ${options.reason}` : "";
    if (shouldLog) {
      this.logger?.info(`Discovering Copilot language models${reason}.`);
    }

    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    this.models.clear();

    const gatewayModels = models.map((model) => {
      const gatewayModel = toGatewayModel(model, this.modelPrefix);
      this.models.set(gatewayModel.id, model);
      return gatewayModel;
    });

    if (shouldLog) {
      this.logger?.info(`Discovered ${gatewayModels.length} Copilot language model(s)${reason}.`);
      this.logger?.debug(
        `Discovered Copilot model IDs${reason}: ${gatewayModels.map((model) => model.id).join(", ") || "none"}.`,
      );
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
    const startedAt = Date.now();

    try {
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        justification: "Proxy a user-authorized llm-gateway request through VS Code Copilot.",
      };
      if (request.params) {
        requestOptions.modelOptions = request.params;
      }
      if (request.tools && request.tools.length > 0) {
        requestOptions.tools = request.tools.map(toLanguageModelChatTool);
        const toolMode = toLanguageModelToolMode(request.params?.tool_choice);
        if (toolMode !== undefined) {
          requestOptions.toolMode = toolMode;
        }
      }
      this.logger?.debug(
        `Copilot request ${request.id} options: hasParams=${request.params ? "true" : "false"}, hasTools=${request.tools ? "true" : "false"}, toolMode=${requestOptions.toolMode ?? "default"}, activeRequests=${this.activeRequests.size}.`,
      );

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
      this.logger?.debug(`Copilot request ${request.id} durationMs=${Date.now() - startedAt}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Copilot request ${request.id} failed: ${message}`);
      this.logger?.debug(
        `Copilot request ${request.id} failed after ${Date.now() - startedAt}ms with partial=${partial}.`,
      );
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
    if (message.tool_calls && message.tool_calls.length > 0) {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      if (message.content) {
        parts.push(new vscode.LanguageModelTextPart(message.content));
      }
      for (const toolCall of message.tool_calls) {
        let input: object;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = {};
        }
        parts.push(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, input));
      }
      return vscode.LanguageModelChatMessage.Assistant(parts);
    }
    return vscode.LanguageModelChatMessage.Assistant(message.content);
  }

  // Tool-result messages: In a multi-turn tool conversation, after the model
  // emits a LanguageModelToolCallPart (assistant role, tool_calls), the external
  // tool responds with a tool-result message (role: "tool", tool_call_id
  // matching the call's id, content with the result). This must be converted to
  // a LanguageModelToolResultPart so the model can correlate the result with
  // the original tool call in the next sendRequest() message history.
  //
  // The tool_call_id is essential — it links the result back to the specific
  // tool invocation the model made. Without it, the model cannot determine
  // which tool call the result belongs to. The gateway protocol requires
  // tool_call_id on tool-role messages; the fallback to "" is a safety net for
  // malformed messages but will produce incorrect model behavior if hit.
  if (message.role === "tool") {
    const toolCallId = message.tool_call_id ?? "";
    if (!message.tool_call_id) {
      // Log a warning — tool results without a call ID cannot be correctly
      // correlated. This should not happen per the gateway protocol but we
      // handle it gracefully rather than dropping the message entirely.
      // eslint-disable-next-line no-console -- bridge logger not available in pure function
      console.warn(
        `Tool-result message missing tool_call_id; mapping with empty ID. ` +
        `This will likely cause incorrect multi-turn tool conversation behavior.`,
      );
    }
    const resultContent = [
      new vscode.LanguageModelTextPart(message.content),
    ];
    const resultPart = new vscode.LanguageModelToolResultPart(
      toolCallId,
      resultContent,
    );
    return vscode.LanguageModelChatMessage.User([resultPart]);
  }

  // System-role and developer-role messages: The stable vscode.lm API provides
  // only User() and Assistant() factories on LanguageModelChatMessage — there is
  // no System() or Developer() factory. The languageModelSystem proposed API
  // would add proper system-role support, but using it requires
  // enabledApiProposals which blocks Marketplace publishing. As a stable-API
  // workaround, both system and developer messages are mapped to User()
  // messages. This is effective for most instruction-following scenarios since
  // Copilot models treat User messages with instruction-like content similarly
  // to system/developer prompts. The "developer" role (OpenAI-style) conveys
  // developer-level instructions that override system-level ones; in the
  // stable-API mapping, they are treated identically to system messages. If
  // languageModelSystem becomes stable in a future VS Code release, this
  // mapping should be upgraded to use System() messages directly.
  if (message.role === "system" || message.role === "developer") {
    return vscode.LanguageModelChatMessage.User(message.content);
  }

  return vscode.LanguageModelChatMessage.User(message.content);
}

function toLanguageModelChatTool(tool: CopilotProxyTool): vscode.LanguageModelChatTool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: tool.function.parameters,
  };
}

function toLanguageModelToolMode(
  toolChoice?: CopilotProxyToolChoice,
): vscode.LanguageModelChatToolMode | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }

  if (toolChoice === "auto") {
    return vscode.LanguageModelChatToolMode.Auto;
  }

  if (toolChoice === "required") {
    return vscode.LanguageModelChatToolMode.Required;
  }

  if (toolChoice === "none") {
    // "none" means the model should not call any tools — we don't pass
    // toolMode at all when tool_choice is "none" because the stable API
    // doesn't have an explicit "none" mode. The model will see the tools
    // list but the absence of toolMode signals it should prefer text.
    return undefined;
  }

  // Named function tool_choice: treat as Auto — the model will
  // prefer the named function but isn't forced.
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return vscode.LanguageModelChatToolMode.Auto;
  }

  return undefined;
}
