import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { RelayConfig } from "../config.ts";

const MAX_BRANCHES = 50;
const MAX_TOP_LEVEL_ENTRIES = 40;
const MAX_README_CHARS = 4000;
const MAX_MANIFEST_CHARS = 2000;
const MAX_RECENT_COMMITS = 5;

const MANIFEST_PATHS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

export interface GitHubRepositorySummary {
  fullName: string;
  private: boolean;
}

export interface GitHubBranchSummary {
  name: string;
  protected: boolean;
}

export interface GitHubBranchList {
  defaultBranch: string;
  branches: GitHubBranchSummary[];
  truncated: boolean;
}

export interface GitHubTreeEntry {
  path: string;
  type: "file" | "dir";
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface GitHubRepositoryInspection {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  ref: string;
  language: string | null;
  topLevel: GitHubTreeEntry[];
  readme: { path: string; text: string } | null;
  manifests: Array<{ path: string; text: string }>;
  recentCommits: GitHubCommitSummary[];
}

export interface GitHubReposClient {
  listRepositories(installationId: number): Promise<GitHubRepositorySummary[]>;
  findRepository(
    installationId: number,
    query: string,
  ): Promise<GitHubRepositorySummary | null>;
  listBranches(
    installationId: number,
    fullName: string,
  ): Promise<GitHubBranchList>;
  inspectRepository(
    installationId: number,
    fullName: string,
    ref?: string,
  ): Promise<GitHubRepositoryInspection>;
}

export function parseRepositoryFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid repository full name "${fullName}"`);
  }
  return { owner, repo };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function decodeBase64Content(content: string): string {
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
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

async function fetchOptionalFileText(
  github: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxChars: number,
): Promise<string | null> {
  try {
    const response = await github.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    if (typeof data.content !== "string") return null;
    return truncateText(decodeBase64Content(data.content), maxChars);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404
    ) {
      return null;
    }
    throw error;
  }
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

    async listBranches(installationId, fullName) {
      const { owner, repo } = parseRepositoryFullName(fullName);
      console.info(
        `[github] listing branches for ${fullName} (installation ${installationId})`,
      );
      const github = createInstallationOctokit(config, installationId);

      try {
        const repoResponse = await github.rest.repos.get({ owner, repo });
        const defaultBranch = repoResponse.data.default_branch;
        const branches: GitHubBranchSummary[] = [];

        for await (const response of github.paginate.iterator(
          github.rest.repos.listBranches,
          { owner, repo, per_page: 100 },
        )) {
          for (const branch of response.data) {
            branches.push({
              name: branch.name,
              protected: branch.protected,
            });
            if (branches.length >= MAX_BRANCHES) break;
          }
          if (branches.length >= MAX_BRANCHES) break;
        }

        const truncated = branches.length >= MAX_BRANCHES;
        console.info(
          `[github] listed ${branches.length} branches for ${fullName}` +
            (truncated ? " (truncated)" : ""),
        );
        return { defaultBranch, branches, truncated };
      } catch (error) {
        const detail = formatGitHubError(error);
        console.error(
          `[github] failed to list branches for ${fullName}: ${detail}`,
        );
        throw new Error(
          `Failed to list branches for ${fullName}: ${detail}`,
          { cause: error },
        );
      }
    },

    async inspectRepository(installationId, fullName, ref) {
      const { owner, repo } = parseRepositoryFullName(fullName);
      console.info(
        `[github] inspecting ${fullName}` +
          (ref ? ` at ${ref}` : "") +
          ` (installation ${installationId})`,
      );
      const github = createInstallationOctokit(config, installationId);

      try {
        const repoResponse = await github.rest.repos.get({ owner, repo });
        const defaultBranch = repoResponse.data.default_branch;
        const resolvedRef = ref?.trim() || defaultBranch;

        const [readmeResult, rootContents, commitsResponse, ...manifestResults] =
          await Promise.all([
            github.rest.repos
              .getReadme({ owner, repo, ref: resolvedRef })
              .catch((error: unknown) => {
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "status" in error &&
                  error.status === 404
                ) {
                  return null;
                }
                throw error;
              }),
            github.rest.repos.getContent({
              owner,
              repo,
              path: "",
              ref: resolvedRef,
            }),
            github.rest.repos.listCommits({
              owner,
              repo,
              sha: resolvedRef,
              per_page: MAX_RECENT_COMMITS,
            }),
            ...MANIFEST_PATHS.map((path) =>
              fetchOptionalFileText(
                github,
                owner,
                repo,
                path,
                resolvedRef,
                MAX_MANIFEST_CHARS,
              ).then((text) => (text === null ? null : { path, text })),
            ),
          ]);

        const topLevel: GitHubTreeEntry[] = [];
        if (Array.isArray(rootContents.data)) {
          for (const entry of rootContents.data) {
            if (entry.type !== "file" && entry.type !== "dir") continue;
            topLevel.push({
              path: entry.name,
              type: entry.type,
            });
            if (topLevel.length >= MAX_TOP_LEVEL_ENTRIES) break;
          }
        }

        let readme: GitHubRepositoryInspection["readme"] = null;
        if (readmeResult) {
          const encoded = readmeResult.data.content;
          if (typeof encoded === "string") {
            readme = {
              path: readmeResult.data.path,
              text: truncateText(decodeBase64Content(encoded), MAX_README_CHARS),
            };
          }
        }

        const manifests: Array<{ path: string; text: string }> = [];
        for (const manifest of manifestResults) {
          if (manifest) manifests.push(manifest);
        }

        const recentCommits: GitHubCommitSummary[] = commitsResponse.data.map(
          (commit) => ({
            sha: commit.sha.slice(0, 7),
            message: truncateText(
              commit.commit.message.split("\n")[0] ?? "",
              200,
            ),
            author: commit.commit.author?.name ?? commit.author?.login ?? null,
            date: commit.commit.author?.date ?? null,
          }),
        );

        const inspection: GitHubRepositoryInspection = {
          fullName: repoResponse.data.full_name,
          description: repoResponse.data.description,
          defaultBranch,
          ref: resolvedRef,
          language: repoResponse.data.language,
          topLevel,
          readme,
          manifests,
          recentCommits,
        };

        console.info(
          `[github] inspected ${fullName} at ${resolvedRef}: ` +
            `${topLevel.length} top-level entries, ` +
            `${readme ? "readme" : "no-readme"}, ` +
            `${manifests.length} manifests, ` +
            `${recentCommits.length} commits`,
        );
        return inspection;
      } catch (error) {
        const detail = formatGitHubError(error);
        console.error(
          `[github] failed to inspect ${fullName}: ${detail}`,
        );
        throw new Error(`Failed to inspect ${fullName}: ${detail}`, {
          cause: error,
        });
      }
    },
  };
}
