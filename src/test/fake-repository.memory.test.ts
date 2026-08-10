import { expect, test } from "bun:test";

import { FakeRelayRepository } from "./fake-repository.ts";

test("listRecentMessages returns oldest-first capped history", async () => {
  const repository = new FakeRelayRepository();
  const identity = await repository.resolveIdentity({
    platform: "iMessage",
    externalUserId: "+1",
    externalSpaceId: "chat",
  });

  for (let i = 0; i < 5; i += 1) {
    await repository.appendMessage({
      conversationId: identity.conversationId,
      userId: identity.userId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    });
  }

  const recent = await repository.listRecentMessages(
    identity.conversationId,
    3,
  );
  expect(recent.map((message) => message.content)).toEqual([
    "msg-2",
    "msg-3",
    "msg-4",
  ]);
});

test("updateWorkingMemory stores PR and commit fields", async () => {
  const repository = new FakeRelayRepository();
  const identity = await repository.resolveIdentity({
    platform: "iMessage",
    externalUserId: "+1",
    externalSpaceId: "chat",
  });

  await repository.updateWorkingMemory(identity.conversationId, {
    lastPrNumber: 7,
    lastPrUrl: "https://example.test/pull/7",
    lastCommitSha: "abc1234",
  });

  const state = await repository.getConversationState({
    userId: identity.userId,
    conversationId: identity.conversationId,
  });
  expect(state.lastPrNumber).toBe(7);
  expect(state.lastPrUrl).toBe("https://example.test/pull/7");
  expect(state.lastCommitSha).toBe("abc1234");
});
