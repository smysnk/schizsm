import assert from "node:assert/strict";
import test from "node:test";
import { resolvePromptExecutionRoots } from "./prompt-runner";

test("resolvePromptExecutionRoots uses the document store repo for dedicated clone mode", () => {
  const roots = resolvePromptExecutionRoots({
    repoRoot: "/tmp/controller-worktree",
    documentStoreRoot: "/tmp/controller-worktree/obsidian-repository",
    documentStoreHasDedicatedGitRepo: true
  });

  assert.deepEqual(roots, {
    codexRepoRoot: "/tmp/controller-worktree/obsidian-repository",
    auditSyncRepoRoot: "/tmp/controller-worktree/obsidian-repository"
  });
});

test("resolvePromptExecutionRoots keeps controller repo roots for standard worktree mode", () => {
  const roots = resolvePromptExecutionRoots({
    repoRoot: "/tmp/controller-worktree",
    documentStoreRoot: "/tmp/controller-worktree/obsidian-repository",
    documentStoreHasDedicatedGitRepo: false
  });

  assert.deepEqual(roots, {
    codexRepoRoot: "/tmp/controller-worktree",
    auditSyncRepoRoot: "/tmp/controller-worktree"
  });
});
