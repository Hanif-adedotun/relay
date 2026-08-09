import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { RelayConfig } from "../config.ts";

export interface GitHubRepositorySummary {
  fullName: string;
  private: boolean;
}

export interface GitHubReposClient {
  listRepositories(installationId: number): Promise<GitHubRepositorySummary[]>;
  findRepository(
    installationId: number,
    query: string,
  ): Promise<GitHubRepositorySummary | null>;
}

function formatGitHubError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }

  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  const response =
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null
      ? (error.response as {
          headers?: Record<string, string | undefined>;
          data?: unknown;
        })
      : undefined;
  const requestId =
    response?.headers?.["x-github-request-id"] ??
    response?.headers?.["x-github-delivery"] ??
    undefined;
  const dataMessage =
    typeof response?.data === "object" &&
    response.data !== null &&
    "message" in response.data &&
    typeof response.data.message === "string"
      ? response.data.message
      : undefined;

  const parts = [
    error.message,
    status !== undefined ? `status=${status}` : "status=none",
    requestId ? `request_id=${requestId}` : "request_id=none",
  ];
  if (dataMessage && dataMessage !== error.message) {
    parts.push(`github=${dataMessage}`);
  }
  return parts.join(" ");
}

function createInstallationOctokit(
  config: RelayConfig["github"],
  installationId: number,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      installationId,
    },
    // Octokit's default info logs look like "undefined with id UNKNOWN".
    log: {
      debug: () => {},
      info: () => {},
      warn: (message) => console.warn(`[github] ${message}`),
      error: (message) => console.error(`[github] ${message}`),
    },
  });
}

export function createInstallationReposClient(
  config: RelayConfig["github"],
): GitHubReposClient {
  return {
    async listRepositories(installationId) {
      console.info(
        `[github] listing repositories for installation ${installationId}`,
      );
      const github = createInstallationOctokit(config, installationId);

      try {
        const repositories: GitHubRepositorySummary[] = [];
        for await (const response of github.paginate.iterator(
          github.rest.apps.listReposAccessibleToInstallation,
          { per_page: 100 },
        )) {
          for (const repository of response.data) {
            repositories.push({
              fullName: repository.full_name,
              private: repository.private,
            });
          }
        }

        console.info(
          `[github] listed ${repositories.length} repositories for installation ${installationId}`,
        );
        return repositories;
      } catch (error) {
        const detail = formatGitHubError(error);
        console.error(
          `[github] failed to list repositories for installation ${installationId}: ${detail}`,
        );
        throw new Error(
          `Failed to list GitHub repositories for installation ${installationId}: ${detail}`,
          { cause: error },
        );
      }
    },

    async findRepository(installationId, query) {
      console.info(
        `[github] finding repository "${query}" for installation ${installationId}`,
      );
      const repositories = await this.listRepositories(installationId);
      const normalized = query
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/github\.com\//, "");
      const exact = repositories.find(
        (repository) => repository.fullName.toLowerCase() === normalized,
      );
      if (exact) {
        console.info(`[github] matched repository ${exact.fullName}`);
        return exact;
      }

      const byName = repositories.filter((repository) => {
        const name = repository.fullName.split("/")[1]?.toLowerCase();
        return (
          name === normalized ||
          repository.fullName.toLowerCase().endsWith(`/${normalized}`)
        );
      });

      if (byName.length === 1) {
        console.info(`[github] matched repository ${byName[0]!.fullName}`);
        return byName[0]!;
      }

      console.info(
        `[github] no unique match for "${query}" among ${repositories.length} repositories`,
      );
      return null;
    },
  };
}
