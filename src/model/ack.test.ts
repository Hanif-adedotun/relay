import { describe, expect, test } from "bun:test";

import {
  ACK_FALLBACK,
  OpenRouterAckModel,
  parseAckContent,
  shouldSkipAck,
  stripJsonFences,
  withAckTimeout,
} from "./ack.ts";

describe("shouldSkipAck", () => {
  test("skips short affirmations", () => {
    expect(shouldSkipAck("yes")).toBe(true);
    expect(shouldSkipAck(" OK ")).toBe(true);
    expect(shouldSkipAck("Thanks")).toBe(true);
  });

  test("does not skip real requests", () => {
    expect(shouldSkipAck("list my repos")).toBe(false);
    expect(shouldSkipAck("yes please create a branch")).toBe(false);
  });
});

describe("parseAckContent", () => {
  test("parses raw JSON", () => {
    expect(parseAckContent('{"ack":"Got it…"}')).toBe("Got it…");
  });

  test("strips markdown fences before parse", () => {
    expect(stripJsonFences('```json\n{"ack":"Looking into that…"}\n```')).toBe(
      '{"ack":"Looking into that…"}',
    );
    expect(
      parseAckContent('```json\n{"ack":"Looking into that…"}\n```'),
    ).toBe("Looking into that…");
  });

  test("returns null for invalid payloads", () => {
    expect(parseAckContent("not json")).toBeNull();
    expect(parseAckContent('{"ack":1}')).toBeNull();
  });
});

describe("withAckTimeout", () => {
  test("returns fallback when the promise is slow", async () => {
    const result = await withAckTimeout(
      new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
      ACK_FALLBACK,
      10,
    );
    expect(result).toBe(ACK_FALLBACK);
  });
});

describe("OpenRouterAckModel", () => {
  test("uses stubbed complete and falls back on null", async () => {
    const model = new OpenRouterAckModel(
      {
        apiKey: "test",
        model: "main",
        embeddingModel: "embed",
        ackModel: "ack",
      },
      async () => "Looking into that…",
    );
    expect(
      await model.acknowledge({
        userText: "list repos",
        activeRepo: null,
        githubConnected: true,
      }),
    ).toBe("Looking into that…");

    const falling = new OpenRouterAckModel(
      {
        apiKey: "test",
        model: "main",
        embeddingModel: "embed",
        ackModel: "ack",
      },
      async () => null,
    );
    expect(
      await falling.acknowledge({
        userText: "hi",
        activeRepo: null,
        githubConnected: false,
      }),
    ).toBe(ACK_FALLBACK);
  });
});
