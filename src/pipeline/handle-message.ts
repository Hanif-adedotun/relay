import type { RelayRepository } from "../db/relay-repository.ts";
import type { GitHubAuthStateService } from "../github/auth-state.ts";
import type { GitHubReposClient } from "../github/repos.ts";
import type {
  ConversationAction,
  ConversationModel,
  ConversationTurnOutput,
} from "../model/conversation.ts";
import { fallbackConversationTurn } from "../model/conversation.ts";

const MAX_TOOL_ITERATIONS = 6;

export interface InboundTextMessage {
  platform: string;
  senderId: string;
  spaceId: string;
  text: string;
  send(text: string): Promise<void>;
}

export type MessageGateResult = {
  status: "replied";
  userId: string;
  conversationId: string;
  action: ConversationAction;
};

export class RelayMessagePipeline {
  constructor(
    private readonly repository: RelayRepository,
    private readonly conversation: ConversationModel,
    private readonly githubAuth: GitHubAuthStateService,
    private readonly githubRepos: GitHubReposClient,
  ) {}

  async handle(message: InboundTextMessage): Promise<MessageGateResult> {
    const identity = await this.repository.resolveIdentity({
      platform: message.platform,
      externalUserId: message.senderId,
      externalSpaceId: message.spaceId,
    });

    let state = await this.repository.getConversationState({
      userId: identity.userId,
      conversationId: identity.conversationId,
    });

    const pendingGithubConfirmation =
      await this.repository.consumeGitHubConfirmation(identity.conversationId);
    if (pendingGithubConfirmation) {
      state = {
        ...state,
        pendingGithubConfirmation: true,
      };
    }

    const toolResults: Array<{ action: ConversationAction; result: unknown }> =
      [];
    let turn: ConversationTurnOutput = fallbackConversationTurn();
    let connectUrl: string | null = null;
    let pullRequestUrl: string | null = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const githubConnected = state.github !== null;
      const hasActiveRepo = state.activeRepo !== null;
      turn = await this.conversation.turn({
        userText: message.text,
        context: {
          firstContact: identity.isNewUser && iteration === 0,
          githubConnected,
          githubLogin: state.github?.githubLogin ?? null,
          activeRepo: state.activeRepo,
          activeBranch: state.activeBranch,
          pendingGithubConfirmation: state.pendingGithubConfirmation,
          canListRepositories: githubConnected,
          canSelectRepository: githubConnected,
          canListBranches: githubConnected && hasActiveRepo,
          canInspectRepository: githubConnected && hasActiveRepo,
          canWriteRepository: githubConnected && hasActiveRepo,
        },
        toolResults,
      });

      if (turn.action === "none") break;

      if (turn.action === "offer_github_connect") {
        connectUrl = await this.githubAuth.createAuthorizationUrl({
          userId: identity.userId,
          conversationId: identity.conversationId,
        });
        break;
      }

      if (!state.github) {
        toolResults.push({
          action: turn.action,
          result: {
            error: "GitHub is not connected for this user.",
          },
        });
        continue;
      }

      if (turn.action === "list_repositories") {
        try {
          const repositories = await this.githubRepos.listRepositories(
            state.github.installationId,
          );
          toolResults.push({
            action: "list_repositories",
            result: { repositories },
          });
        } catch (error) {
          toolResults.push({
            action: "list_repositories",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to list repositories",
            },
          });
        }
        continue;
      }

