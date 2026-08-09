import { describe, expect, test } from "bun:test";

import { GitHubAuthStateService } from "../github/auth-state.ts";
import type { GitHubReposClient } from "../github/repos.ts";
import type {
  ConversationModel,
  ConversationTurnInput,
  ConversationTurnOutput,
} from "../model/conversation.ts";
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

class ScriptedConversationModel implements ConversationModel {
  constructor(
    private readonly turns: Array<
      (input: ConversationTurnInput) => ConversationTurnOutput
    >,
  ) {}

  async turn(input: ConversationTurnInput): Promise<ConversationTurnOutput> {
    const next = this.turns.shift();
    if (!next) {
      return { reply: "done", action: "none", repository: null };
    }
    return next(input);
  }
}

const emptyRepos: GitHubReposClient = {
  listRepositories: async () => [],
  findRepository: async () => null,
};

describe("RelayMessagePipeline soft context", () => {
  test("answers without GitHub and does not force a connect link", async () => {
    const repository = new FakeRelayRepository();
    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Relay helps with repos over chat. What do you need?",
          action: "none",
          repository: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      emptyRepos,
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "what can you do?",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual([
      "Relay helps with repos over chat. What do you need?",
    ]);
    expect(repository.authSessions.size).toBe(0);
  });

  test("appends a trusted OAuth URL when offering GitHub connect", async () => {
    const repository = new FakeRelayRepository();
    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Connect GitHub so I can see your repositories.",
          action: "offer_github_connect",
          repository: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      emptyRepos,
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "list my repos",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Connect GitHub so I can see your repositories.");
    expect(sent[0]).toContain(
      "https://github.com/login/oauth/authorize?client_id=client",
    );
    expect(repository.authSessions.size).toBe(1);
  });

  test("lists repositories then replies with tool results", async () => {
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

    const sent: string[] = [];
    const seenToolResults: unknown[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Checking your repos.",
          action: "list_repositories",
          repository: null,
        }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return {
            reply: "I can see portfolio and relay. Which one?",
            action: "none",
            repository: null,
          };
        },
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        listRepositories: async () => [
          { fullName: "octocat/portfolio", private: false },
          { fullName: "octocat/relay", private: true },
        ],
        findRepository: async () => null,
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "give me options",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(seenToolResults[0]).toEqual([
      {
        action: "list_repositories",
        result: {
          repositories: [
            { fullName: "octocat/portfolio", private: false },
            { fullName: "octocat/relay", private: true },
          ],
        },
      },
    ]);
    expect(sent).toEqual(["I can see portfolio and relay. Which one?"]);
  });

  test("selects and stores an active repository", async () => {
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

    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Connecting portfolio.",
          action: "select_repository",
          repository: "portfolio",
        }),
        () => ({
          reply: "portfolio is now your active repo.",
          action: "none",
          repository: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        listRepositories: async () => [],
        findRepository: async () => ({
          fullName: "octocat/portfolio",
          private: false,
        }),
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "connect my portfolio",
      send: async (text) => {
        sent.push(text);
      },
    });

    const state = await repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });
    expect(state.activeRepo).toBe("octocat/portfolio");
    expect(sent).toEqual(["portfolio is now your active repo."]);
  });

  test("returns a tool error when repo tools are used without GitHub", async () => {
    const repository = new FakeRelayRepository();
    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Looking up repos.",
          action: "list_repositories",
          repository: null,
        }),
        (input) => ({
          reply:
            input.toolResults?.[0] &&
            typeof input.toolResults[0].result === "object" &&
            input.toolResults[0].result !== null &&
            "error" in input.toolResults[0].result
              ? "GitHub is not connected yet."
              : "unexpected",
          action: "offer_github_connect",
          repository: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      emptyRepos,
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "list repos",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent[0]).toContain("GitHub is not connected yet.");
    expect(sent[0]).toContain("Connect GitHub:");
  });
});
