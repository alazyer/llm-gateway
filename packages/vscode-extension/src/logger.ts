import type * as vscode from "vscode";

export class ExtensionLogger {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public info(message: string): void {
    this.output.appendLine(`[info] ${redactSecrets(message)}`);
  }

  public warn(message: string): void {
    this.output.appendLine(`[warn] ${redactSecrets(message)}`);
  }

  public error(message: string): void {
    this.output.appendLine(`[error] ${redactSecrets(message)}`);
  }

  public show(): void {
    this.output.show();
  }

  public dispose(): void {
    this.output.dispose();
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(token=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(proxyToken["':\s]+)[^"',\s]+/gi, "$1<redacted>")
    .replace(/cpx_[A-Za-z0-9_-]+/g, "<redacted>");
}
