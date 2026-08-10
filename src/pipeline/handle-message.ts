import type { RelayRepository } from "../db/relay-repository.ts";
import type { GitHubAuthStateService } from "../github/auth-state.ts";
import type { GitHubReposClient } from "../github/repos.ts";
import type { EmbeddingClient } from "../memory/embeddings.ts";
import {
  buildTurnMemoryChunk,
  retrieveMemory,
} from "../memory/retrieve.ts";
import type { AckModel } from "../model/ack.ts";
import { shouldSkipAck, withAckTimeout } from "../model/ack.ts";
import type {
  ConversationAction,
  ConversationHistoryMessage,
  ConversationModel,
  ConversationTurnOutput,
} from "../model/conversation.ts";
import { fallbackConversationTurn } from "../model/conversation.ts";

const MAX_TOOL_ITERATIONS = 6;
const MAX_PROGRESS_ERROR_CHARS = 160;
const RECENT_MESSAGE_LIMIT = 20;

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

export function progressBeforeAction(
  action: ConversationAction,
  turn: ConversationTurnOutput,
): string | null {
  switch (action) {
    case "create_branch": {
      const name = turn.branch?.trim();
      return name ? `Creating branch ${name}…` : "Creating branch…";
    }
    case "commit_files":
      return "Committing changes…";
    case "create_pull_request":
      return "Opening pull request…";
    case "offer_github_connect":
      return "Preparing a GitHub connect link…";
    default:
      return null;
  }
}

export function progressAfterSuccess(
  action: ConversationAction,
  detail?: {
    branch?: string;
    changedPaths?: string[];
  },
): string | null {
  switch (action) {
    case "create_branch": {
      const name = detail?.branch?.trim();
      return name ? `Created ${name}.` : "Created branch.";
    }
    case "commit_files": {
      const paths = detail?.changedPaths ?? [];
      if (paths.length === 0) return "Committed changes.";
      const shown = paths.slice(0, 3).join(", ");
      const extra = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
      return `Committed ${shown}${extra}.`;
    }
    case "create_pull_request":
    case "offer_github_connect":
      return null;
    default:
      return null;
  }
}

export function progressAfterFailure(
  action: ConversationAction,
  error: string,
): string | null {
  const verb =
    action === "create_branch"
      ? "create the branch"
      : action === "commit_files"
        ? "commit changes"
        : action === "create_pull_request"
          ? "open the pull request"
          : action === "offer_github_connect"
            ? "prepare the connect link"
            : null;
  if (!verb) return null;

  const short = error
    .replace(/\b(?:https?:\/\/|www\.|github\.com\/)\S*/giu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_PROGRESS_ERROR_CHARS);
  return short
    ? `Couldn’t ${verb}: ${short}`
    : `Couldn’t ${verb}.`;
}

