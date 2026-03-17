import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { verifyContainerDocumentRepoPush } from "./container-document-repo";

const execFileAsync = promisify(execFile);

const runGit = async (cwd: string, args: string[]) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8"
  });

  return stdout.trim();
};

test("verifyContainerDocumentRepoPush confirms a committed and pushed branch", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-container-repo-"));
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const seedRoot = path.join(rootDirectory, "seed");
  const cloneRoot = path.join(rootDirectory, "clone");

  try {
    await mkdir(seedRoot, { recursive: true });
    await runGit(seedRoot, ["init", "-b", "main"]);
    await runGit(seedRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(seedRoot, ["config", "user.email", "schizm-tests@example.com"]);
    await writeFile(path.join(seedRoot, "audit.md"), "# Audit\n", "utf8");
    await runGit(seedRoot, ["add", "audit.md"]);
    await runGit(seedRoot, ["commit", "-m", "Initial commit"]);
    const baseSha = await runGit(seedRoot, ["rev-parse", "HEAD"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(seedRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(seedRoot, ["push", "-u", "origin", "main"]);

    await runGit(rootDirectory, ["clone", "--branch", "main", remoteRoot, cloneRoot]);
    await runGit(cloneRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(cloneRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(cloneRoot, "note.md"), "Captured thought.\n", "utf8");
    await runGit(cloneRoot, ["add", "note.md"]);
    await runGit(cloneRoot, ["commit", "-m", "Add note"]);
    const headSha = await runGit(cloneRoot, ["rev-parse", "HEAD"]);
    await runGit(cloneRoot, ["push", "origin", "main"]);

    const verification = await verifyContainerDocumentRepoPush({
      repoRoot: cloneRoot,
      remoteName: "origin",
      branch: "main",
      expectedCommitSha: headSha,
      expectedBaseSha: baseSha,
      expectedCommitSubject: "Add note"
    });

    assert.equal(verification.baseSha, baseSha);
    assert.equal(verification.headSha, headSha);
    assert.equal(verification.remoteSha, headSha);
    assert.equal(verification.commitCount, 1);
    assert.equal(verification.commitSubject, "Add note");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("verifyContainerDocumentRepoPush accepts an abbreviated expected commit sha", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-container-repo-short-sha-"));
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const seedRoot = path.join(rootDirectory, "seed");
  const cloneRoot = path.join(rootDirectory, "clone");

  try {
    await mkdir(seedRoot, { recursive: true });
    await runGit(seedRoot, ["init", "-b", "main"]);
    await runGit(seedRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(seedRoot, ["config", "user.email", "schizm-tests@example.com"]);
    await writeFile(path.join(seedRoot, "audit.md"), "# Audit\n", "utf8");
    await runGit(seedRoot, ["add", "audit.md"]);
    await runGit(seedRoot, ["commit", "-m", "Initial commit"]);
    const baseSha = await runGit(seedRoot, ["rev-parse", "HEAD"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(seedRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(seedRoot, ["push", "-u", "origin", "main"]);

    await runGit(rootDirectory, ["clone", "--branch", "main", remoteRoot, cloneRoot]);
    await runGit(cloneRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(cloneRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(cloneRoot, "note.md"), "Captured thought.\n", "utf8");
    await runGit(cloneRoot, ["add", "note.md"]);
    await runGit(cloneRoot, ["commit", "-m", "Add note"]);
    const headSha = await runGit(cloneRoot, ["rev-parse", "HEAD"]);
    await runGit(cloneRoot, ["push", "origin", "main"]);

    const verification = await verifyContainerDocumentRepoPush({
      repoRoot: cloneRoot,
      remoteName: "origin",
      branch: "main",
      expectedCommitSha: headSha.slice(0, 7),
      expectedBaseSha: baseSha,
      expectedCommitSubject: "Add note"
    });

    assert.equal(verification.headSha, headSha);
    assert.equal(verification.remoteSha, headSha);
    assert.equal(verification.commitCount, 1);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("verifyContainerDocumentRepoPush rejects commits that were not pushed", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-container-repo-unpushed-"));
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const seedRoot = path.join(rootDirectory, "seed");
  const cloneRoot = path.join(rootDirectory, "clone");

  try {
    await mkdir(seedRoot, { recursive: true });
    await runGit(seedRoot, ["init", "-b", "main"]);
    await runGit(seedRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(seedRoot, ["config", "user.email", "schizm-tests@example.com"]);
    await writeFile(path.join(seedRoot, "audit.md"), "# Audit\n", "utf8");
    await runGit(seedRoot, ["add", "audit.md"]);
    await runGit(seedRoot, ["commit", "-m", "Initial commit"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(seedRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(seedRoot, ["push", "-u", "origin", "main"]);

    await runGit(rootDirectory, ["clone", "--branch", "main", remoteRoot, cloneRoot]);
    await runGit(cloneRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(cloneRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(cloneRoot, "note.md"), "Local only.\n", "utf8");
    await runGit(cloneRoot, ["add", "note.md"]);
    await runGit(cloneRoot, ["commit", "-m", "Local commit"]);

    await assert.rejects(
      () =>
        verifyContainerDocumentRepoPush({
          repoRoot: cloneRoot,
          remoteName: "origin",
          branch: "main"
        }),
      /push verification failed/
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("verifyContainerDocumentRepoPush rejects a mismatched commit subject", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-container-repo-bad-subject-"));
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const seedRoot = path.join(rootDirectory, "seed");
  const cloneRoot = path.join(rootDirectory, "clone");

  try {
    await mkdir(seedRoot, { recursive: true });
    await runGit(seedRoot, ["init", "-b", "main"]);
    await runGit(seedRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(seedRoot, ["config", "user.email", "schizm-tests@example.com"]);
    await writeFile(path.join(seedRoot, "audit.md"), "# Audit\n", "utf8");
    await runGit(seedRoot, ["add", "audit.md"]);
    await runGit(seedRoot, ["commit", "-m", "Initial commit"]);
    const baseSha = await runGit(seedRoot, ["rev-parse", "HEAD"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(seedRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(seedRoot, ["push", "-u", "origin", "main"]);

    await runGit(rootDirectory, ["clone", "--branch", "main", remoteRoot, cloneRoot]);
    await runGit(cloneRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(cloneRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(cloneRoot, "note.md"), "Captured thought.\n", "utf8");
    await runGit(cloneRoot, ["add", "note.md"]);
    await runGit(cloneRoot, ["commit", "-m", "Add note"]);
    const headSha = await runGit(cloneRoot, ["rev-parse", "HEAD"]);
    await runGit(cloneRoot, ["push", "origin", "main"]);

    await assert.rejects(
      () =>
        verifyContainerDocumentRepoPush({
          repoRoot: cloneRoot,
          remoteName: "origin",
          branch: "main",
          expectedCommitSha: headSha,
          expectedBaseSha: baseSha,
          expectedCommitSubject: "Different summary"
        }),
      /commit subject mismatch/
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("verifyContainerDocumentRepoPush rejects runs that create multiple commits", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-container-repo-multi-commit-"));
  const remoteRoot = path.join(rootDirectory, "origin.git");
  const seedRoot = path.join(rootDirectory, "seed");
  const cloneRoot = path.join(rootDirectory, "clone");

  try {
    await mkdir(seedRoot, { recursive: true });
    await runGit(seedRoot, ["init", "-b", "main"]);
    await runGit(seedRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(seedRoot, ["config", "user.email", "schizm-tests@example.com"]);
    await writeFile(path.join(seedRoot, "audit.md"), "# Audit\n", "utf8");
    await runGit(seedRoot, ["add", "audit.md"]);
    await runGit(seedRoot, ["commit", "-m", "Initial commit"]);
    const baseSha = await runGit(seedRoot, ["rev-parse", "HEAD"]);

    await runGit(rootDirectory, ["init", "--bare", remoteRoot]);
    await runGit(seedRoot, ["remote", "add", "origin", remoteRoot]);
    await runGit(seedRoot, ["push", "-u", "origin", "main"]);

    await runGit(rootDirectory, ["clone", "--branch", "main", remoteRoot, cloneRoot]);
    await runGit(cloneRoot, ["config", "user.name", "Schizm Tests"]);
    await runGit(cloneRoot, ["config", "user.email", "schizm-tests@example.com"]);

    await writeFile(path.join(cloneRoot, "note-1.md"), "First change.\n", "utf8");
    await runGit(cloneRoot, ["add", "note-1.md"]);
    await runGit(cloneRoot, ["commit", "-m", "First commit"]);

    await writeFile(path.join(cloneRoot, "note-2.md"), "Second change.\n", "utf8");
    await runGit(cloneRoot, ["add", "note-2.md"]);
    await runGit(cloneRoot, ["commit", "-m", "Second commit"]);

    const headSha = await runGit(cloneRoot, ["rev-parse", "HEAD"]);
    await runGit(cloneRoot, ["push", "origin", "main"]);

    await assert.rejects(
      () =>
        verifyContainerDocumentRepoPush({
          repoRoot: cloneRoot,
          remoteName: "origin",
          branch: "main",
          expectedCommitSha: headSha,
          expectedBaseSha: baseSha
        }),
      /Expected exactly 1 commit/
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
