import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { JsonObject } from "../repositories/prompt-repository";
import type { RunArtifacts } from "./runtime-types";

const execFileAsync = promisify(execFile);

export type GitOperationTrace = {
  at: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  repoRoot: string;
  command: string;
  succeeded?: boolean;
  error?: string | null;
};

const normalizePromptSummarySource = (content: string) =>
  content
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim())
    .filter(Boolean)
    .join(" ");

export const buildPromptCommitSubject = (content: string, maxLength = 72) => {
  const normalized = normalizePromptSummarySource(content);

  if (!normalized) {
    return "Capture prompt";
  }

  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/u);
  const sentence = sentenceMatch?.[1]?.trim();

  if (sentence && sentence.length <= maxLength) {
    return sentence;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const cutoff = Math.max(12, maxLength - 1);
  const truncated = normalized.slice(0, cutoff);
  const lastSpace = truncated.lastIndexOf(" ");
  const summary = (lastSpace >= 24 ? truncated.slice(0, lastSpace) : truncated).trim();

  return `${summary}\u2026`;
};

export const resolvePromptExecutionRoots = ({
  repoRoot,
  documentStoreRoot,
  documentStoreHasDedicatedGitRepo
}: {
  repoRoot: string;
  documentStoreRoot: string;
  documentStoreHasDedicatedGitRepo: boolean;
}) => {
  if (documentStoreHasDedicatedGitRepo) {
    return {
      codexRepoRoot: documentStoreRoot,
      auditSyncRepoRoot: documentStoreRoot
    };
  }

  return {
    codexRepoRoot: repoRoot,
    auditSyncRepoRoot: repoRoot
  };
};

export const createRunArtifacts = async (repoRoot: string, promptId: string) => {
  const runDirectory = path.join(repoRoot, ".codex-runs", promptId);
  await fs.mkdir(runDirectory, { recursive: true });

  return {
    runDirectory,
    instructionPath: path.join(runDirectory, "instruction.txt"),
    stdoutPath: path.join(runDirectory, "stdout.log"),
    stderrPath: path.join(runDirectory, "stderr.log"),
    outputPath: path.join(runDirectory, "final-output.json"),
    auditSyncOutputPath: path.join(runDirectory, "audit-sync.json"),
    auditSyncStderrPath: path.join(runDirectory, "audit-sync.stderr.log")
  } satisfies RunArtifacts;
};

export const resolveTsxBin = (repoRoot: string) => {
  const repoBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

  if (existsSync(repoBin)) {
    return repoBin;
  }

  throw new Error(`Unable to locate tsx at ${repoBin}.`);
};

const formatShellArgument = (value: string) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : JSON.stringify(value);

const formatGitCommand = (args: string[]) =>
  ["git", ...args].map((value) => formatShellArgument(value)).join(" ");

const startGitOperationTrace = (
  gitOperations: JsonObject[] | undefined,
  repoRoot: string,
  args: string[]
) => {
  const startedAt = new Date().toISOString();
  const trace: GitOperationTrace = {
    at: startedAt,
    startedAt,
    repoRoot,
    command: formatGitCommand(args)
  };

  if (gitOperations) {
    gitOperations.push(trace as unknown as JsonObject);
  }

  return trace;
};

const finishGitOperationTrace = (
  trace: GitOperationTrace,
  startedAtMs: number,
  {
    succeeded,
    error
  }: {
    succeeded: boolean;
    error?: string | null;
  }
) => {
  trace.finishedAt = new Date().toISOString();
  trace.durationMs = Math.max(0, Date.now() - startedAtMs);
  trace.succeeded = succeeded;
  trace.error = error || null;
};

export const runGit = async (
  repoRoot: string,
  args: string[],
  gitOperations?: JsonObject[]
) => {
  const startedAtMs = Date.now();
  const trace = startGitOperationTrace(gitOperations, repoRoot, args);

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8"
    });

    finishGitOperationTrace(trace, startedAtMs, {
      succeeded: true
    });
    return stdout.trim();
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim() || error.message
        : error instanceof Error
          ? error.message
          : "Git command failed.";

    finishGitOperationTrace(trace, startedAtMs, {
      succeeded: false,
      error: message
    });
    throw error;
  }
};

export const summarizeGitOperations = (gitOperations: JsonObject[] = []) => {
  let totalMs = 0;
  let count = 0;

  for (const operation of gitOperations) {
    const durationMs = operation.durationMs;

    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      totalMs += durationMs;
      count += 1;
    }
  }

  return {
    totalMs,
    count
  };
};

