import { expect, spyOn, test } from "bun:test";

import {
  fallbackConversationTurn,
  OpenRouterConversationModel,
} from "./conversation.ts";

const config = {
  apiKey: "test-key",
  model: "test/model",
};

const baseInput = {
  userText: "hello",
  context: {
    firstContact: true,
    githubConnected: false,
    githubLogin: null,
    activeRepo: null,
    activeBranch: null,
    pendingGithubConfirmation: false,
    canListRepositories: false,
    canSelectRepository: false,
    canListBranches: false,
    canInspectRepository: false,
  },
};

test("uses deterministic fallback when OpenRouter fails", async () => {
  const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
  const model = new OpenRouterConversationModel(config, async () => {
    throw new Error("provider unavailable");
  });

  expect(await model.turn(baseInput)).toEqual(fallbackConversationTurn());
  expect(errorLog).toHaveBeenCalledTimes(1);
  errorLog.mockRestore();
});

test("strips model-generated URLs from replies", async () => {
  const model = new OpenRouterConversationModel(config, async () => ({
    reply: "Connect at https://evil.example/token now.",
    action: "none",
    repository: null,
    branch: null,
  }));

  const result = await model.turn(baseInput);

  expect(result.reply).not.toContain("https://");
  expect(result.reply).toBe("Connect at now.");
});

test("drops select_branch when branch is missing", async () => {
  const model = new OpenRouterConversationModel(config, async () => ({
    reply: "Which branch?",
    action: "select_branch",
    repository: null,
    branch: null,
  }));

  const result = await model.turn(baseInput);

  expect(result).toEqual({
    reply: "Which branch?",
    action: "none",
    repository: null,
    branch: null,
  });
});
