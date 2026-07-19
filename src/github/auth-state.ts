import { createHash, randomBytes } from "node:crypto";

import type { RelayConfig } from "../config.ts";
import type { RelayRepository } from "../db/relay-repository.ts";

const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export function hashAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export class GitHubAuthStateService {
  constructor(
    private readonly repository: RelayRepository,
    private readonly githubConfig: RelayConfig["github"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createAuthorizationUrl(input: {
    userId: string;
    conversationId: string;
  }): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const stateHash = hashAuthState(state);
    const expiresAt = new Date(this.now().getTime() + AUTH_SESSION_TTL_MS);

    await this.repository.createAuthSession({
      ...input,
      stateHash,
      expiresAt,
    });

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.githubConfig.clientId);
    url.searchParams.set("redirect_uri", this.githubConfig.callbackUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }
}
