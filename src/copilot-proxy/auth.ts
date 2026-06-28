import { createHash, randomBytes } from "node:crypto";

import type { CopilotProxyToken } from "@llm-gateway/shared";

interface CopilotProxyTokenStoreOptions {
  tokenTtlSeconds: number;
}

interface StoredProxyToken {
  expiresAtMs: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createTokenValue(): string {
  return `cpx_${randomBytes(32).toString("base64url")}`;
}

export function extractProxyTokenFromUrl(url: string): string | undefined {
  const token = new URL(url, "http://localhost").searchParams.get("token")?.trim();
  return token && token.length > 0 ? token : undefined;
}

export class CopilotProxyTokenStore {
  private readonly tokenTtlMs: number;
  private readonly tokens = new Map<string, StoredProxyToken>();

  public constructor(options: CopilotProxyTokenStoreOptions) {
    this.tokenTtlMs = options.tokenTtlSeconds * 1000;
  }

  public issueToken(now: Date = new Date()): CopilotProxyToken {
    this.pruneExpired(now);

    const token = createTokenValue();
    const expiresAtMs = now.getTime() + this.tokenTtlMs;
    this.tokens.set(hashToken(token), { expiresAtMs });

    return {
      token,
      token_type: "copilot_proxy",
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  public validateToken(token: string | undefined, now: Date = new Date()): boolean {
    if (!token) {
      return false;
    }

    this.pruneExpired(now);

    const stored = this.tokens.get(hashToken(token));
    if (!stored) {
      return false;
    }

    return stored.expiresAtMs > now.getTime();
  }

  private pruneExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [tokenHash, stored] of this.tokens.entries()) {
      if (stored.expiresAtMs <= nowMs) {
        this.tokens.delete(tokenHash);
      }
    }
  }
}
