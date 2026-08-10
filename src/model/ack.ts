import { OpenRouter } from "@openrouter/sdk";

import type { RelayConfig } from "../config.ts";

export const ACK_TIMEOUT_MS = 600;
export const ACK_FALLBACK = "On it…";

const SKIP_ACK_TEXTS = new Set([
  "ok",
  "okay",
  "yes",
  "y",
  "yep",
  "yeah",
  "sure",
  "thanks",
  "thx",
  "k",
]);

const SYSTEM_PROMPT = `You write a single short iMessage status line for Relay.
Acknowledge the user's message without answering it.
Tone examples: Got it… / Looking that up… / On it — implementing… / Checking GitHub…
Never invent facts, never include links, never ask questions.
Keep it under 80 characters.`;

export interface AckInput {
  userText: string;
  activeRepo: string | null;
  githubConnected: boolean;
}

export interface AckModel {
  acknowledge(input: AckInput): Promise<string>;
}

export function shouldSkipAck(userText: string): boolean {
  return SKIP_ACK_TEXTS.has(userText.trim().toLowerCase());
}

export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function sanitizeAck(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.|github\.com\/)\S*/giu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80);
}

export function parseAckContent(content: string): string | null {
  try {
    const parsed = JSON.parse(stripJsonFences(content)) as { ack?: unknown };
    if (typeof parsed.ack !== "string") return null;
    const cleaned = sanitizeAck(parsed.ack);
    return cleaned || null;
  } catch {
    return null;
  }
}

export async function withAckTimeout(
  promise: Promise<string>,
  fallback: string = ACK_FALLBACK,
  timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class OpenRouterAckModel implements AckModel {
  private readonly complete: (input: AckInput) => Promise<string | null>;

  constructor(
    config: RelayConfig["openRouter"],
    complete?: (input: AckInput) => Promise<string | null>,
  ) {
    const client = new OpenRouter({ apiKey: config.apiKey });
    this.complete =
      complete ??
      (async (input) => {
        const result = await client.chat.send({
          chatRequest: {
            model: config.ackModel,
            stream: false,
            temperature: 0.3,
            maxTokens: 40,
            responseFormat: {
              type: "json_schema",
              jsonSchema: {
                name: "relay_ack",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ack: { type: "string" },
                  },
                  required: ["ack"],
                },
              },
            },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  userText: input.userText,
                  activeRepo: input.activeRepo,
                  githubConnected: input.githubConnected,
                }),
              },
            ],
          },
        });

        if (!("choices" in result)) return null;
        const content = result.choices[0]?.message.content;
        if (typeof content !== "string") return null;
        return parseAckContent(content);
      });
  }

  async acknowledge(input: AckInput): Promise<string> {
    try {
      const ack = await this.complete(input);
      return ack ?? ACK_FALLBACK;
    } catch (error) {
      console.error(
        "OpenRouter ack failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return ACK_FALLBACK;
    }
  }
}
