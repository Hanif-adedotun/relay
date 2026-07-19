import { describe, expect, test } from "bun:test";

import { GitHubAuthStateService } from "../github/auth-state.ts";
import { FakeRelayRepository } from "../test/fake-repository.ts";
import { RelayMessagePipeline } from "./handle-message.ts";

const githubConfig = {
  appId: "1",
  clientId: "client",
  clientSecret: "secret",
  privateKey: "key",
  slug: "relay-test",
  callbackUrl: "https://relay.test/auth/github/callback",
};

describe("RelayMessagePipeline", () => {
  test("creates one identity and conversation across repeated messages", async () => {
    const repository = new FakeRelayRepository();
    const firstContactValues: boolean[] = [];
    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      {
        generate: async ({ firstContact }) => {
          firstContactValues.push(firstContact);
          return firstContact ? "Welcome to Relay." : "Connect GitHub.";
        },
      },
      new GitHubAuthStateService(repository, githubConfig),
    );
    const input = {
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "hello",
      send: async (text: string) => {
        sent.push(text);
      },
    };

    expect((await pipeline.handle(input)).status).toBe("awaiting_github");
    expect((await pipeline.handle(input)).status).toBe("awaiting_github");

    expect(repository.identities.size).toBe(1);
    expect(repository.conversations.size).toBe(1);
    expect(repository.authSessions.size).toBe(2);
    expect(firstContactValues).toEqual([true, false]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain(
      "https://github.com/login/oauth/authorize?client_id=client",
    );
  });

  test("passes connected users through and consumes pending confirmation", async () => {
    const repository = new FakeRelayRepository();
    const identity = await repository.resolveIdentity({
      platform: "iMessage",
      externalUserId: "+15550001111",
      externalSpaceId: "chat-1",
    });
    repository.connections.push({
      userId: identity.userId,
      installationId: 10,
      githubUserId: 20,
      githubLogin: "octocat",
      repositorySelection: "selected",
    });
    repository.pendingConfirmations.add(identity.conversationId);
    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      {
        generate: async () => {
          throw new Error("onboarding must not run");
        },
      },
      new GitHubAuthStateService(repository, githubConfig),
    );

    const result = await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "continue",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(result).toEqual({
      status: "ready",
      userId: identity.userId,
      conversationId: identity.conversationId,
      confirmationSent: true,
    });
    expect(sent).toEqual([
      "GitHub is connected. Next, tell me which repository you want Relay to use.",
    ]);
    expect(repository.pendingConfirmations.size).toBe(0);
  });
});
