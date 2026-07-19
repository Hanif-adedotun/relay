import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

import { loadConfig } from "./config.ts";
import { createSupabaseClient } from "./db/client.ts";
import { SupabaseRelayRepository } from "./db/relay-repository.ts";
import { GitHubAuthStateService } from "./github/auth-state.ts";
import { createGitHubCallbackHandler } from "./github/callback.ts";
import { OpenRouterOnboardingGenerator } from "./model/onboarding.ts";
import { RelayMessagePipeline } from "./pipeline/handle-message.ts";

const config = loadConfig();
const repository = new SupabaseRelayRepository(
  createSupabaseClient(config.supabase),
);
const onboarding = new OpenRouterOnboardingGenerator(config.openRouter);
const githubAuth = new GitHubAuthStateService(repository, config.github);
const pipeline = new RelayMessagePipeline(
  repository,
  onboarding,
  githubAuth,
);

const app = await Spectrum({
  projectId: config.spectrum.projectId,
  projectSecret: config.spectrum.projectSecret,
  providers: [imessage.config()],
});

Bun.serve({
  port: config.http.port,
  fetch: createGitHubCallbackHandler({
    config: config.github,
    repository,
    notifyConnected: async (conversationId) => {
      const target = await repository.getNotificationTarget(conversationId);
      if (!target || target.platform !== "iMessage") return false;

      const iMessage = imessage(app);
      const user = await iMessage.user(target.externalUserId);
      const space = await iMessage.space.create(user);
      await space.send(
        "GitHub is connected. Next, text me the repository you want Relay to use.",
      );
      return true;
    },
  }),
});

for await (const [space, message] of app.messages) {
  if (
    message.direction !== "inbound" ||
    message.content.type !== "text" ||
    !message.sender
  ) {
    continue;
  }

  try {
    const result = await pipeline.handle({
      platform: message.platform,
      senderId: message.sender.id,
      spaceId: space.id,
      text: message.content.text,
      send: async (text) => {
        await space.send(text);
      },
    });

    if (result.status === "ready" && !result.confirmationSent) {
      await space.send(
        "GitHub is connected. Repository and project setup is the next onboarding step.",
      );
    }
  } catch (error) {
    console.error(
      "Relay message pipeline failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    await space.send(
      "I couldn’t process that message right now. Please try again shortly.",
    );
  }
}
