import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

import { loadConfig } from "./config.ts";
import { createSupabaseClient } from "./db/client.ts";
import { SupabaseRelayRepository } from "./db/relay-repository.ts";
import { GitHubAuthStateService } from "./github/auth-state.ts";
import { createGitHubCallbackHandler } from "./github/callback.ts";
import { createInstallationReposClient } from "./github/repos.ts";
import { createOpenRouterEmbeddingClient } from "./memory/embeddings.ts";
import { OpenRouterAckModel } from "./model/ack.ts";
import { OpenRouterConversationModel } from "./model/conversation.ts";
import { RelayMessagePipeline } from "./pipeline/handle-message.ts";

const config = loadConfig();
const repository = new SupabaseRelayRepository(
  createSupabaseClient(config.supabase),
);
const conversation = new OpenRouterConversationModel(config.openRouter);
const githubAuth = new GitHubAuthStateService(repository, config.github);
const githubRepos = createInstallationReposClient(config.github);
const embeddings = createOpenRouterEmbeddingClient(config.openRouter);
const ack = new OpenRouterAckModel(config.openRouter);
const pipeline = new RelayMessagePipeline(
  repository,
  conversation,
  githubAuth,
  githubRepos,
  embeddings,
  ack,
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
      if (!target || target.platform !== "iMessage") {
        return false;
      }

      const im = imessage(app);
      const space = await im.space.get(target.externalSpaceId);
      await space.send(
        "GitHub connected successfully. Which repository should we use?",
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
    await pipeline.handle({
      platform: message.platform,
      senderId: message.sender.id,
      spaceId: space.id,
      text: message.content.text,
      send: async (text) => {
        await space.send(text);
      },
    });
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
