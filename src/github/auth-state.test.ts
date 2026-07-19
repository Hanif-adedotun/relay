import { expect, test } from "bun:test";

import { FakeRelayRepository } from "../test/fake-repository.ts";
import { GitHubAuthStateService, hashAuthState } from "./auth-state.ts";

test("stores only a hash and expires GitHub auth state after ten minutes", async () => {
  const repository = new FakeRelayRepository();
  const now = new Date("2026-07-18T20:00:00.000Z");
  const service = new GitHubAuthStateService(
    repository,
    {
      appId: "1",
      clientId: "client",
      clientSecret: "secret",
      privateKey: "key",
      slug: "relay",
      callbackUrl: "https://relay.test/auth/github/callback",
    },
    () => now,
  );

  const authorizationUrl = await service.createAuthorizationUrl({
    userId: "user-1",
    conversationId: "conversation-1",
  });
  const url = new URL(authorizationUrl);
  const rawState = url.searchParams.get("state");

  expect(rawState).not.toBeNull();
  expect(url.origin + url.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(url.searchParams.get("client_id")).toBe("client");
  expect(repository.authSessions.has(rawState!)).toBeFalse();

  const stored = repository.authSessions.get(hashAuthState(rawState!));
  expect(stored?.expiresAt.toISOString()).toBe("2026-07-18T20:10:00.000Z");
  expect(
    await repository.getAuthSession(
      hashAuthState(rawState!),
      new Date("2026-07-18T20:10:00.000Z"),
    ),
  ).toBeNull();
});