export class RelayMessagePipeline {
  constructor(
    private readonly repository: RelayRepository,
    private readonly conversation: ConversationModel,
    private readonly githubAuth: GitHubAuthStateService,
    private readonly githubRepos: GitHubReposClient,
    private readonly embeddings: EmbeddingClient,
    private readonly ack: AckModel,
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

    const ackPromise = shouldSkipAck(message.text)
      ? null
      : withAckTimeout(
          this.ack.acknowledge({
            userText: message.text,
            activeRepo: state.activeRepo,
            githubConnected: state.github !== null,
          }),
        );

    const recentMessages = await this.repository.listRecentMessages(
      identity.conversationId,
      RECENT_MESSAGE_LIMIT,
    );
    const recentForModel: ConversationHistoryMessage[] = recentMessages.map(
      (entry) => ({
        role: entry.role,
        content: entry.content,
      }),
    );
    const retrievedMemory = await retrieveMemory({
      repository: this.repository,
      embeddings: this.embeddings,
      userId: identity.userId,
      userText: message.text,
      recentMessages,
      activeRepo: state.activeRepo,
    });

    const userMessage = await this.repository.appendMessage({
      conversationId: identity.conversationId,
      userId: identity.userId,
      role: "user",
      content: message.text,
    });

    const toolResults: Array<{ action: ConversationAction; result: unknown }> =
      [];
    const milestones: string[] = [];
    let turn: ConversationTurnOutput = fallbackConversationTurn();
    let connectUrl: string | null = null;
    let pullRequestUrl: string | null = null;
    const progress = { last: null as string | null };

    const sendProgress = async (text: string | null): Promise<void> => {
      const trimmed = text?.trim();
      if (!trimmed) return;
      await message.send(trimmed);
      progress.last = trimmed;
    };

    if (ackPromise) {
      await sendProgress(await ackPromise);
    }

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
          lastPrNumber: state.lastPrNumber,
          lastPrUrl: state.lastPrUrl,
          lastCommitSha: state.lastCommitSha,
          pendingGithubConfirmation: state.pendingGithubConfirmation,
          canListRepositories: githubConnected,
          canSelectRepository: githubConnected,
          canListBranches: githubConnected && hasActiveRepo,
          canInspectRepository: githubConnected && hasActiveRepo,
          canWriteRepository: githubConnected && hasActiveRepo,
        },
        recentMessages: recentForModel,
        retrievedMemory,
        toolResults,
      });

      if (turn.action === "none") break;

      if (turn.action === "offer_github_connect") {
        await sendProgress(progressBeforeAction(turn.action, turn));
        try {
          connectUrl = await this.githubAuth.createAuthorizationUrl({
            userId: identity.userId,
            conversationId: identity.conversationId,
          });
        } catch (error) {
          await sendProgress(
            progressAfterFailure(
              turn.action,
              error instanceof Error
                ? error.message
                : "Failed to prepare connect link",
            ),
          );
        }
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
        await sendProgress(progressBeforeAction(turn.action, turn));
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
          milestones.push(`create_branch ${created.branch}`);
          await sendProgress(
            progressAfterSuccess(turn.action, { branch: created.branch }),
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to create branch";
          await sendProgress(progressAfterFailure(turn.action, errorMessage));
          toolResults.push({
            action: "create_branch",
            result: { error: errorMessage },
          });
        }
        continue;
      }

      if (turn.action === "commit_files") {
        await sendProgress(progressBeforeAction(turn.action, turn));
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
          milestones.push(
            `commit_files ${committed.changedPaths.join(", ")}`,
          );
          await this.repository.updateWorkingMemory(identity.conversationId, {
            lastCommitSha: committed.sha,
          });
          state = {
            ...state,
            lastCommitSha: committed.sha,
          };
          await sendProgress(
            progressAfterSuccess(turn.action, {
              changedPaths: committed.changedPaths,
            }),
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to commit files";
          await sendProgress(progressAfterFailure(turn.action, errorMessage));
          toolResults.push({
            action: "commit_files",
            result: { error: errorMessage },
          });
        }
        continue;
      }

      if (turn.action === "create_pull_request") {
        await sendProgress(progressBeforeAction(turn.action, turn));
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
          milestones.push(`create_pull_request #${pull.number}`);
          await this.repository.updateWorkingMemory(identity.conversationId, {
            lastPrNumber: pull.number,
            lastPrUrl: pull.url,
          });
          state = {
            ...state,
            lastPrNumber: pull.number,
            lastPrUrl: pull.url,
          };
          toolResults.push({
            action: "create_pull_request",
            result: pull,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to create pull request";
          await sendProgress(progressAfterFailure(turn.action, errorMessage));
          toolResults.push({
            action: "create_pull_request",
            result: { error: errorMessage },
          });
        }
      }
    }

    const finalBody = turn.reply.trim();
    const sameAsLastProgress =
      progress.last !== null &&
      finalBody.toLowerCase() === progress.last.toLowerCase();

    let reply: string | null = sameAsLastProgress ? null : finalBody;
    if (connectUrl) {
      const prefix = reply ?? "Connect GitHub to continue.";
      reply = `${prefix}\n\nConnect GitHub:\n${connectUrl}`;
    } else if (pullRequestUrl) {
      const prefix = reply ?? "Pull request is ready.";
      reply = `${prefix}\n\nPull request:\n${pullRequestUrl}`;
    }

    if (reply) {
      await message.send(reply);
    }

    const assistantContent = reply ?? finalBody;
    const assistantMessage = await this.repository.appendMessage({
      conversationId: identity.conversationId,
      userId: identity.userId,
      role: "assistant",
      content: assistantContent,
      action: connectUrl
        ? "offer_github_connect"
        : pullRequestUrl
          ? "create_pull_request"
          : turn.action,
    });

    try {
      const chunkText = buildTurnMemoryChunk({
        userText: message.text,
        assistantReply: assistantContent,
        milestones,
      });
      const [embedding] = await this.embeddings.embedTexts([chunkText]);
      if (embedding) {
        await this.repository.insertMemoryChunk({
          userId: identity.userId,
          conversationId: identity.conversationId,
          content: chunkText,
          sourceMessageIds: [userMessage.id, assistantMessage.id],
          repo: state.activeRepo,
          branch: state.activeBranch,
          embedding,
        });
      }
    } catch (error) {
      console.error(
        "Failed to persist memory chunk:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

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
