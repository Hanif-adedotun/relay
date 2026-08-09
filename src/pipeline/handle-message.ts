import type { RelayRepository } from "../db/relay-repository.ts";
import type { GitHubAuthStateService } from "../github/auth-state.ts";
import type { GitHubReposClient } from "../github/repos.ts";
import type {
  ConversationAction,
  ConversationModel,
  ConversationTurnOutput,
} from "../model/conversation.ts";
import { fallbackConversationTurn } from "../model/conversation.ts";

const MAX_TOOL_ITERATIONS = 3;

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

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      turn = await this.conversation.turn({
        userText: message.text,
        context: {
          firstContact: identity.isNewUser && iteration === 0,
          githubConnected: state.github !== null,
          githubLogin: state.github?.githubLogin ?? null,
          activeRepo: state.activeRepo,
          pendingGithubConfirmation: state.pendingGithubConfirmation,
          canListRepositories: state.github !== null,
          canSelectRepository: state.github !== null,
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
      }
    }

    const reply = connectUrl
      ? `${turn.reply}\n\nConnect GitHub:\n${connectUrl}`
      : turn.reply;

    await message.send(reply);

    return {
      status: "replied",
      userId: identity.userId,
      conversationId: identity.conversationId,
      action: connectUrl ? "offer_github_connect" : turn.action,
    };
  }
}
