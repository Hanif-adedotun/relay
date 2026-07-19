import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { RelayConfig } from "../config.ts";
import type {
  GitHubInstallationCandidate,
  RelayRepository,
} from "../db/relay-repository.ts";
import { hashAuthState } from "./auth-state.ts";

export interface VerifiedGitHubUser {
  githubUserId: number;
  githubLogin: string;
  installations: GitHubInstallationCandidate[];
}

export interface GitHubInstallationVerifier {
  authorize(input: {
    code: string;
    state: string;
  }): Promise<VerifiedGitHubUser>;
}

interface GitHubCallbackDependencies {
  config: RelayConfig["github"];
  repository: RelayRepository;
  verifier?: GitHubInstallationVerifier;
  notifyConnected?: (conversationId: string) => Promise<boolean>;
  now?: () => Date;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlDocument(content: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Relay</title></head><body><main><h1>Relay</h1>${content}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function htmlResponse(message: string, status = 200): Response {
  return htmlDocument(
    `<p>${escapeHtml(message)}</p><p>You can close this window.</p>`,
    status,
  );
}

function installationUrl(config: RelayConfig["github"], state: string): string {
  const url = new URL(
    `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.toString();
}

function selectionResponse(
  callbackUrl: string,
  state: string,
  installations: GitHubInstallationCandidate[],
): Response {
  const forms = installations
    .map(
      (installation) =>
        `<form method="post" action="${escapeHtml(callbackUrl)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="installation_id" value="${installation.id}"><button type="submit">Connect ${escapeHtml(installation.accountLogin)} (${escapeHtml(installation.accountType)})</button></form>`,
    )
    .join("");

  return htmlDocument(
    `<p>Choose the GitHub App installation Relay should use.</p>${forms}`,
  );
}

function createGitHubVerifier(
  config: RelayConfig["github"],
): GitHubInstallationVerifier {
  const appAuth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  return {
    async authorize({ code, state }) {
      const authentication = await appAuth({
        type: "oauth-user",
        code,
        state,
        redirectUrl: config.callbackUrl,
      });
      const github = new Octokit({ auth: authentication.token });

      const [userResponse, installationsResponse] = await Promise.all([
        github.request("GET /user"),
        github.request("GET /user/installations"),
      ]);

      return {
        githubUserId: userResponse.data.id,
        githubLogin: userResponse.data.login,
        installations: installationsResponse.data.installations.map(
          (installation) => {
            const account = installation.account;
            const isUserOrOrganization = account && "login" in account;

            return {
              id: installation.id,
              accountLogin: isUserOrOrganization
                ? account.login
                : account?.slug ?? "Unknown account",
              accountType: isUserOrOrganization
                ? account.type
                : "Enterprise",
              repositorySelection: installation.repository_selection,
            };
          },
        ),
      };
    },
  };
}

export function createGitHubCallbackHandler(
  dependencies: GitHubCallbackDependencies,
): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? (() => new Date());
  const callbackPath = new URL(dependencies.config.callbackUrl).pathname;
  const verifier =
    dependencies.verifier ?? createGitHubVerifier(dependencies.config);

  const finishConnection = async (
    state: string,
    installationId: number,
  ): Promise<Response> => {
    const session = await dependencies.repository.consumeAuthSession({
      stateHash: hashAuthState(state),
      installationId,
      now: now(),
    });
    if (!session) {
      return htmlResponse(
        "This GitHub connection is invalid, expired, or was already used. Text Relay for a new link.",
        400,
      );
    }

    await dependencies.repository.saveGitHubConnection({
      userId: session.userId,
      installationId,
      githubUserId: session.githubUserId,
      githubLogin: session.githubLogin,
      repositorySelection: session.repositorySelection,
    });

    let notified = false;
    try {
      notified =
        (await dependencies.notifyConnected?.(session.conversationId)) ?? false;
    } catch (error) {
      console.error(
        "Failed to send GitHub connection confirmation:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    if (!notified) {
      await dependencies.repository.markGitHubConfirmationPending(
        session.conversationId,
      );
    }

    return htmlResponse(
      `GitHub connected as @${session.githubLogin}. Relay will only use repositories selected for the GitHub App.`,
    );
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== callbackPath) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }

    try {
      if (request.method === "POST") {
        const form = await request.formData();
        const state = form.get("state");
        const installationId = Number(form.get("installation_id"));
        if (
          typeof state !== "string" ||
          !Number.isSafeInteger(installationId) ||
          installationId < 1
        ) {
          return htmlResponse("This GitHub selection is incomplete.", 400);
        }
        return await finishConnection(state, installationId);
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return htmlResponse("This GitHub authorization is incomplete.", 400);
      }

      const stateHash = hashAuthState(state);
      const authSession = await dependencies.repository.getAuthSession(
        stateHash,
        now(),
      );
      if (!authSession) {
        return htmlResponse(
          "This GitHub connection link has expired or was already used. Text Relay for a new link.",
          400,
        );
      }

      const verified = await verifier.authorize({ code, state });
      const stored = await dependencies.repository.storeVerifiedGitHubUser({
        stateHash,
        now: now(),
        githubUserId: verified.githubUserId,
        githubLogin: verified.githubLogin,
        installations: verified.installations,
      });
      if (!stored) {
        return htmlResponse(
          "This GitHub connection link expired while authorizing. Text Relay for a new link.",
          400,
        );
      }

      const requestedInstallationId = Number(
        url.searchParams.get("installation_id"),
      );
      if (
        Number.isSafeInteger(requestedInstallationId) &&
        requestedInstallationId > 0
      ) {
        return await finishConnection(state, requestedInstallationId);
      }

      if (verified.installations.length === 0) {
        return Response.redirect(
          installationUrl(dependencies.config, state),
          302,
        );
      }

      if (verified.installations.length === 1) {
        return await finishConnection(state, verified.installations[0]!.id);
      }

      return selectionResponse(
        dependencies.config.callbackUrl,
        state,
        verified.installations,
      );
    } catch (error) {
      console.error(
        "GitHub App callback failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return htmlResponse(
        "Relay could not finish connecting GitHub. Text Relay for a new link and try again.",
        500,
      );
    }
  };
}
