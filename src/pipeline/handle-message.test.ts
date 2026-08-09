import { describe, expect, test } from "bun:test";

import { GitHubAuthStateService } from "../github/auth-state.ts";
import type {
  GitHubBranchList,
  GitHubReposClient,
  GitHubRepositoryInspection,
} from "../github/repos.ts";
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
      return { reply: "done", action: "none", repository: null, branch: null };
    }
    return next(input);
  }
}

const emptyRepos: GitHubReposClient = {
  listRepositories: async () => [],
  findRepository: async () => null,
  listBranches: async () => ({
    defaultBranch: "main",
    branches: [],
    truncated: false,
  }),
  inspectRepository: async () => {
    throw new Error("inspect not implemented in empty client");
  },
};

const sampleBranches: GitHubBranchList = {
  defaultBranch: "main",
  branches: [
    { name: "main", protected: true },
    { name: "feature/login", protected: false },
  ],
  truncated: false,
};

const sampleInspection: GitHubRepositoryInspection = {
  fullName: "octocat/portfolio",
  description: "Personal site",
  defaultBranch: "main",
  ref: "main",
  language: "TypeScript",
  topLevel: [
    { path: "README.md", type: "file" },
    { path: "src", type: "dir" },
  ],
  readme: {
    path: "README.md",
    text: "# Portfolio\nA personal website.",
  },
  manifests: [
    {
      path: "package.json",
      text: '{"name":"portfolio","description":"Personal site"}',
    },
  ],
  recentCommits: [
    {
      sha: "abc1234",
      message: "Initial commit",
      author: "octocat",
      date: "2026-08-01T00:00:00Z",
    },
  ],
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
          branch: null,
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
          branch: null,
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
          branch: null,
        }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return {
            reply: "I can see portfolio and relay. Which one?",
            action: "none",
            repository: null,
            branch: null,
          };
        },
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        ...emptyRepos,
        listRepositories: async () => [
          { fullName: "octocat/portfolio", private: false },
          { fullName: "octocat/relay", private: true },
        ],
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
    await repository.setActiveRepo(identity.conversationId, "octocat/old");
    await repository.setActiveBranch(identity.conversationId, "develop");

    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Connecting portfolio.",
          action: "select_repository",
          repository: "portfolio",
          branch: null,
        }),
        () => ({
          reply: "portfolio is now your active repo.",
          action: "none",
          repository: null,
          branch: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        ...emptyRepos,
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
    expect(state.activeBranch).toBeNull();
    expect(sent).toEqual(["portfolio is now your active repo."]);
  });

  test("lists branches when a repository is active", async () => {
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
    await repository.setActiveRepo(
      identity.conversationId,
      "octocat/portfolio",
    );

    const sent: string[] = [];
    const seenToolResults: unknown[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Checking branches.",
          action: "list_branches",
          repository: null,
          branch: null,
        }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return {
            reply: "main and feature/login. Which branch?",
            action: "none",
            repository: null,
            branch: null,
          };
        },
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        ...emptyRepos,
        listBranches: async () => sampleBranches,
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "list branches",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(seenToolResults[0]).toEqual([
      { action: "list_branches", result: sampleBranches },
    ]);
    expect(sent).toEqual(["main and feature/login. Which branch?"]);
  });

  test("selects an active branch after verifying it exists", async () => {
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
    await repository.setActiveRepo(
      identity.conversationId,
      "octocat/portfolio",
    );

    const sent: string[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Selecting feature/login.",
          action: "select_branch",
          repository: null,
          branch: "feature/login",
        }),
        () => ({
          reply: "Using feature/login.",
          action: "none",
          repository: null,
          branch: null,
        }),
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        ...emptyRepos,
        listBranches: async () => sampleBranches,
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "use feature/login",
      send: async (text) => {
        sent.push(text);
      },
    });

    const state = await repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });
    expect(state.activeBranch).toBe("feature/login");
    expect(sent).toEqual(["Using feature/login."]);
  });

  test("inspects the active repository then summarizes from tool facts", async () => {
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
    await repository.setActiveRepo(
      identity.conversationId,
      "octocat/portfolio",
    );

    const sent: string[] = [];
    const seenToolResults: unknown[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Inspecting portfolio.",
          action: "inspect_repository",
          repository: null,
          branch: null,
        }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return {
            reply:
              "portfolio is a TypeScript personal site. README describes a personal website.",
            action: "none",
            repository: null,
            branch: null,
          };
        },
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      {
        ...emptyRepos,
        inspectRepository: async () => sampleInspection,
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "what does this codebase do?",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(seenToolResults[0]).toEqual([
      { action: "inspect_repository", result: sampleInspection },
    ]);
    expect(sent).toEqual([
      "portfolio is a TypeScript personal site. README describes a personal website.",
    ]);
  });

  test("returns a tool error when branch tools run without an active repo", async () => {
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
    const seenErrors: unknown[] = [];
    const pipeline = new RelayMessagePipeline(
      repository,
      new ScriptedConversationModel([
        () => ({
          reply: "Checking branches.",
          action: "list_branches",
          repository: null,
          branch: null,
        }),
        (input) => {
          seenErrors.push(input.toolResults?.[0]?.result);
          return {
            reply: "Pick a repository first.",
            action: "none",
            repository: null,
            branch: null,
          };
        },
      ]),
      new GitHubAuthStateService(repository, githubConfig),
      emptyRepos,
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "list branches",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(seenErrors[0]).toEqual({
      error: "No active repository is selected for this conversation.",
    });
    expect(sent).toEqual(["Pick a repository first."]);
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
          branch: null,
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
          branch: null,
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