export const resolveCommitSha = async (
  repoRoot: string,
  refOrSha: string,
  gitOperations?: JsonObject[]
) => {
  const normalized = refOrSha.trim();

  if (!normalized) {
    return "";
  }

  try {
    return await runGit(repoRoot, ["rev-parse", `${normalized}^{commit}`], gitOperations);
  } catch {
    return normalized;
  }
};

export const assertHeadMatches = async ({
  repoRoot,
  expectedHeadSha,
  headRef = "HEAD",
  gitOperations
}: {
  repoRoot: string;
  expectedHeadSha: string;
  headRef?: string;
  gitOperations?: JsonObject[];
}) => {
  const normalizedExpectedHeadSha = await resolveCommitSha(
    repoRoot,
    expectedHeadSha,
    gitOperations
  );
  const currentHeadSha = await runGit(repoRoot, ["rev-parse", headRef], gitOperations);

  if (currentHeadSha !== normalizedExpectedHeadSha) {
    throw new Error(
      `Codex created a commit before runner finalization. Expected ${normalizedExpectedHeadSha}, received ${currentHeadSha}.`
    );
  }
};

export const createPromptCommit = async ({
  repoRoot,
  commitSubject,
  pathspecs = [],
  gitOperations
}: {
  repoRoot: string;
  commitSubject: string;
  pathspecs?: string[];
  gitOperations?: JsonObject[];
}) => {
  if (pathspecs.length) {
    await runGit(repoRoot, ["add", "--", ...pathspecs], gitOperations);
  } else {
    await runGit(repoRoot, ["add", "-A"], gitOperations);
  }

  const workingTreeStatus = await runGit(
    repoRoot,
    ["status", "--porcelain", ...(pathspecs.length ? ["--", ...pathspecs] : [])],
    gitOperations
  );

  if (!workingTreeStatus) {
    throw new Error("No repository changes were available for the final prompt commit.");
  }

  await runGit(repoRoot, ["commit", "-m", commitSubject], gitOperations);

  return {
    commitSha: await runGit(repoRoot, ["rev-parse", "HEAD"], gitOperations),
    commitSubject
  };
};

export const pushPromptCommit = async ({
  repoRoot,
  remoteName,
  branch,
  gitOperations
}: {
  repoRoot: string;
  remoteName: string;
  branch: string;
  gitOperations?: JsonObject[];
}) => {
  await runGit(repoRoot, ["push", "-u", remoteName, branch], gitOperations);
};

export const verifySinglePromptCommit = async ({
  repoRoot,
  expectedBaseSha,
  expectedCommitSha,
  expectedCommitSubject,
  headRef = "HEAD",
  statusPathspecs = [],
  gitOperations
}: {
  repoRoot: string;
  expectedBaseSha: string;
  expectedCommitSha?: string | null;
  expectedCommitSubject?: string | null;
  headRef?: string;
  statusPathspecs?: string[];
  gitOperations?: JsonObject[];
}) => {
  const headSha = await runGit(repoRoot, ["rev-parse", headRef], gitOperations);
  const commitSubject = await runGit(
    repoRoot,
    ["log", "-1", "--pretty=%s", headRef],
    gitOperations
  );
  const workingTreeStatus = await runGit(
    repoRoot,
    ["status", "--porcelain", ...(statusPathspecs.length ? ["--", ...statusPathspecs] : [])],
    gitOperations
  );
  const normalizedExpectedBaseSha = await resolveCommitSha(
    repoRoot,
    expectedBaseSha,
    gitOperations
  );
  const normalizedExpectedCommitSha = expectedCommitSha
    ? await resolveCommitSha(repoRoot, expectedCommitSha, gitOperations)
    : "";

  if (normalizedExpectedCommitSha && headSha !== normalizedExpectedCommitSha) {
    throw new Error(
      `Prompt commit verification failed. Expected ${expectedCommitSha}, received ${headSha}.`
    );
  }

  if (expectedCommitSubject && commitSubject !== expectedCommitSubject) {
    throw new Error(
      `Prompt commit verification failed. Expected subject ${JSON.stringify(expectedCommitSubject)}, received ${JSON.stringify(commitSubject)}.`
    );
  }

  if (workingTreeStatus) {
    throw new Error(`Prompt repository has uncommitted changes after Codex completed:\n${workingTreeStatus}`);
  }

  const commitCount = Number.parseInt(
    await runGit(
      repoRoot,
      ["rev-list", "--count", `${normalizedExpectedBaseSha}..${headSha}`],
      gitOperations
    ),
    10
  );

  if (commitCount !== 1) {
    throw new Error(
      `Prompt commit verification failed. Expected exactly 1 commit after ${expectedBaseSha}, found ${commitCount}.`
    );
  }

  return {
    baseSha: normalizedExpectedBaseSha,
    headSha,
    commitCount,
    commitSubject
  };
};
