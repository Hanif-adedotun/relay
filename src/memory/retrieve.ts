import type {
  ConversationMessage,
  MemoryChunkSearchResult,
  RelayRepository,
} from "../db/relay-repository.ts";
import type { EmbeddingClient } from "./embeddings.ts";

export const MAX_RETRIEVED_CHARS = 2000;
export const DEFAULT_RETRIEVAL_LIMIT = 5;

export function filterOverlappingChunks(
  chunks: MemoryChunkSearchResult[],
  recentMessages: ConversationMessage[],
): MemoryChunkSearchResult[] {
  const recentIds = new Set(recentMessages.map((message) => message.id));
  return chunks.filter(
    (chunk) =>
      !chunk.sourceMessageIds.some((messageId) => recentIds.has(messageId)),
  );
}

export function truncateRetrievedSnippets(
  snippets: string[],
  maxChars = MAX_RETRIEVED_CHARS,
): string[] {
  const selected: string[] = [];
  let used = 0;
  for (const snippet of snippets) {
    const trimmed = snippet.trim();
    if (!trimmed) continue;
    const next = used === 0 ? trimmed.length : used + 1 + trimmed.length;
    if (next > maxChars) break;
    selected.push(trimmed);
    used = next;
  }
  return selected;
}

export async function retrieveMemory(input: {
  repository: RelayRepository;
  embeddings: EmbeddingClient;
  userId: string;
  userText: string;
  recentMessages: ConversationMessage[];
  activeRepo?: string | null;
  limit?: number;
}): Promise<string[]> {
  const query = [input.userText.trim(), input.activeRepo?.trim()]
    .filter(Boolean)
    .join("\n");
  if (!query) return [];

  try {
    const [embedding] = await input.embeddings.embedTexts([query]);
    if (!embedding) return [];

    const chunks = await input.repository.searchMemoryChunks(
      input.userId,
      embedding,
      input.limit ?? DEFAULT_RETRIEVAL_LIMIT,
    );
    const filtered = filterOverlappingChunks(chunks, input.recentMessages);
    return truncateRetrievedSnippets(filtered.map((chunk) => chunk.content));
  } catch (error) {
    console.error(
      "Memory retrieval failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

export function buildTurnMemoryChunk(input: {
  userText: string;
  assistantReply: string;
  milestones: string[];
}): string {
  const parts = [
    `User: ${input.userText.trim()}`,
    `Assistant: ${input.assistantReply.trim()}`,
  ];
  if (input.milestones.length > 0) {
    parts.push(`Actions: ${input.milestones.join("; ")}`);
  }
  return parts.join("\n");
}