      if (turn.action === "select_repository") {
        try {
          const selected = await this.githubRepos.findRepository(
            state.github.installationId,
            turn.repository ?? "",
          );
          if (!selected) {
            toolResults.push({
              action: "select_repository",
              result: {
                error: `No accessible repository matched "${turn.repository}".`,
              },
            });
            continue;
          }

          await this.repository.setActiveRepo(
            identity.conversationId,
            selected.fullName,
          );
          state = {
            ...state,
            activeRepo: selected.fullName,
            activeBranch: null,
          };
          toolResults.push({
            action: "select_repository",
            result: { selected: selected.fullName },
          });
        } catch (error) {
          toolResults.push({
            action: "select_repository",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to select repository",
            },
          });
        }
        continue;
      }

      if (!state.activeRepo) {
        toolResults.push({
          action: turn.action,
          result: {
            error: "No active repository is selected for this conversation.",
          },
        });
        continue;
      }

      if (turn.action === "list_branches") {
        try {
          const branches = await this.githubRepos.listBranches(
            state.github.installationId,
            state.activeRepo,
          );
          toolResults.push({
            action: "list_branches",
            result: branches,
          });
        } catch (error) {
          toolResults.push({
            action: "list_branches",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to list branches",
            },
          });
        }
        continue;
      }

      if (turn.action === "select_branch") {
        try {
          const branchList = await this.githubRepos.listBranches(
            state.github.installationId,
            state.activeRepo,
          );
          const requested = turn.branch?.trim() ?? "";
          const matched = branchList.branches.find(
            (branch) => branch.name.toLowerCase() === requested.toLowerCase(),
          );
          if (!matched) {
            toolResults.push({
              action: "select_branch",
              result: {
                error: `No branch matched "${turn.branch}".`,
                defaultBranch: branchList.defaultBranch,
                branches: branchList.branches.map((branch) => branch.name),
              },
            });
            continue;
          }

          await this.repository.setActiveBranch(
            identity.conversationId,
            matched.name,
          );
          state = {
            ...state,
            activeBranch: matched.name,
          };
          toolResults.push({
            action: "select_branch",
            result: { selected: matched.name },
          });
        } catch (error) {
          toolResults.push({
            action: "select_branch",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to select branch",
            },
          });
        }
        continue;
      }

      if (turn.action === "inspect_repository") {
        try {
          const inspection = await this.githubRepos.inspectRepository(
            state.github.installationId,
            state.activeRepo,
            turn.branch ?? state.activeBranch ?? undefined,
          );
          toolResults.push({
            action: "inspect_repository",
            result: inspection,
          });
        } catch (error) {
          toolResults.push({
            action: "inspect_repository",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to inspect repository",
            },
          });
        }
        continue;
      }

      if (turn.action === "create_branch") {
        try {
          const created = await this.githubRepos.createBranch(
            state.github.installationId,
            state.activeRepo,
            turn.branch ?? "",
            state.activeBranch ?? undefined,
          );
          await this.repository.setActiveBranch(
            identity.conversationId,
            created.branch,
          );
          state = {
            ...state,
            activeBranch: created.branch,
          };
          toolResults.push({
            action: "create_branch",
            result: created,
          });
        } catch (error) {
          toolResults.push({
            action: "create_branch",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to create branch",
            },
          });
        }
        continue;
      }

      if (turn.action === "commit_files") {
        try {
          const committed = await this.githubRepos.commitFiles(
            state.github.installationId,
            state.activeRepo,
            {
              branch: turn.branch ?? state.activeBranch ?? "",
              message: turn.commitMessage ?? "",
              mode: turn.commitMode ?? "upsert",
              files: turn.files ?? [],
            },
          );
          await this.repository.setActiveBranch(
            identity.conversationId,
            committed.branch,
          );
          state = {
            ...state,
            activeBranch: committed.branch,
          };
          toolResults.push({
            action: "commit_files",
            result: committed,
          });
        } catch (error) {
          toolResults.push({
            action: "commit_files",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to commit files",
            },
          });
        }
        continue;
      }

      if (turn.action === "create_pull_request") {
        try {
          const pull = await this.githubRepos.createPullRequest(
            state.github.installationId,
            state.activeRepo,
            {
              head: turn.branch ?? state.activeBranch ?? "",
              title: turn.prTitle ?? "",
              body: turn.prBody,
            },
          );
          pullRequestUrl = pull.url;
          toolResults.push({
            action: "create_pull_request",
            result: pull,
          });
        } catch (error) {
          toolResults.push({
            action: "create_pull_request",
            result: {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to create pull request",
            },
          });
        }
      }
    }

    let reply = turn.reply;
    if (connectUrl) {
      reply = `${reply}\n\nConnect GitHub:\n${connectUrl}`;
    } else if (pullRequestUrl) {
      reply = `${reply}\n\nPull request:\n${pullRequestUrl}`;
    }

    await message.send(reply);

    return {
      status: "replied",
      userId: identity.userId,
      conversationId: identity.conversationId,
      action: connectUrl
        ? "offer_github_connect"
        : pullRequestUrl
          ? "create_pull_request"
          : turn.action,
    };
  }
}
