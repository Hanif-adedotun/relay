import type { RelayConfig } from "../config.ts";

export interface EmbeddingClient {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export function createOpenRouterEmbeddingClient(
  config: RelayConfig["openRouter"],
): EmbeddingClient {
  return {
    async embedTexts(texts) {
      if (texts.length === 0) return [];

      const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.embeddingModel,
          input: texts,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `OpenRouter embeddings failed (${response.status}): ${detail.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const rows = [...(payload.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      if (rows.length !== texts.length) {
        throw new Error("OpenRouter embeddings returned unexpected count");
      }

      return rows.map((row) => {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new Error("OpenRouter embeddings returned an empty vector");
        }
        return row.embedding;
      });
    },
  };
}
