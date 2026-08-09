import { expect, test } from "bun:test";

import { parseRepositoryFullName } from "./repos.ts";

test("parseRepositoryFullName accepts owner/repo", () => {
  expect(parseRepositoryFullName("octocat/Hello-World")).toEqual({
    owner: "octocat",
    repo: "Hello-World",
  });
});

test("parseRepositoryFullName rejects invalid names", () => {
  expect(() => parseRepositoryFullName("octocat")).toThrow(
    'Invalid repository full name "octocat"',
  );
  expect(() => parseRepositoryFullName("a/b/c")).toThrow(
    'Invalid repository full name "a/b/c"',
  );
});
