import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptCommitSubject, resolvePromptExecutionRoots } from "./prompt-runner";

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

test("buildPromptCommitSubject uses a concise summary of the prompt", () => {
  assert.equal(
    buildPromptCommitSubject("I keep noticing I only remember this idea while washing dishes at night."),
    "I keep noticing I only remember this idea while washing dishes at night."
  );
});

test("buildPromptCommitSubject normalizes list prompts into a single-line subject", () => {
  assert.equal(
    buildPromptCommitSubject("- milk\n- eggs\n- detergent"),
    "milk eggs detergent"
  );
});

test("buildPromptCommitSubject truncates long prompts cleanly", () => {
  const subject = buildPromptCommitSubject(
    "This is a very long reflective prompt that keeps going well past the normal commit subject length and should be trimmed into a short readable summary without losing the overall meaning of the first idea."
  );

  assert.equal(subject.endsWith("…"), true);
  assert.equal(subject.length <= 72, true);
});
