import { OpenRouter } from "@openrouter/sdk";

import type { RelayConfig } from "../config.ts";

export interface OnboardingGenerator {
  generate(input: { firstContact: boolean }): Promise<string>;
}

const FIRST_CONTACT_FALLBACK =
  "Hi — I’m Relay, your conversational software-engineering assistant. I can help you work with trusted repositories from this chat. First, connect GitHub and choose which repositories I may access.";

const RETURNING_FALLBACK =
  "GitHub is not connected yet. Use the secure link below to connect it and choose which repositories Relay may access.";

export class OpenRouterOnboardingGenerator implements OnboardingGenerator {
  private readonly complete: (firstContact: boolean) => Promise<string | null>;

  constructor(
    config: RelayConfig["openRouter"],
    complete?: (firstContact: boolean) => Promise<string | null>,
  ) {
    const client = new OpenRouter({ apiKey: config.apiKey });
    this.complete =
      complete ??
      (async (firstContact) => {
        const result = await client.chat.send({
          chatRequest: {
            model: config.model,
            stream: false,
            temperature: 0.2,
            maxTokens: 180,
            messages: [
              {
                role: "system",
                content:
                  "You write brief iMessage onboarding copy for Relay, a conversation-first assistant for software engineering. Explain that Relay helps users work with repositories from chat. The only next step is connecting GitHub and selecting trusted repositories. Use plain text, at most three short sentences. Do not output URLs, secrets, markdown, or claim GitHub is already connected.",
              },
              {
                role: "user",
                content: JSON.stringify({
                  firstContact,
                  githubConnected: false,
                }),
              },
            ],
          },
        });

        if (!("choices" in result)) return null;
        const content = result.choices[0]?.message.content;
        return typeof content === "string" ? content : null;
      });
  }

  async generate(input: { firstContact: boolean }): Promise<string> {
    const fallback = input.firstContact
      ? FIRST_CONTACT_FALLBACK
      : RETURNING_FALLBACK;

    try {
      const content = await this.complete(input.firstContact);
      if (!content) return fallback;

      if (/\b(?:https?:\/\/|www\.|github\.com)\S*/iu.test(content)) {
        return fallback;
      }

      const safeContent = content.trim().slice(0, 600);

      return safeContent || fallback;
    } catch (error) {
      console.error(
        "OpenRouter onboarding generation failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return fallback;
    }
  }
}

export function fallbackOnboarding(firstContact: boolean): string {
  return firstContact ? FIRST_CONTACT_FALLBACK : RETURNING_FALLBACK;
}
