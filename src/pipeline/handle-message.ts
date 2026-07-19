import type { RelayRepository } from "../db/relay-repository.ts";
import type { GitHubAuthStateService } from "../github/auth-state.ts";
import type { OnboardingGenerator } from "../model/onboarding.ts";

export interface InboundTextMessage {
  platform: string;
  senderId: string;
  spaceId: string;
  text: string;
  send(text: string): Promise<void>;
}

export type MessageGateResult =
  | { status: "awaiting_github" }
  | {
      status: "ready";
      userId: string;
      conversationId: string;
      confirmationSent: boolean;
    };

export class RelayMessagePipeline {
  constructor(
    private readonly repository: RelayRepository,
    private readonly onboarding: OnboardingGenerator,
    private readonly githubAuth: GitHubAuthStateService,
  ) {}

  async handle(message: InboundTextMessage): Promise<MessageGateResult> {
    const identity = await this.repository.resolveIdentity({
      platform: message.platform,
      externalUserId: message.senderId,
      externalSpaceId: message.spaceId,
    });

    const connected = await this.repository.hasGitHubConnection(identity.userId);
    if (!connected) {
      const [copy, installUrl] = await Promise.all([
        this.onboarding.generate({ firstContact: identity.isNewUser }),
        this.githubAuth.createAuthorizationUrl({
          userId: identity.userId,
          conversationId: identity.conversationId,
        }),
      ]);

      await message.send(`${copy}\n\nConnect GitHub:\n${installUrl}`);
      return { status: "awaiting_github" };
    }

    const confirmationPending =
      await this.repository.consumeGitHubConfirmation(identity.conversationId);

    if (confirmationPending) {
      await message.send(
        "GitHub is connected. Next, tell me which repository you want Relay to use.",
      );
    }

    return {
      status: "ready",
      userId: identity.userId,
      conversationId: identity.conversationId,
      confirmationSent: confirmationPending,
    };
  }
}
