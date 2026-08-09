import { OpenRouter } from "@openrouter/sdk";

import type { RelayConfig } from "../config.ts";

export type ConversationAction =
  | "none"
  | "list_repositories"
  | "select_repository"
  | "offer_github_connect";

export interface ConversationContext {
  firstContact: boolean;
  githubConnected: boolean;
  githubLogin: string | null;
  activeRepo: string | null;
  pendingGithubConfirmation: boolean;
  canListRepositories: boolean;
  canSelectRepository: boolean;
}

export interface ConversationTurnInput {
  userText: string;
  context: ConversationContext;
  toolResults?: Array<{
    action: ConversationAction;
    result: unknown;
  }>;
}

export interface ConversationTurnOutput {
  reply: string;
  action: ConversationAction;
  repository: string | null;
}

export interface ConversationModel {
  turn(input: ConversationTurnInput): Promise<ConversationTurnOutput>;
}

const FALLBACK_REPLY =
  "I can help with your GitHub repos from this chat. Tell me what you need, or ask to connect GitHub if you haven’t yet.";

const SYSTEM_PROMPT = `You are Relay, a conversation-first software engineering assistant over iMessage.
Keep replies short (1-3 sentences). Be direct and helpful.
You receive factual context JSON and optional tool results. Never invent repositories, tokens, or URLs.
Never include http(s) links in reply text.
Actions:
- none: just reply
- list_repositories: list repos available to the connected GitHub App installation
- select_repository: set the active repository (provide repository as owner/name or a clear name)
- offer_github_connect: user should connect GitHub; application will append a trusted link
If GitHub is not connected and the user needs repo access, use offer_github_connect.
If they ask general questions, answer without forcing GitHub.
When pendingGithubConfirmation is true, acknowledge connection briefly and ask which repository to use.
Respond with JSON only matching the schema.`;

function sanitizeReply(reply: string): string {
  return reply
    .replace(/\b(?:https?:\/\/|www\.|github\.com\/)\S*/giu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 800);
}

function parseAction(value: unknown): ConversationAction {
  if (
    value === "list_repositories" ||
    value === "select_repository" ||
    value === "offer_github_connect" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

export function fallbackConversationTurn(): ConversationTurnOutput {
  return {
    reply: FALLBACK_REPLY,
    action: "none",
    repository: null,
  };
}

export class OpenRouterConversationModel implements ConversationModel {
  private readonly complete: (
    input: ConversationTurnInput,
  ) => Promise<ConversationTurnOutput | null>;

  constructor(
    config: RelayConfig["openRouter"],
    complete?: (
      input: ConversationTurnInput,
    ) => Promise<ConversationTurnOutput | null>,
  ) {
    const client = new OpenRouter({ apiKey: config.apiKey });
    this.complete =
      complete ??
      (async (input) => {
        const result = await client.chat.send({
          chatRequest: {
            model: config.model,
            stream: false,
            temperature: 0.2,
            maxTokens: 800,
            responseFormat: {
              type: "json_schema",
              jsonSchema: {
                name: "relay_turn",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    reply: { type: "string" },
                    action: {
                      type: "string",
                      enum: [
                        "none",
                        "list_repositories",
                        "select_repository",
                        "offer_github_connect",
                      ],
                    },
                    repository: { type: ["string", "null"] },
                  },
                  required: ["reply", "action", "repository"],
                },
              },
            },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  userText: input.userText,
                  context: input.context,
                  toolResults: input.toolResults ?? [],
                }),
              },
            ],
          },
        });

        if (!("choices" in result)) return null;
        const content = result.choices[0]?.message.content;
        if (typeof content !== "string") return null;

        const parsed = JSON.parse(content) as {
          reply?: unknown;
          action?: unknown;
          repository?: unknown;
        };

        if (typeof parsed.reply !== "string") return null;

        return {
          reply: parsed.reply,
          action: parseAction(parsed.action),
          repository:
            typeof parsed.repository === "string" ? parsed.repository : null,
        };
      });
  }

  async turn(input: ConversationTurnInput): Promise<ConversationTurnOutput> {
    try {
      const output = await this.complete(input);
      if (!output) return fallbackConversationTurn();

      const reply = sanitizeReply(output.reply);
      if (!reply) return fallbackConversationTurn();

      if (
        output.action === "select_repository" &&
        (!output.repository || !output.repository.trim())
      ) {
        return {
          reply,
          action: "none",
          repository: null,
        };
      }

      return {
        reply,
        action: output.action,
        repository: output.repository?.trim() || null,
      };
    } catch (error) {
      console.error(
        "OpenRouter conversation turn failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return fallbackConversationTurn();
    }
  }
}
