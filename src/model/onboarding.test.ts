import { expect, spyOn, test } from "bun:test";

import {
  fallbackOnboarding,
  OpenRouterOnboardingGenerator,
} from "./onboarding.ts";

const config = {
  apiKey: "test-key",
  model: "test/model",
};

test("uses deterministic onboarding copy when OpenRouter fails", async () => {
  const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
  const generator = new OpenRouterOnboardingGenerator(config, async () => {
    throw new Error("provider unavailable");
  });

  expect(await generator.generate({ firstContact: true })).toBe(
    fallbackOnboarding(true),
  );
  expect(errorLog).toHaveBeenCalledTimes(1);
  errorLog.mockRestore();
});

test("rejects model-generated URLs before trusted link assembly", async () => {
  const generator = new OpenRouterOnboardingGenerator(
    config,
    async () => "Connect at https://untrusted.example/token now.",
  );

  const result = await generator.generate({ firstContact: false });

  expect(result).not.toContain("https://");
  expect(result).toBe(fallbackOnboarding(false));
});
