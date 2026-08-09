import { describe, expect, test } from "bun:test";

import { FakeRelayRepository } from "../test/fake-repository.ts";
import { hashAuthState } from "./auth-state.ts";
import {
  createGitHubCallbackHandler,
  type GitHubInstallationVerifier,
} from "./callback.ts";

const config = {
  appId: "1",
  clientId: "client",
  clientSecret: "secret",
  privateKey: "test-key",
  slug: "relay",
  callbackUrl: "https://relay.test/auth/github/callback",
};
const now = new Date("2026-07-18T20:00:00.000Z");

function addSession(repository: FakeRelayRepository, state: string): void {
  repository.authSessions.set(hashAuthState(state), {
    userId: "user-1",
    conversationId: "conversation-1",
    expiresAt: new Date("2026-07-18T20:10:00.000Z"),
    consumed: false,
  });
}

function callbackRequest(state: string, installationId?: number): Request {
  const url = new URL(config.callbackUrl);
  url.searchParams.set("code", "oauth-code");
  url.searchParams.set("state", state);
  if (installationId !== undefined) {
    url.searchParams.set("installation_id", String(installationId));
  }
  return new Request(
    url.toString(),
  );
}

describe("GitHub callback", () => {
  test("connects an existing installation and rejects state replay", async () => {
    const repository = new FakeRelayRepository();
    addSession(repository, "valid-state");
    const verifier: GitHubInstallationVerifier = {
      authorize: async () => ({
        githubUserId: 7,
        githubLogin: "octocat",
        installations: [
          {
            id: 42,
            accountLogin: "octocat",
            accountType: "User",
            repositorySelection: "selected",
          },
        ],
      }),
    };
    const handler = createGitHubCallbackHandler({
      config,
      repository,
      verifier,
      now: () => now,
      notifyConnected: async () => false,
    });

    const firstResponse = await handler(callbackRequest("valid-state"));
    const replayResponse = await handler(callbackRequest("valid-state"));

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.text()).toContain("GitHub connected as @octocat");
    expect(replayResponse.status).toBe(400);
    expect(repository.connections).toEqual([
      {
        userId: "user-1",
        installationId: 42,
        githubUserId: 7,
        githubLogin: "octocat",
        repositorySelection: "selected",
      },
    ]);
    expect(repository.pendingConfirmations.has("conversation-1")).toBeTrue();
  });

  test("skips pending confirmation when notifyConnected succeeds", async () => {
    const repository = new FakeRelayRepository();
    addSession(repository, "notified-state");
    const notified: string[] = [];
    const handler = createGitHubCallbackHandler({
      config,
      repository,
      verifier: {
        authorize: async () => ({
          githubUserId: 7,
          githubLogin: "octocat",
          installations: [
            {
              id: 42,
              accountLogin: "octocat",
              accountType: "User",
              repositorySelection: "selected",
            },
          ],
        }),
      },
      now: () => now,
      notifyConnected: async (conversationId) => {
        notified.push(conversationId);
        return true;
      },
    });

    const response = await handler(callbackRequest("notified-state"));

    expect(response.status).toBe(200);
    expect(notified).toEqual(["conversation-1"]);
    expect(repository.pendingConfirmations.has("conversation-1")).toBeFalse();
  });

  test("continues to installation when the authorized user has none", async () => {
    const repository = new FakeRelayRepository();
    addSession(repository, "new-install-state");
    let authorizationCount = 0;
    const handler = createGitHubCallbackHandler({
      config,
      repository,
      verifier: {
        authorize: async () => {
          authorizationCount += 1;
          return {
            githubUserId: 7,
            githubLogin: "octocat",
            installations:
              authorizationCount === 1
                ? []
                : [
                    {
                      id: 42,
                      accountLogin: "octocat",
                      accountType: "User",
                      repositorySelection: "selected",
                    },
                  ],
          };
        },
      },
      now: () => now,
    });

    const installResponse = await handler(
      callbackRequest("new-install-state"),
    );
    const completionResponse = await handler(
      callbackRequest("new-install-state", 42),
    );

    expect(installResponse.status).toBe(302);
    expect(installResponse.headers.get("location")).toContain(
      "https://github.com/apps/relay/installations/new?state=new-install-state",
    );
    expect(completionResponse.status).toBe(200);
    expect(repository.connections).toHaveLength(1);
  });

  test("renders and processes a choice when several installations exist", async () => {
    const repository = new FakeRelayRepository();
    addSession(repository, "choice-state");
    const handler = createGitHubCallbackHandler({
      config,
      repository,
      verifier: {
        authorize: async () => ({
          githubUserId: 7,
          githubLogin: "octocat",
          installations: [
            {
              id: 41,
              accountLogin: "octocat",
              accountType: "User",
              repositorySelection: "selected",
            },
            {
              id: 42,
              accountLogin: "relay-org",
              accountType: "Organization",
              repositorySelection: "all",
            },
          ],
        }),
      },
      now: () => now,
    });

    const choiceResponse = await handler(callbackRequest("choice-state"));
    const form = new FormData();
    form.set("state", "choice-state");
    form.set("installation_id", "42");
    const completionResponse = await handler(
      new Request(config.callbackUrl, { method: "POST", body: form }),
    );

    expect(choiceResponse.status).toBe(200);
    expect(await choiceResponse.text()).toContain("Connect relay-org");
    expect(completionResponse.status).toBe(200);
    expect(repository.connections[0]?.installationId).toBe(42);
  });
});
