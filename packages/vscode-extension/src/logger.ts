import type * as vscode from "vscode";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class ExtensionLogger {
  private level: LogLevel;

  public constructor(
    private readonly output: vscode.OutputChannel,
    level: LogLevel = "info",
  ) {
    this.level = level;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public debug(message: string): void {
    this.write("debug", message);
  }

  public info(message: string): void {
    this.write("info", message);
  }

  public warn(message: string): void {
    this.write("warn", message);
  }

  public error(message: string): void {
    this.write("error", message);
  }

  public show(): void {
    this.output.show();
  }

  public dispose(): void {
    this.output.dispose();
  }

  private write(level: LogLevel, message: string): void {
    if (LOG_LEVEL_VALUES[level] < LOG_LEVEL_VALUES[this.level]) {
      return;
    }

    this.output.appendLine(`[${level}] ${redactSecrets(message)}`);
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(token=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(proxyToken["':\s]+)[^"',\s]+/gi, "$1<redacted>")
    .replace(/cpx_[A-Za-z0-9_-]+/g, "<redacted>");
}

export function normalizeLogLevel(value: unknown): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}
