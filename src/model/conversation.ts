import { OpenRouter } from "@openrouter/sdk";

import type { RelayConfig } from "../config.ts";

export type ConversationAction =
  | "none"
  | "list_repositories"
  | "select_repository"
  | "list_branches"
  | "select_branch"
  | "inspect_repository"
  | "create_branch"
  | "commit_files"
  | "create_pull_request"
  | "offer_github_connect";

export type CommitMode = "upsert" | "replace";

export interface ConversationFileChange {
  path: string;
  content: string | null;
}

export interface ConversationContext {
  firstContact: boolean;
  githubConnected: boolean;
  githubLogin: string | null;
  activeRepo: string | null;
  activeBranch: string | null;
  lastPrNumber: number | null;
  lastPrUrl: string | null;
  lastCommitSha: string | null;
  pendingGithubConfirmation: boolean;
  canListRepositories: boolean;
  canSelectRepository: boolean;
  canListBranches: boolean;
  canInspectRepository: boolean;
  canWriteRepository: boolean;
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ConversationTurnInput {
  userText: string;
  context: ConversationContext;
  recentMessages?: ConversationHistoryMessage[];
  retrievedMemory?: string[];
  toolResults?: Array<{
    action: ConversationAction;
    result: unknown;
  }>;
}

export interface ConversationTurnOutput {
  reply: string;
  action: ConversationAction;
  repository: string | null;
  branch: string | null;
  commitMessage: string | null;
  commitMode: CommitMode | null;
  files: ConversationFileChange[] | null;
  prTitle: string | null;
  prBody: string | null;
}

export interface ConversationModel {
  turn(input: ConversationTurnInput): Promise<ConversationTurnOutput>;
}

const FALLBACK_REPLY =
  "I can help with your GitHub repos from this chat. Tell me what you need, or ask to connect GitHub if you haven’t yet.";

const SYSTEM_PROMPT = `You are Relay, a conversation-first software engineering assistant over iMessage.
Keep replies short (1-3 sentences). Be direct and helpful.
You receive factual context JSON, recentMessages, optional retrievedMemory, and optional tool results. Never invent repositories, branches, tokens, URLs, or file contents.
Never include http(s) links in reply text.
Use recentMessages for short-term continuity in this chat.
Use retrievedMemory as optional older facts about this client; prefer working-memory fields (activeRepo, activeBranch, lastPrNumber, lastPrUrl, lastCommitSha) for current session truth.
Actions:
- none: just reply
- list_repositories: list repos available to the connected GitHub App installation
- select_repository: set the active repository (provide repository as owner/name or a clear name)
- list_branches: list branches for the active repository
- select_branch: set the active branch (provide branch)
- inspect_repository: fetch README, top-level files, manifests, and recent commits for the active repo (optional branch ref)
- create_branch: create a branch from the active/default branch (provide branch)
- commit_files: commit file creates/updates/deletes on a branch (provide branch, commitMessage, commitMode, files)
- create_pull_request: open a PR from branch into the default branch (provide branch as head, prTitle, optional prBody)
- offer_github_connect: user should connect GitHub; application will append a trusted link
commitMode:
- upsert: create/update listed files; set content null to delete a path
- replace: new commit tree contains ONLY the provided files (destructive; requires clear user intent to wipe/replace the repo)
Never invent file contents; use text the user provided (or empty string only if they asked for an empty file).
If GitHub is not connected and the user needs repo access, use offer_github_connect.
If they ask general questions, answer without forcing GitHub.
When pendingGithubConfirmation is true, acknowledge connection briefly and ask which repository to use.
If the user needs branches, writes, or a codebase summary and there is no activeRepo, select_repository first (or list_repositories if unclear).
When they ask what a repo/codebase does, or about structure/stack/README, use inspect_repository then answer only from tool results.
When they ask about branches, use list_branches; when they pick one, use select_branch.
For create branch → commit → open PR workflows, run actions in sequence across tool turns.
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
    value === "list_branches" ||
    value === "select_branch" ||
    value === "inspect_repository" ||
    value === "create_branch" ||
    value === "commit_files" ||
    value === "create_pull_request" ||
    value === "offer_github_connect" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

function parseCommitMode(value: unknown): CommitMode | null {
  if (value === "upsert" || value === "replace") return value;
  return null;
}

function parseFiles(value: unknown): ConversationFileChange[] | null {
  if (!Array.isArray(value)) return null;
  const files: ConversationFileChange[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const path =
      "path" in entry && typeof entry.path === "string" ? entry.path.trim() : "";
    if (!path) continue;
    const content =
      "content" in entry
        ? entry.content === null
          ? null
          : typeof entry.content === "string"
            ? entry.content
            : null
        : null;
    if (!("content" in entry)) continue;
    if (entry.content !== null && typeof entry.content !== "string") continue;
    files.push({ path, content });
  }
  return files.length > 0 ? files : null;
}

export function emptyTurnFields(): Pick<
  ConversationTurnOutput,
  | "repository"
  | "branch"
  | "commitMessage"
  | "commitMode"
  | "files"
  | "prTitle"
  | "prBody"
> {
  return {
    repository: null,
    branch: null,
    commitMessage: null,
    commitMode: null,
    files: null,
    prTitle: null,
    prBody: null,
  };
}

export function fallbackConversationTurn(): ConversationTurnOutput {
  return {
    reply: FALLBACK_REPLY,
    action: "none",
    ...emptyTurnFields(),
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
            maxTokens: 2000,
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
                        "list_branches",
                        "select_branch",
                        "inspect_repository",
                        "create_branch",
                        "commit_files",
                        "create_pull_request",
                        "offer_github_connect",
                      ],
                    },
                    repository: { type: ["string", "null"] },
                    branch: { type: ["string", "null"] },
                    commitMessage: { type: ["string", "null"] },
                    commitMode: {
                      type: ["string", "null"],
                      enum: ["upsert", "replace", null],
                    },
                    files: {
                      type: ["array", "null"],
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          path: { type: "string" },
                          content: { type: ["string", "null"] },
                        },
                        required: ["path", "content"],
                      },
                    },
                    prTitle: { type: ["string", "null"] },
                    prBody: { type: ["string", "null"] },
                  },
                  required: [
                    "reply",
                    "action",
                    "repository",
                    "branch",
                    "commitMessage",
                    "commitMode",
                    "files",
                    "prTitle",
                    "prBody",
                  ],
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
                  recentMessages: input.recentMessages ?? [],
                  retrievedMemory: input.retrievedMemory ?? [],
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
          branch?: unknown;
          commitMessage?: unknown;
          commitMode?: unknown;
          files?: unknown;
          prTitle?: unknown;
          prBody?: unknown;
        };

        if (typeof parsed.reply !== "string") return null;

        return {
          reply: parsed.reply,
          action: parseAction(parsed.action),
          repository:
            typeof parsed.repository === "string" ? parsed.repository : null,
          branch: typeof parsed.branch === "string" ? parsed.branch : null,
          commitMessage:
            typeof parsed.commitMessage === "string"
              ? parsed.commitMessage
              : null,
          commitMode: parseCommitMode(parsed.commitMode),
          files: parseFiles(parsed.files),
          prTitle: typeof parsed.prTitle === "string" ? parsed.prTitle : null,
          prBody: typeof parsed.prBody === "string" ? parsed.prBody : null,
        };
      });
  }

  async turn(input: ConversationTurnInput): Promise<ConversationTurnOutput> {
    try {
      const output = await this.complete(input);
      if (!output) return fallbackConversationTurn();

      const reply = sanitizeReply(output.reply);
      if (!reply) return fallbackConversationTurn();

      const base = {
        reply,
        repository: output.repository?.trim() || null,
        branch: output.branch?.trim() || null,
        commitMessage: output.commitMessage?.trim() || null,
        commitMode: output.commitMode,
        files: output.files,
        prTitle: output.prTitle?.trim() || null,
        prBody: output.prBody?.trim() || null,
      };

      if (
        output.action === "select_repository" &&
        (!base.repository || !base.repository.trim())
      ) {
        return { ...base, action: "none", ...emptyTurnFields(), reply };
      }

      if (
        (output.action === "select_branch" ||
          output.action === "create_branch") &&
        !base.branch
      ) {
        return { ...base, action: "none", ...emptyTurnFields(), reply };
      }

      if (output.action === "commit_files") {
        if (!base.branch || !base.commitMessage || !base.commitMode || !base.files) {
          return { ...base, action: "none", ...emptyTurnFields(), reply };
        }
      }

      if (output.action === "create_pull_request") {
        if (!base.branch || !base.prTitle) {
          return { ...base, action: "none", ...emptyTurnFields(), reply };
        }
      }

      return {
        ...base,
        action: output.action,
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
