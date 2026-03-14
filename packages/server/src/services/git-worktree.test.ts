import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  finalizePromptWorktree,
  preparePromptWorktree
} from "./git-worktree";

const execFileAsync = promisify(execFile);

const runGit = async (cwd: string, args: string[]) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: process.env
  });

  return stdout.trim();
};

test("preparePromptWorktree and finalizePromptWorktree promote a prompt branch safely", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-git-worktree-"));
  const repoRoot = path.join(rootDirectory, "repo");
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const worktreeRoot = path.join(rootDirectory, "worktrees");

  try {
    await mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(repoRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(repoRoot, "README.md"), "# Schizm\n", "utf8");
    await mkdir(path.join(repoRoot, "obsidian-repository"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "obsidian-repository", "audit.md"),
      "# Prompt Audit Log\n",
      "utf8"
    );
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["add", "obsidian-repository/audit.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial commit"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(repoRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(repoRoot, ["push", "-u", "origin", "main"]);

    const prepared = await preparePromptWorktree({
      repoRoot,
      worktreeRoot,
      automationBranch: "codex/mindmap",
      promptId: "prompt-123",
      remoteName: "origin",
      documentStoreDir: "obsidian-repository"
    });

    assert.equal(prepared.promptBranch, "codex/run-prompt-123");
    assert.equal(prepared.remoteConfigured, true);
    assert.equal(existsSync(prepared.worktreePath), true);
    assert.equal(prepared.documentStoreSeedMode, "branch");

    await writeFile(
      path.join(prepared.worktreePath, "obsidian-repository", "notes.md"),
      "Isolated worktree verification.\n",
      "utf8"
    );
    await runGit(prepared.worktreePath, ["add", "obsidian-repository/notes.md"]);
    await runGit(prepared.worktreePath, ["commit", "-m", "Add worktree note"]);

    const finalized = await finalizePromptWorktree(prepared);

    assert.equal(finalized.worktreeRemoved, true);
    assert.equal(finalized.promptBranchDeleted, true);
    assert.equal(finalized.remotePromptBranchDeleted, true);
    assert.match(finalized.promptCommitSha, /^[0-9a-f]{40}$/);
    assert.match(finalized.automationCommitSha, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(prepared.worktreePath), false);
    assert.equal(
      await runGit(repoRoot, ["show", "codex/mindmap:obsidian-repository/notes.md"]),
      "Isolated worktree verification."
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("preparePromptWorktree migrates legacy automation-branch docs into obsidian-repository", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-git-worktree-legacy-"));
  const repoRoot = path.join(rootDirectory, "repo");
  const worktreeRoot = path.join(rootDirectory, "worktrees");

  try {
    await mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(repoRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(repoRoot, "README.md"), "# Main README\n", "utf8");
    await writeFile(path.join(repoRoot, "program.md"), "# Program\n", "utf8");
    await writeFile(path.join(repoRoot, "prompt-agent-implementation-plan.md"), "# Plan\n", "utf8");
    await runGit(repoRoot, ["add", "README.md", "program.md", "prompt-agent-implementation-plan.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial controller docs"]);

    await runGit(repoRoot, ["branch", "codex/mindmap"]);
    await runGit(repoRoot, ["checkout", "codex/mindmap"]);
    await writeFile(path.join(repoRoot, "README.md"), "# Legacy README\n", "utf8");
    await writeFile(path.join(repoRoot, "audit.md"), "# Legacy Audit\n", "utf8");
    await writeFile(
      path.join(repoRoot, "main.canvas"),
      JSON.stringify(
        {
          nodes: [
            {
              id: "readme",
              type: "file",
              file: "README.md"
            }
          ],
          edges: []
        },
        null,
        2
      ),
      "utf8"
    );
    await runGit(repoRoot, ["add", "README.md", "audit.md", "main.canvas"]);
    await runGit(repoRoot, ["commit", "-m", "Legacy automation branch state"]);

    await runGit(repoRoot, ["checkout", "main"]);
    await mkdir(path.join(repoRoot, "obsidian-repository"), { recursive: true });
    await writeFile(path.join(repoRoot, "README.md"), "# Main README v2\n", "utf8");
    await writeFile(
      path.join(repoRoot, "obsidian-repository", "audit.md"),
      "# Prompt Audit Log\n",
      "utf8"
    );
    await writeFile(
      path.join(repoRoot, "obsidian-repository", "main.canvas"),
      JSON.stringify(
        {
          nodes: [
            {
              id: "readme",
              type: "file",
              file: "../README.md"
            }
          ],
          edges: []
        },
        null,
        2
      ),
      "utf8"
    );
    await runGit(repoRoot, ["add", "README.md", "obsidian-repository/audit.md", "obsidian-repository/main.canvas"]);
    await runGit(repoRoot, ["commit", "-m", "Move document store under obsidian-repository"]);

    const prepared = await preparePromptWorktree({
      repoRoot,
      worktreeRoot,
      automationBranch: "codex/mindmap",
      promptId: "legacy-123",
      remoteName: "origin",
      documentStoreDir: "obsidian-repository"
    });

    assert.equal(prepared.baseRef, "main");
    assert.equal(prepared.documentStoreSeedMode, "legacy");
    assert.deepEqual(
      prepared.documentStoreSeedPaths.sort(),
      ["obsidian-repository/audit.md", "obsidian-repository/main.canvas"]
    );
    assert.equal(
      await readFile(path.join(prepared.worktreePath, "README.md"), "utf8"),
      "# Main README v2\n"
    );
    assert.equal(existsSync(path.join(prepared.worktreePath, "audit.md")), false);
    assert.equal(existsSync(path.join(prepared.worktreePath, "main.canvas")), false);
    assert.equal(
      await readFile(
        path.join(prepared.worktreePath, "obsidian-repository", "audit.md"),
        "utf8"
      ),
      "# Legacy Audit\n"
    );

    const migratedCanvas = await readFile(
      path.join(prepared.worktreePath, "obsidian-repository", "main.canvas"),
      "utf8"
    );

    assert.match(migratedCanvas, /"\.\.\/README\.md"/);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("preparePromptWorktree preserves tracked symlinks while syncing controller files", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-git-worktree-symlink-"));
  const repoRoot = path.join(rootDirectory, "repo");
  const worktreeRoot = path.join(rootDirectory, "worktrees");
  const symlinkTarget = path.join(rootDirectory, "autoresearch-reference");

  try {
    await mkdir(repoRoot, { recursive: true });
    await mkdir(symlinkTarget, { recursive: true });
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(repoRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(repoRoot, "README.md"), "# Main README\n", "utf8");
    await mkdir(path.join(repoRoot, "references"), { recursive: true });
    await symlink(symlinkTarget, path.join(repoRoot, "references", "autoresearch"));
    await runGit(repoRoot, ["add", "README.md", "references/autoresearch"]);
    await runGit(repoRoot, ["commit", "-m", "Track reference symlink"]);

    await runGit(repoRoot, ["branch", "codex/mindmap"]);

    const prepared = await preparePromptWorktree({
      repoRoot,
      worktreeRoot,
      automationBranch: "codex/mindmap",
      promptId: "symlink-123",
      remoteName: "origin",
      documentStoreDir: "obsidian-repository"
    });

    const linkedPath = path.join(prepared.worktreePath, "references", "autoresearch");
    const linkStat = await lstat(linkedPath);

    assert.equal(linkStat.isSymbolicLink(), true);
    assert.equal(await readlink(linkedPath), symlinkTarget);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("preparePromptWorktree skips tracked paths matched by .gitignore during controller sync", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-git-worktree-ignore-"));
  const repoRoot = path.join(rootDirectory, "repo");
  const worktreeRoot = path.join(rootDirectory, "worktrees");

  try {
    await mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(repoRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(repoRoot, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(path.join(repoRoot, "README.md"), "# Main README\n", "utf8");
    await writeFile(path.join(repoRoot, "ignored.txt"), "main-initial\n", "utf8");
    await runGit(repoRoot, ["add", ".gitignore", "README.md"]);
    await runGit(repoRoot, ["add", "-f", "ignored.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Initial controller state"]);

    await runGit(repoRoot, ["branch", "codex/mindmap"]);
    await runGit(repoRoot, ["checkout", "codex/mindmap"]);
    await writeFile(path.join(repoRoot, "ignored.txt"), "automation-branch\n", "utf8");
    await runGit(repoRoot, ["add", "-f", "ignored.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Adjust ignored tracked file on automation branch"]);

    await runGit(repoRoot, ["checkout", "main"]);
    await writeFile(path.join(repoRoot, "README.md"), "# Main README v2\n", "utf8");
    await writeFile(path.join(repoRoot, "ignored.txt"), "main-updated\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["add", "-f", "ignored.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Update main controller files"]);

    const prepared = await preparePromptWorktree({
      repoRoot,
      worktreeRoot,
      automationBranch: "codex/mindmap",
      promptId: "ignore-123",
      remoteName: "origin",
      documentStoreDir: "obsidian-repository"
    });

    assert.equal(
      await readFile(path.join(prepared.worktreePath, "README.md"), "utf8"),
      "# Main README v2\n"
    );
    assert.equal(
      await readFile(path.join(prepared.worktreePath, "ignored.txt"), "utf8"),
      "automation-branch\n"
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("finalizePromptWorktree removes a worktree after restoring controller overlay changes", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-git-worktree-finalize-"));
  const repoRoot = path.join(rootDirectory, "repo");
  const worktreeRoot = path.join(rootDirectory, "worktrees");

  try {
    await mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(repoRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(repoRoot, "README.md"), "# Main README\n", "utf8");
    await mkdir(path.join(repoRoot, "obsidian-repository"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "obsidian-repository", "audit.md"),
      "# Prompt Audit Log\n",
      "utf8"
    );
    await runGit(repoRoot, ["add", "README.md", "obsidian-repository/audit.md"]);
    await runGit(repoRoot, ["commit", "-m", "Initial main state"]);

    await runGit(repoRoot, ["branch", "codex/mindmap"]);
    await runGit(repoRoot, ["checkout", "codex/mindmap"]);
    await writeFile(path.join(repoRoot, "README.md"), "# Legacy README\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Legacy automation branch"]);

    await runGit(repoRoot, ["checkout", "main"]);
    await writeFile(path.join(repoRoot, "README.md"), "# Main README v2\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["commit", "-m", "Update main README"]);

    const prepared = await preparePromptWorktree({
      repoRoot,
      worktreeRoot,
      automationBranch: "codex/mindmap",
      promptId: "finalize-123",
      remoteName: "origin",
      documentStoreDir: "obsidian-repository"
    });

    assert.match(await runGit(prepared.worktreePath, ["status", "--short"]), /README\.md/);

    await writeFile(
      path.join(prepared.worktreePath, "obsidian-repository", "note.md"),
      "Finalize simulation.\n",
      "utf8"
    );
    await runGit(prepared.worktreePath, ["add", "obsidian-repository/note.md"]);
    await runGit(prepared.worktreePath, ["commit", "-m", "Add note in prompt branch"]);

    const finalized = await finalizePromptWorktree(prepared);

    assert.equal(finalized.worktreeRemoved, true);
    assert.equal(finalized.promptBranchDeleted, true);
    assert.equal(
      await runGit(repoRoot, ["show", "codex/mindmap:obsidian-repository/note.md"]),
      "Finalize simulation."
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
