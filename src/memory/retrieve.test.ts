import { expect, test } from "bun:test";

import type { ConversationMessage } from "../db/relay-repository.ts";
import {
  filterOverlappingChunks,
  truncateRetrievedSnippets,
} from "./retrieve.ts";

test("filterOverlappingChunks drops chunks covered by recent messages", () => {
  const recent: ConversationMessage[] = [
    {
      id: "m1",
      conversationId: "c1",
      userId: "u1",
      role: "user",
      content: "hi",
      action: null,
      createdAt: new Date(),
    },
    {
      id: "m2",
      conversationId: "c1",
      userId: "u1",
      role: "assistant",
      content: "hello",
      action: null,
      createdAt: new Date(),
    },
  ];

  const filtered = filterOverlappingChunks(
    [
      {
        id: "chunk-old",
        conversationId: "c1",
        content: "older fact",
        kind: "turn",
        sourceMessageIds: ["m0"],
        repo: null,
        branch: null,
        createdAt: new Date(),
        distance: 0.1,
      },
      {
        id: "chunk-recent",
        conversationId: "c1",
        content: "already in window",
        kind: "turn",
        sourceMessageIds: ["m1", "m2"],
        repo: null,
        branch: null,
        createdAt: new Date(),
        distance: 0.2,
      },
    ],
    recent,
  );

  expect(filtered.map((chunk) => chunk.id)).toEqual(["chunk-old"]);
});

test("truncateRetrievedSnippets respects the character budget", () => {
  expect(
    truncateRetrievedSnippets(["alpha", "beta", "gamma"], 12),
  ).toEqual(["alpha", "beta"]);
});
