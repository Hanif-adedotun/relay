import { expect, test } from "bun:test";

import {
  parseRepositoryFullName,
  validateBranchName,
  validateRepoPath,
} from "./repos.ts";

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

test("validateRepoPath accepts nested paths", () => {
  expect(validateRepoPath("src/index.ts")).toBe("src/index.ts");
  expect(validateRepoPath("architecture.md")).toBe("architecture.md");
});

test("validateRepoPath rejects traversal and absolute paths", () => {
  expect(() => validateRepoPath("../secret")).toThrow("Invalid file path");
  expect(() => validateRepoPath("/etc/passwd")).toThrow("Invalid file path");
  expect(() => validateRepoPath("")).toThrow("File path cannot be empty");
});

test("validateBranchName accepts feature branches", () => {
  expect(validateBranchName("feat/onboarding")).toBe("feat/onboarding");
});

test("validateBranchName rejects unsafe names", () => {
  expect(() => validateBranchName("feat onboarding")).toThrow(
    "Invalid branch name",
  );
  expect(() => validateBranchName("../main")).toThrow("Invalid branch name");
});
