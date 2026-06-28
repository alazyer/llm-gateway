import * as vscode from "vscode";

export type ProxyStatus =
  | "connected"
  | "disconnected"
  | "retrying"
  | "gateway-error"
  | "copilot-unavailable";

const STATUS_LABELS: Record<ProxyStatus, string> = {
  connected: "$(check) Copilot Proxy",
  disconnected: "$(circle-slash) Copilot Proxy",
  retrying: "$(sync~spin) Copilot Proxy",
  "gateway-error": "$(warning) Copilot Proxy",
  "copilot-unavailable": "$(warning) Copilot Unavailable",
};

const STATUS_TOOLTIPS: Record<ProxyStatus, string> = {
  connected: "LLM Gateway Copilot Proxy is connected.",
  disconnected: "LLM Gateway Copilot Proxy is disconnected.",
  retrying: "LLM Gateway Copilot Proxy is retrying the gateway connection.",
  "gateway-error": "LLM Gateway Copilot Proxy cannot reach or authenticate with the gateway.",
  "copilot-unavailable": "GitHub Copilot language models are unavailable in VS Code.",
};

export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "llmGatewayCopilotProxy.showOutput";
    this.setStatus("disconnected");
    this.item.show();
  }

  public setStatus(status: ProxyStatus): void {
    this.item.text = STATUS_LABELS[status];
    this.item.tooltip = STATUS_TOOLTIPS[status];
  }

  public dispose(): void {
    this.item.dispose();
  }
}
