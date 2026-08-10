import { describe, expect, test } from "bun:test";

import { GitHubAuthStateService } from "../github/auth-state.ts";
import type {
  GitHubBranchList,
  GitHubCommitFilesInput,
  GitHubReposClient,
  GitHubRepositoryInspection,
} from "../github/repos.ts";
import type { EmbeddingClient } from "../memory/embeddings.ts";
import {
  emptyTurnFields,
  type ConversationModel,
  type ConversationTurnInput,
  type ConversationTurnOutput,
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

const stubEmbeddings: EmbeddingClient = {
  embedTexts: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};

function turn(
  partial: Partial<ConversationTurnOutput> &
    Pick<ConversationTurnOutput, "reply" | "action">,
): ConversationTurnOutput {
  return {
    ...emptyTurnFields(),
    ...partial,
  };
}

class ScriptedConversationModel implements ConversationModel {
  constructor(
    private readonly turns: Array<
      (input: ConversationTurnInput) => ConversationTurnOutput
    >,
  ) {}

  async turn(input: ConversationTurnInput): Promise<ConversationTurnOutput> {
    const next = this.turns.shift();
    if (!next) {
      return turn({ reply: "done", action: "none" });
    }
    return next(input);
  }
}

function makePipeline(
  repository: FakeRelayRepository,
  model: ConversationModel,
  repos: GitHubReposClient,
  embeddings: EmbeddingClient = stubEmbeddings,
): RelayMessagePipeline {
  return new RelayMessagePipeline(
    repository,
    model,
    new GitHubAuthStateService(repository, githubConfig),
    repos,
    embeddings,
  );
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
  createBranch: async () => {
    throw new Error("createBranch not implemented in empty client");
  },
  commitFiles: async () => {
    throw new Error("commitFiles not implemented in empty client");
  },
  createPullRequest: async () => {
    throw new Error("createPullRequest not implemented in empty client");
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Relay helps with repos over chat. What do you need?",
            action: "none",
          }),
      ]),
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Connect GitHub so I can see your repositories.",
            action: "offer_github_connect",
          }),
      ]),
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

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe("Preparing a GitHub connect link…");
    expect(sent[1]).toContain("Connect GitHub so I can see your repositories.");
    expect(sent[1]).toContain(
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Checking your repos.",
            action: "list_repositories",
          }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return turn({
            reply: "I can see portfolio and relay. Which one?",
            action: "none",
          });
        },
      ]),
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Connecting portfolio.",
            action: "select_repository",
            repository: "portfolio",
          }),
        () =>
          turn({
            reply: "portfolio is now your active repo.",
            action: "none",
          }),
      ]),
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Checking branches.",
            action: "list_branches",
          }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return turn({
            reply: "main and feature/login. Which branch?",
            action: "none",
          });
        },
      ]),
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Selecting feature/login.",
            action: "select_branch",
            branch: "feature/login",
          }),
        () =>
          turn({
            reply: "Using feature/login.",
            action: "none",
          }),
      ]),
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

  test("creates a branch and stores it as active", async () => {
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Creating feat/onboarding.",
            action: "create_branch",
            branch: "feat/onboarding",
          }),
        () =>
          turn({
            reply: "Branch feat/onboarding is ready.",
            action: "none",
          }),
      ]),
      {
        ...emptyRepos,
        createBranch: async (_installationId, _fullName, branch) => ({
          branch,
          sha: "abc123",
          fromRef: "main",
        }),
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "create feat/onboarding",
      send: async (text) => {
        sent.push(text);
      },
    });

    const state = await repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });
    expect(state.activeBranch).toBe("feat/onboarding");
    expect(sent).toEqual([
      "Creating branch feat/onboarding…",
      "Created feat/onboarding.",
      "Branch feat/onboarding is ready.",
    ]);
  });

  test("commits files in replace mode on the active branch", async () => {
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

    const commitInputs: GitHubCommitFilesInput[] = [];
    const sent: string[] = [];
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Resetting the tree.",
            action: "commit_files",
            branch: "feat/onboarding",
            commitMessage: "chore: keep only architecture.md",
            commitMode: "replace",
            files: [
              {
                path: "architecture.md",
                content: "# Architecture\n",
              },
            ],
          }),
        () =>
          turn({
            reply: "Committed architecture.md only.",
            action: "none",
          }),
      ]),
      {
        ...emptyRepos,
        commitFiles: async (_installationId, _fullName, input) => {
          commitInputs.push(input);
          return {
            branch: input.branch,
            sha: "def456",
            message: input.message,
            mode: input.mode,
            changedPaths: input.files.map((file) => file.path),
          };
        },
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "replace everything with architecture.md",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(commitInputs).toEqual([
      {
        branch: "feat/onboarding",
        message: "chore: keep only architecture.md",
        mode: "replace",
        files: [{ path: "architecture.md", content: "# Architecture\n" }],
      },
    ]);
    const state = await repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });
    expect(state.activeBranch).toBe("feat/onboarding");
    expect(sent).toEqual([
      "Committing changes…",
      "Committed architecture.md.",
      "Committed architecture.md only.",
    ]);
  });

  test("sends progress for create branch then commit then final reply", async () => {
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Working on it.",
            action: "create_branch",
            branch: "feat/onboarding",
          }),
        () =>
          turn({
            reply: "Working on it.",
            action: "commit_files",
            branch: "feat/onboarding",
            commitMessage: "chore: architecture only",
            commitMode: "replace",
            files: [{ path: "architecture.md", content: "# Architecture\n" }],
          }),
        () =>
          turn({
            reply: "All set on feat/onboarding.",
            action: "none",
          }),
      ]),
      {
        ...emptyRepos,
        createBranch: async (_installationId, _fullName, branch) => ({
          branch,
          sha: "abc123",
          fromRef: "main",
        }),
        commitFiles: async (_installationId, _fullName, input) => ({
          branch: input.branch,
          sha: "def456",
          message: input.message,
          mode: input.mode,
          changedPaths: input.files.map((file) => file.path),
        }),
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "create feat/onboarding with only architecture.md",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual([
      "Creating branch feat/onboarding…",
      "Created feat/onboarding.",
      "Committing changes…",
      "Committed architecture.md.",
      "All set on feat/onboarding.",
    ]);
  });

  test("appends the pull request URL after create_pull_request", async () => {
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
    await repository.setActiveBranch(
      identity.conversationId,
      "feat/onboarding",
    );

    const sent: string[] = [];
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Opening a PR.",
            action: "create_pull_request",
            branch: "feat/onboarding",
            prTitle: "feat: onboarding architecture",
            prBody: "Keeps only architecture.md",
          }),
        () =>
          turn({
            reply: "PR is ready.",
            action: "none",
          }),
      ]),
      {
        ...emptyRepos,
        createPullRequest: async () => ({
          number: 12,
          url: "https://github.com/octocat/portfolio/pull/12",
          title: "feat: onboarding architecture",
          head: "feat/onboarding",
          base: "main",
        }),
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "open a PR",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent).toEqual([
      "Opening pull request…",
      "PR is ready.\n\nPull request:\nhttps://github.com/octocat/portfolio/pull/12",
    ]);
  });

  test("sends a failure progress line when create_branch fails", async () => {
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Creating branch.",
            action: "create_branch",
            branch: "feat/onboarding",
          }),
        () =>
          turn({
            reply: "That branch already exists. Pick another name?",
            action: "none",
          }),
      ]),
      {
        ...emptyRepos,
        createBranch: async () => {
          throw new Error("Reference already exists status=422");
        },
      },
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "create feat/onboarding",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(sent[0]).toBe("Creating branch feat/onboarding…");
    expect(sent[1]).toContain("Couldn’t create the branch:");
    expect(sent[1]).toContain("Reference already exists");
    expect(sent[2]).toBe("That branch already exists. Pick another name?");
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Inspecting portfolio.",
            action: "inspect_repository",
          }),
        (input) => {
          seenToolResults.push(input.toolResults);
          return turn({
            reply:
              "portfolio is a TypeScript personal site. README describes a personal website.",
            action: "none",
          });
        },
      ]),
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

  test("returns a tool error when write tools run without an active repo", async () => {
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Creating a branch.",
            action: "create_branch",
            branch: "feat/onboarding",
          }),
        (input) => {
          seenErrors.push(input.toolResults?.[0]?.result);
          return turn({
            reply: "Pick a repository first.",
            action: "none",
          });
        },
      ]),
      emptyRepos,
    );

    await pipeline.handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "create feat/onboarding",
      send: async (text) => {
        sent.push(text);
      },
    });

    expect(seenErrors[0]).toEqual({
      error: "No active repository is selected for this conversation.",
    });
    expect(sent).toEqual(["Pick a repository first."]);
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Checking branches.",
            action: "list_branches",
          }),
        (input) => {
          seenErrors.push(input.toolResults?.[0]?.result);
          return turn({
            reply: "Pick a repository first.",
            action: "none",
          });
        },
      ]),
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
    const pipeline = makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Looking up repos.",
            action: "list_repositories",
          }),
        (input) =>
          turn({
            reply:
              input.toolResults?.[0] &&
              typeof input.toolResults[0].result === "object" &&
              input.toolResults[0].result !== null &&
              "error" in input.toolResults[0].result
                ? "GitHub is not connected yet."
                : "unexpected",
            action: "offer_github_connect",
          }),
      ]),
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

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe("Preparing a GitHub connect link…");
    expect(sent[1]).toContain("GitHub is not connected yet.");
    expect(sent[1]).toContain("Connect GitHub:");
  });

  test("passes prior messages into the next turn as recentMessages", async () => {
    const repository = new FakeRelayRepository();
    const seenRecent: unknown[] = [];

    await makePipeline(
      repository,
      new ScriptedConversationModel([
        () => turn({ reply: "Hello there.", action: "none" }),
      ]),
      emptyRepos,
    ).handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "hi",
      send: async () => undefined,
    });

    await makePipeline(
      repository,
      new ScriptedConversationModel([
        (input) => {
          seenRecent.push(input.recentMessages);
          return turn({ reply: "Welcome back.", action: "none" });
        },
      ]),
      emptyRepos,
    ).handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "still there?",
      send: async () => undefined,
    });

    expect(seenRecent[0]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello there." },
    ]);
  });

  test("stores last PR fields in working memory after create_pull_request", async () => {
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
    await repository.setActiveBranch(
      identity.conversationId,
      "feat/onboarding",
    );

    await makePipeline(
      repository,
      new ScriptedConversationModel([
        () =>
          turn({
            reply: "Opening a PR.",
            action: "create_pull_request",
            branch: "feat/onboarding",
            prTitle: "feat: onboarding",
          }),
        () => turn({ reply: "PR is ready.", action: "none" }),
      ]),
      {
        ...emptyRepos,
        createPullRequest: async () => ({
          number: 12,
          url: "https://github.com/octocat/portfolio/pull/12",
          title: "feat: onboarding",
          head: "feat/onboarding",
          base: "main",
        }),
      },
    ).handle({
      platform: "iMessage",
      senderId: "+15550001111",
      spaceId: "chat-1",
      text: "open a PR",
      send: async () => undefined,
    });

    const state = await repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });
    expect(state.lastPrNumber).toBe(12);
    expect(state.lastPrUrl).toBe(
      "https://github.com/octocat/portfolio/pull/12",
    );
  });
});
