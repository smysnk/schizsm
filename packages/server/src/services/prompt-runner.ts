import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { env } from "../config/env";
import { pool } from "../db/pool";
import {
  ensureGitRepository,
  finalizePromptWorktree,
  preparePromptWorktree,
  type PreparedPromptWorktree
} from "./git-worktree";
import { setPromptRunner } from "./prompt-runner-registry";
import { publishPromptWorkspaceEvent } from "./prompt-workspace-events";
import {
  formatCanvasValidationError,
  validateCanvasState,
  type CanvasValidationReport
} from "./canvas-validator";
import { verifyContainerDocumentRepoPush } from "./container-document-repo";
import { appendPromptTimingToAuditSection } from "./prompt-audit-timing";
import {
  claimNextQueuedPrompt,
  recoverActivePrompts,
  type JsonObject,
  type JsonValue,
  type Prompt,
  type PromptStatus,
  updatePrompt
} from "../repositories/prompt-repository";

const execFileAsync = promisify(execFile);

type RunnerTransition = {
  status: PromptStatus;
  at: string;
  reason: string;
};

type CodexRunOutput = {
  promptId: string;
  resultStatus: "completed" | "completed_with_noop" | "failed";
  decision: {
    mode: "create" | "integrate" | "append";
    summary: string;
    targetFiles: string[];
  };
  summary: string;
  repoChanges: {
    added: string[];
    modified: string[];
    deleted: string[];
    moved: Array<{ from: string; to: string }>;
    canvasUpdated: boolean;
  };
  contextualRelevance: Array<{
    path: string;
    relationship: string;
    disposition:
      | "related_but_unproven"
      | "supports_existing_topic"
      | "complicates_existing_topic"
      | "contradicts_existing_topic";
  }>;
  hypotheses: {
    created: string[];
    updated: string[];
    strengthened: string[];
    weakened: string[];
    disproved: string[];
    resolved: string[];
  };
  audit: {
    path: string;
    appended: boolean;
    promptId: string;
    sectionStartMarker: string;
    sectionEndMarker: string;
  };
  git: {
    branch: string;
    commitSha: string | null;
    commitCreated: boolean;
    pushSucceeded: boolean;
  };
  blockers: string[];
  notes?: string[];
};

type RunArtifacts = {
  runDirectory: string;
  instructionPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  auditSyncOutputPath: string;
  auditSyncStderrPath: string;
};

type ContainerDocumentRepo = {
  repoRoot: string;
  documentStoreRoot: string;
  branch: string;
  remoteName: string;
  remoteUrl: string;
  remoteConfigured: boolean;
};

type FailureTelemetry = JsonObject & {
  stage: string;
  capturedAt: string;
  promptId: string;
  runnerSessionId: string;
  statusAtFailure: string;
  message: string;
};

type GitOperationTrace = {
  at: string;
  repoRoot: string;
  command: string;
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

const PROMPT_RUNNER_LEASE_KEY = 41_042_006;

export type PromptRunnerStateSnapshot = {
  paused: boolean;
  inFlight: boolean;
  activePromptId: string | null;
  activePromptStatus: PromptStatus | null;
  pollMs: number;
  automationBranch: string;
  worktreeRoot: string;
  runnerSessionId: string;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toJsonValue = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isJsonObject(value)) {
    return Object.entries(value).reduce<JsonObject>((result, [key, item]) => {
      result[key] = toJsonValue(item);
      return result;
    }, {});
  }

  return String(value);
};

const readJsonFile = async (filePath: string): Promise<JsonObject> => {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!isJsonObject(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }

  return Object.entries(parsed).reduce<JsonObject>((result, [key, value]) => {
    result[key] = toJsonValue(value);
    return result;
  }, {});
};

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Prompt runner failed.";

const summarizeErrorStack = (error: unknown) => {
  if (!(error instanceof Error) || !error.stack) {
    return null;
  }

  return error.stack
    .split("\n")
    .slice(0, 6)
    .join("\n");
};

const buildInstruction = ({
  prompt,
  repoRoot,
  executionRepoRoot,
  documentStoreRoot,
  programPath,
  auditPath,
  schemaPath,
  automationBranch,
  promptBranch,
  remoteName,
  expectedCommitSubject,
  documentStoreIsRepoRoot,
  documentStoreHasDedicatedGitRepo
}: {
  prompt: Prompt;
  repoRoot: string;
  executionRepoRoot: string;
  documentStoreRoot: string;
  programPath: string;
  auditPath: string;
  schemaPath: string;
  automationBranch: string;
  promptBranch: string;
  remoteName: string;
  expectedCommitSubject: string;
  documentStoreIsRepoRoot?: boolean;
  documentStoreHasDedicatedGitRepo?: boolean;
}) => `You are processing a queued repository-maintenance prompt for this project.

Repository root: ${repoRoot}
Execution repository root: ${executionRepoRoot}
Document store root: ${documentStoreRoot}
Program contract: ${programPath}
Audit log: ${auditPath}
Final output schema: ${schemaPath}
Prompt ID: ${prompt.id}
Automation branch: ${automationBranch}
Prompt branch: ${promptBranch}
Git remote: ${remoteName}

Before making changes:
- Read ${programPath} and follow it strictly.
- Inspect the current markdown corpus and canvas files under ${documentStoreRoot}.
- ${
  documentStoreIsRepoRoot
    ? `In this environment, the document store repository itself is the writable root. Treat references in program.md to obsidian-repository/ as meaning ${documentStoreRoot}.`
    : `Treat ${documentStoreRoot} as the only writable document store root.`
}
- ${
  documentStoreHasDedicatedGitRepo
    ? `The document store at ${documentStoreRoot} is its own dedicated Git repository. The runner will perform the final commit/push there, not in the outer controller repository at ${repoRoot}.`
    : `The runner will perform the final commit/push in the repository rooted at ${repoRoot}.`
}
- The default git working directory for this run is ${executionRepoRoot}. Make all file edits there, but leave the final git commit/push to the runner.
- Treat every path outside ${documentStoreRoot} as read-only unless the human explicitly asked otherwise.
- Treat ${path.join(repoRoot, "packages")} and ${path.join(repoRoot, "scripts")} as read-only unless absolutely required by the contract.

User prompt:
"""text
${prompt.content}
"""

Run requirements:
- Update markdown and canvas files according to the contract in program.md.
- Append exactly one audit section to ${auditPath} using the required markers for prompt ${prompt.id} if the run reaches a coherent stopping point.
- Do not commit or push changes yourself. The runner will append timing details to the audit entry, then create the single final commit and push.
- Do not create intermediate commits for markdown changes, canvas updates, audit updates, or any other partial step.
- Use this exact final commit subject: ${JSON.stringify(expectedCommitSubject)}
- Return only a single JSON object that matches ${schemaPath}.
- The returned JSON must use promptId "${prompt.id}".
- In the returned JSON git object, report the target branch and leave commitSha as null with commitCreated=false and pushSucceeded=false.
`;

const createRunArtifacts = async (repoRoot: string, promptId: string) => {
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

const resolveTsxBin = (repoRoot: string) => {
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

const traceGitOperation = (
  gitOperations: JsonObject[] | undefined,
  repoRoot: string,
  args: string[]
) => {
  if (!gitOperations) {
    return;
  }

  gitOperations.push({
    at: new Date().toISOString(),
    repoRoot,
    command: formatGitCommand(args)
  } satisfies GitOperationTrace as JsonObject);
};

const runGit = async (
  repoRoot: string,
  args: string[],
  gitOperations?: JsonObject[]
) => {
  traceGitOperation(gitOperations, repoRoot, args);

  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8"
  });

  return stdout.trim();
};

const assertHeadMatches = async ({
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

const createPromptCommit = async ({
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

const pushPromptCommit = async ({
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

const resolveCommitSha = async (
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

const verifySinglePromptCommit = async ({
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

const ensureContainerDocumentRepo = async ({
  gitOperations
}: {
  gitOperations?: JsonObject[];
} = {}): Promise<ContainerDocumentRepo> => {
  const repoRoot = path.resolve(env.documentStoreDir);

  if (!env.promptRunnerContainerRepoUrl.trim()) {
    throw new Error(
      "Container prompt runner mode requires DOCUMENT_STORE_GIT_URL to be configured."
    );
  }

  await ensureGitRepository(repoRoot);

  const remoteName = env.promptRunnerRemoteName;
  const remoteUrl = await runGit(repoRoot, ["remote", "get-url", remoteName], gitOperations).catch(
    () => ""
  );

  if (!remoteUrl) {
    throw new Error(
      `Container document store repo at ${repoRoot} is missing remote ${remoteName}.`
    );
  }

  if (remoteUrl !== env.promptRunnerContainerRepoUrl) {
    throw new Error(
      `Container document store remote mismatch. Expected ${env.promptRunnerContainerRepoUrl}, received ${remoteUrl}.`
    );
  }

  const branch = env.promptRunnerContainerRepoBranch;

  await runGit(repoRoot, ["fetch", remoteName, branch], gitOperations);
  await runGit(repoRoot, ["checkout", "-B", branch, `${remoteName}/${branch}`], gitOperations);
  await runGit(
    repoRoot,
    ["config", "user.name", env.promptRunnerContainerGitAuthorName],
    gitOperations
  );
  await runGit(
    repoRoot,
    ["config", "user.email", env.promptRunnerContainerGitAuthorEmail],
    gitOperations
  );

  return {
    repoRoot,
    documentStoreRoot: repoRoot,
    branch,
    remoteName,
    remoteUrl,
    remoteConfigured: true
  };
};

const executeCodex = async ({
  instruction,
  artifacts,
  repoRoot,
  schemaPath
}: {
  instruction: string;
  artifacts: RunArtifacts;
  repoRoot: string;
  schemaPath: string;
}) => {
  const args = [
    "exec",
    "-C",
    repoRoot,
    "-s",
    "danger-full-access",
    "-c",
    `model_reasoning_effort="${env.promptRunnerReasoningEffort}"`,
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "-o",
    artifacts.outputPath,
    "-"
  ];

  await fs.writeFile(artifacts.instructionPath, instruction, "utf8");

  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const stdoutStream = createWriteStream(artifacts.stdoutPath, { flags: "a" });
      const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
      const child = spawn(env.promptRunnerCodexBin, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stdout.pipe(stdoutStream);
      child.stderr.pipe(stderrStream);

      child.stdin.write(instruction);
      child.stdin.end();

      child.once("error", (error) => {
        stdoutStream.end();
        stderrStream.end();
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        stdoutStream.end();
        stderrStream.end();
        resolve({ exitCode, signal });
      });
    }
  );
};

const executeAuditSync = async ({
  promptId,
  artifacts,
  repoRoot,
  auditPath,
  scriptRepoRoot
}: {
  promptId: string;
  artifacts: RunArtifacts;
  repoRoot: string;
  auditPath: string;
  scriptRepoRoot: string;
}) => {
  const tsxBin = resolveTsxBin(scriptRepoRoot);
  const scriptPath = path.join(scriptRepoRoot, "scripts", "sync-prompt-audit.ts");
  const args = [
    scriptPath,
    "--prompt-id",
    promptId,
    "--repo-root",
    repoRoot,
    "--audit-path",
    auditPath
  ];

  return new Promise<JsonObject>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(tsxBin, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", async (exitCode, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      await Promise.all([
        fs.writeFile(artifacts.auditSyncOutputPath, stdout, "utf8"),
        fs.writeFile(artifacts.auditSyncStderrPath, stderr, "utf8")
      ]);

      if (exitCode !== 0) {
        reject(
          new Error(
            `Audit sync helper exited with code ${exitCode ?? "unknown"}${
              signal ? ` (signal ${signal})` : ""
            }${stderr.trim() ? `: ${stderr.trim()}` : ""}`
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout);

        if (!isJsonObject(parsed)) {
          throw new Error("Audit sync helper did not return a JSON object.");
        }

        resolve(parsed);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to parse audit sync helper output.")
        );
      }
    });
  });
};

export class PromptRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private processingPrompt = false;
  private paused = false;
  private leaseClient: PoolClient | null = null;
  private activePromptId: string | null = null;
  private activePromptStatus: PromptStatus | null = null;
  private readonly runnerSessionId = `runner-${process.pid}-${Date.now()}`;

  async start() {
    if (!env.promptRunnerEnabled) {
      console.log("Prompt runner disabled via PROMPT_RUNNER_ENABLED.");
      return;
    }

    if (this.timer) {
      return;
    }

    setPromptRunner(this);

    try {
      const recovered = await recoverActivePrompts(this.runnerSessionId);

      if (recovered.length) {
        console.warn(
          `Recovered ${recovered.length} interrupted prompt${recovered.length === 1 ? "" : "s"} on startup.`
        );
      }
    } catch (error) {
      console.error("Prompt runner could not recover interrupted prompts", error);
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, env.promptRunnerPollMs);

    void this.tick();
    console.log(
      `Prompt runner enabled. Polling every ${env.promptRunnerPollMs}ms using ${env.promptRunnerCodexBin}.`
    );
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    publishPromptWorkspaceEvent({
      reason: "Prompt runner stopped.",
      promptId: this.activePromptId,
      scope: "runner"
    });
  }

  pause(): PromptRunnerStateSnapshot {
    this.paused = true;
    publishPromptWorkspaceEvent({
      reason: "Prompt runner paused by operator.",
      promptId: this.activePromptId,
      scope: "runner"
    });
    return this.getState();
  }

  resume(): PromptRunnerStateSnapshot {
    this.paused = false;
    publishPromptWorkspaceEvent({
      reason: "Prompt runner resumed by operator.",
      promptId: this.activePromptId,
      scope: "runner"
    });
    void this.tick();
    return this.getState();
  }

  getState(): PromptRunnerStateSnapshot {
    return {
      paused: this.paused,
      inFlight: this.processingPrompt,
      activePromptId: this.activePromptId,
      activePromptStatus: this.activePromptStatus,
      pollMs: env.promptRunnerPollMs,
      automationBranch: env.promptRunnerAutomationBranch,
      worktreeRoot: path.relative(env.promptRunnerRepoRoot, env.promptRunnerWorktreeRoot) ||
        env.promptRunnerWorktreeRoot,
      runnerSessionId: this.runnerSessionId
    };
  }

  private async acquireProcessingLease() {
    if (this.leaseClient) {
      return true;
    }

    const client = await pool.connect();

    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [PROMPT_RUNNER_LEASE_KEY]
      );

      if (!result.rows[0]?.acquired) {
        client.release();
        return false;
      }

      this.leaseClient = client;
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  private async releaseProcessingLease() {
    const client = this.leaseClient;
    this.leaseClient = null;

    if (!client) {
      return;
    }

    try {
      await client.query("SELECT pg_advisory_unlock($1)", [PROMPT_RUNNER_LEASE_KEY]);
    } finally {
      client.release();
    }
  }

  private async tick() {
    if (this.ticking || this.paused) {
      return;
    }

    this.ticking = true;
    let leaseAcquired = false;

    try {
      leaseAcquired = await this.acquireProcessingLease();

      if (!leaseAcquired) {
        return;
      }

      const prompt = await claimNextQueuedPrompt();

      if (!prompt) {
        return;
      }

      this.processingPrompt = true;
      await this.processPrompt(prompt);
    } catch (error) {
      console.error("Prompt runner tick failed", error);
    } finally {
      if (leaseAcquired) {
        await this.releaseProcessingLease();
      }
      this.ticking = false;
    }
  }

  private async processPrompt(prompt: Prompt) {
    const controllerRepoRoot = env.promptRunnerRepoRoot;
    const artifacts = await createRunArtifacts(controllerRepoRoot, prompt.id);
    const transitions: RunnerTransition[] = [];
    const promptStartedAt = Date.now();
    let preflightCanvasReport: CanvasValidationReport | null = null;
    let postflightCanvasReport: CanvasValidationReport | null = null;
    let preparedWorktree: PreparedPromptWorktree | null = null;
    let containerDocumentRepo: ContainerDocumentRepo | null = null;
    let finalizedWorktree: JsonObject | null = null;
    const gitOperations: JsonObject[] = [];

    const runnerMetadata: JsonObject = {
      runnerSessionId: this.runnerSessionId,
      controllerRepoRoot,
      automationBranch: env.promptRunnerAutomationBranch,
      remoteName: env.promptRunnerRemoteName,
      worktreeRoot: env.promptRunnerWorktreeRoot,
      codexBin: env.promptRunnerCodexBin,
      runDirectory: artifacts.runDirectory,
      instructionPath: artifacts.instructionPath,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      outputPath: artifacts.outputPath,
      auditSyncOutputPath: artifacts.auditSyncOutputPath,
      auditSyncStderrPath: artifacts.auditSyncStderrPath,
      gitOperations,
      statusTransitions: transitions
    };

    this.activePromptId = prompt.id;
    this.activePromptStatus = prompt.status;

    const buildFailureTelemetry = (error: unknown): FailureTelemetry => {
      const latestTransition = transitions[transitions.length - 1];
      const stackSummary = summarizeErrorStack(error);

      return {
        stage: latestTransition?.status || prompt.status,
        capturedAt: new Date().toISOString(),
        promptId: prompt.id,
        runnerSessionId: this.runnerSessionId,
        statusAtFailure: latestTransition?.status || prompt.status,
        message: toErrorMessage(error),
        transitionReason: latestTransition?.reason || null,
        transitionCount: transitions.length,
        durationMs: Date.now() - promptStartedAt,
        stdoutPath: artifacts.stdoutPath,
        stderrPath: artifacts.stderrPath,
        outputPath: artifacts.outputPath,
        auditSyncOutputPath: artifacts.auditSyncOutputPath,
        auditSyncStderrPath: artifacts.auditSyncStderrPath,
        stack: stackSummary,
        worktreePath: preparedWorktree?.worktreePath || null,
        promptBranch: preparedWorktree?.promptBranch || null,
        automationBranch: preparedWorktree?.automationBranch || env.promptRunnerAutomationBranch
      };
    };

    const transitionTo = async (
      status: PromptStatus,
      reason: string,
      extraMetadata?: JsonObject
    ) => {
      const nextTransition: RunnerTransition = {
        status,
        at: new Date().toISOString(),
        reason
      };

      transitions.push(nextTransition);
      this.activePromptStatus = status;
      runnerMetadata.statusTransitions = transitions.map((transition) => ({
        status: transition.status,
        at: transition.at,
        reason: transition.reason
      }));

      if (extraMetadata) {
        Object.assign(runnerMetadata, extraMetadata);
      }

      await updatePrompt(prompt.id, {
        status,
        metadataPatch: {
          runner: runnerMetadata
        },
        errorMessage: null
      });
    };

    try {
      await transitionTo("scanning", "Claimed prompt for processing.");
      let repoRoot = "";
      let documentStoreRoot = "";
      let programPath = "";
      let auditPath = "";
      let schemaPath = "";
      let remoteName = env.promptRunnerRemoteName;
      let remoteUrl = "";
      let remoteConfigured = false;
      let promptBranch = env.promptRunnerAutomationBranch;
      let automationBranch = env.promptRunnerAutomationBranch;
      let documentStoreIsRepoRoot = false;
      let documentStoreHasDedicatedGitRepo = false;
      let codexRepoRoot = "";
      let auditSyncRepoRoot = "";
      let worktreeBaseCommitSha = "";
      let documentStoreBaseCommitSha = "";
      const expectedCommitSubject = buildPromptCommitSubject(prompt.content);

      if (env.promptRunnerExecutionMode === "container") {
        containerDocumentRepo = await ensureContainerDocumentRepo({
          gitOperations
        });
        repoRoot = containerDocumentRepo.repoRoot;
        documentStoreRoot = containerDocumentRepo.documentStoreRoot;
        programPath = path.join(controllerRepoRoot, "program.md");
        auditPath = path.join(documentStoreRoot, "audit.md");
        schemaPath = path.join(
          controllerRepoRoot,
          "schemas",
          "codex-run-output.schema.json"
        );
        remoteName = containerDocumentRepo.remoteName;
        remoteUrl = containerDocumentRepo.remoteUrl;
        remoteConfigured = containerDocumentRepo.remoteConfigured;
        promptBranch = containerDocumentRepo.branch;
        automationBranch = containerDocumentRepo.branch;
        documentStoreIsRepoRoot = true;
        documentStoreHasDedicatedGitRepo = true;
        documentStoreBaseCommitSha = await runGit(repoRoot, ["rev-parse", "HEAD"], gitOperations);

        Object.assign(runnerMetadata, {
          executionMode: "container",
          repoRoot,
          documentStoreRoot,
          programPath,
          auditPath,
          schemaPath,
          auditSyncScriptPath: path.join(controllerRepoRoot, "scripts", "sync-prompt-audit.ts"),
          remoteConfigured,
          remoteName,
          remoteUrl,
          workingRepository: containerDocumentRepo.remoteUrl,
          workingBranch: containerDocumentRepo.branch,
          documentStoreGitUrl: env.promptRunnerContainerRepoUrl,
          documentStoreGitBranch: containerDocumentRepo.branch
        });
      } else {
        preparedWorktree = await preparePromptWorktree({
          repoRoot: controllerRepoRoot,
          worktreeRoot: env.promptRunnerWorktreeRoot,
          automationBranch: env.promptRunnerAutomationBranch,
          promptId: prompt.id,
          remoteName: env.promptRunnerRemoteName,
          documentStoreDir: env.documentStoreDir,
          documentStoreGitUrl: env.promptRunnerContainerRepoUrl,
          documentStoreGitBranch: env.promptRunnerContainerRepoBranch
        });

        repoRoot = preparedWorktree.worktreePath;
        documentStoreRoot = path.join(repoRoot, env.documentStoreDir);
        programPath = path.join(repoRoot, "program.md");
        auditPath = path.join(documentStoreRoot, "audit.md");
        schemaPath = path.join(repoRoot, "schemas", "codex-run-output.schema.json");
        documentStoreHasDedicatedGitRepo = preparedWorktree.documentStoreSeedMode === "clone";

        if (documentStoreHasDedicatedGitRepo) {
          remoteName = "origin";
          remoteUrl = await runGit(
            documentStoreRoot,
            ["remote", "get-url", remoteName],
            gitOperations
          ).catch(() => preparedWorktree?.documentStoreCloneRepoUrl || "");
          remoteConfigured = true;
          promptBranch =
            preparedWorktree.documentStoreCloneBranch || env.promptRunnerContainerRepoBranch;
          automationBranch = promptBranch;
          documentStoreBaseCommitSha = await runGit(
            documentStoreRoot,
            ["rev-parse", "HEAD"],
            gitOperations
          );
        } else {
          remoteName = preparedWorktree.remoteName;
          remoteUrl = await runGit(
            repoRoot,
            ["remote", "get-url", remoteName],
            gitOperations
          ).catch(() => "");
          remoteConfigured = preparedWorktree.remoteConfigured;
          promptBranch = preparedWorktree.promptBranch;
          automationBranch = preparedWorktree.automationBranch;
          worktreeBaseCommitSha = await runGit(
            repoRoot,
            ["rev-parse", preparedWorktree.promptBranch],
            gitOperations
          );
        }

        Object.assign(runnerMetadata, {
          executionMode: "worktree",
          repoRoot,
          documentStoreRoot,
          programPath,
          auditPath,
          schemaPath,
          auditSyncScriptPath: path.join(repoRoot, "scripts", "sync-prompt-audit.ts"),
          worktreePath: preparedWorktree.worktreePath,
          promptBranch: preparedWorktree.promptBranch,
          remoteConfigured: preparedWorktree.remoteConfigured,
          remoteUrl,
          workingRepository:
            preparedWorktree.documentStoreCloneRepoUrl ||
            remoteUrl ||
            preparedWorktree.worktreePath,
          workingBranch:
            preparedWorktree.documentStoreCloneBranch || preparedWorktree.promptBranch,
          baseRef: preparedWorktree.baseRef,
          documentStoreDir: preparedWorktree.documentStoreDir,
          documentStoreSeedMode: preparedWorktree.documentStoreSeedMode,
          documentStoreSeedPaths: preparedWorktree.documentStoreSeedPaths,
          documentStoreCloneRepoUrl: preparedWorktree.documentStoreCloneRepoUrl,
          documentStoreCloneBranch: preparedWorktree.documentStoreCloneBranch,
          controllerSyncedPaths: preparedWorktree.controllerSyncedPaths,
          controllerRemovedPaths: preparedWorktree.controllerRemovedPaths
        });
      }

      ({ codexRepoRoot, auditSyncRepoRoot } = resolvePromptExecutionRoots({
        repoRoot,
        documentStoreRoot,
        documentStoreHasDedicatedGitRepo: documentStoreIsRepoRoot || documentStoreHasDedicatedGitRepo
      }));

      if (worktreeBaseCommitSha) {
        runnerMetadata.initialCommitSha = worktreeBaseCommitSha;
      }

      if (documentStoreBaseCommitSha) {
        runnerMetadata.documentStoreInitialCommitSha = documentStoreBaseCommitSha;
      }

      runnerMetadata.executionRepoRoot = codexRepoRoot;
      runnerMetadata.auditSyncRepoRoot = auditSyncRepoRoot;
      runnerMetadata.expectedCommitSubject = expectedCommitSubject;

      preflightCanvasReport = await validateCanvasState({
        repoRoot,
        knowledgeRoot: documentStoreRoot,
        requireCanonical: false
      });

      runnerMetadata.canvasValidation = {
        preflight: preflightCanvasReport
      };

      await updatePrompt(prompt.id, {
        metadataPatch: {
          runner: runnerMetadata
        }
      });

      if (!preflightCanvasReport.valid) {
        throw new Error(
          formatCanvasValidationError(
            preflightCanvasReport,
            "Preflight canvas validation failed"
          )
        );
      }

      const instruction = buildInstruction({
        prompt,
        repoRoot,
        executionRepoRoot: codexRepoRoot,
        documentStoreRoot,
        programPath,
        auditPath,
        schemaPath,
        automationBranch,
        promptBranch,
        remoteName,
        expectedCommitSubject,
        documentStoreIsRepoRoot,
        documentStoreHasDedicatedGitRepo
      });

      await transitionTo("deciding", "Prepared Codex instruction payload.", {
        instructionLength: instruction.length
      });

      await transitionTo("writing", "Launching Codex CLI.");
      const execution = await executeCodex({
        instruction,
        artifacts,
        repoRoot: codexRepoRoot,
        schemaPath
      });

      await transitionTo("auditing", "Codex CLI completed. Parsing structured output.", {
        exitCode: execution.exitCode ?? -1,
        signal: execution.signal || null,
        completedAt: new Date().toISOString()
      });

      if (execution.exitCode !== 0) {
        throw new Error(
          `Codex CLI exited with code ${execution.exitCode ?? "unknown"}${
            execution.signal ? ` (signal ${execution.signal})` : ""
          }`
        );
      }

      const finalOutput = (await readJsonFile(artifacts.outputPath)) as JsonObject &
        CodexRunOutput;

      if (finalOutput.promptId !== prompt.id) {
        throw new Error(
          `Structured output promptId mismatch. Expected ${prompt.id}, received ${finalOutput.promptId}.`
        );
      }

      const terminalStatus =
        finalOutput.resultStatus === "failed" ? "failed" : "completed";

      let containerVerification: JsonObject | null = null;
      let clonedDocumentStoreVerification: JsonObject | null = null;
      let worktreeCommitVerification: JsonObject | null = null;
      let auditTimingResult: JsonObject | null = null;
      let finalGitResult: JsonObject | null = null;

      await transitionTo("updating_canvas", "Validating canvas files after Codex output.");
      postflightCanvasReport = await validateCanvasState({
        repoRoot,
        knowledgeRoot: documentStoreRoot,
        requireCanonical: finalOutput.repoChanges.canvasUpdated
      });
      runnerMetadata.canvasValidation = {
        preflight: preflightCanvasReport,
        postflight: postflightCanvasReport
      };

      if (!postflightCanvasReport.valid) {
        throw new Error(
          formatCanvasValidationError(
            postflightCanvasReport,
            "Post-run canvas validation failed"
          )
        );
      }

      let auditSyncResult: JsonObject | null = null;

      if (!finalOutput.audit.appended && terminalStatus === "completed") {
        throw new Error("Codex reported a completed run without appending an audit section.");
      }

      if (terminalStatus === "completed") {
        await transitionTo(
          "committing",
          "Appending queue and processing timing to audit.md and creating the final prompt commit."
        );

        const finalizedAt = new Date().toISOString();
        auditTimingResult = toJsonValue(
          await appendPromptTimingToAuditSection({
            auditPath,
            promptId: prompt.id,
            createdAt: prompt.createdAt,
            startedAt: prompt.startedAt,
            finalizedAt
          })
        ) as JsonObject;

        runnerMetadata.auditTiming = auditTimingResult;

        if (env.promptRunnerExecutionMode === "container" && containerDocumentRepo) {
          await assertHeadMatches({
            repoRoot,
            expectedHeadSha: documentStoreBaseCommitSha,
            gitOperations
          });

          const commitResult = await createPromptCommit({
            repoRoot,
            commitSubject: expectedCommitSubject,
            gitOperations
          });

          await transitionTo("pushing", "Pushing final prompt commit to the document-store remote.");
          await pushPromptCommit({
            repoRoot,
            remoteName: containerDocumentRepo.remoteName,
            branch: containerDocumentRepo.branch,
            gitOperations
          });

          containerVerification = toJsonValue(
            await verifyContainerDocumentRepoPush({
              repoRoot,
              remoteName: containerDocumentRepo.remoteName,
              branch: containerDocumentRepo.branch,
              expectedCommitSha: commitResult.commitSha,
              expectedBaseSha: documentStoreBaseCommitSha,
              expectedCommitSubject
            })
          ) as JsonObject;

          finalGitResult = {
            repoRoot,
            remoteName: containerDocumentRepo.remoteName,
            branch: containerDocumentRepo.branch,
            commitSha: commitResult.commitSha,
            commitSubject: commitResult.commitSubject,
            commitCreated: true,
            pushSucceeded: true
          } satisfies JsonObject;
        } else if (
          preparedWorktree?.documentStoreSeedMode === "clone" &&
          preparedWorktree.documentStoreCloneBranch
        ) {
          await assertHeadMatches({
            repoRoot: documentStoreRoot,
            expectedHeadSha: documentStoreBaseCommitSha,
            gitOperations
          });

          const commitResult = await createPromptCommit({
            repoRoot: documentStoreRoot,
            commitSubject: expectedCommitSubject,
            gitOperations
          });

          await transitionTo("pushing", "Pushing final prompt commit to the document-store remote.");
          await pushPromptCommit({
            repoRoot: documentStoreRoot,
            remoteName: "origin",
            branch: preparedWorktree.documentStoreCloneBranch,
            gitOperations
          });

          clonedDocumentStoreVerification = toJsonValue(
            await verifyContainerDocumentRepoPush({
              repoRoot: documentStoreRoot,
              remoteName: "origin",
              branch: preparedWorktree.documentStoreCloneBranch,
              expectedCommitSha: commitResult.commitSha,
              expectedBaseSha: documentStoreBaseCommitSha,
              expectedCommitSubject
            })
          ) as JsonObject;

          finalGitResult = {
            repoRoot: documentStoreRoot,
            remoteName: "origin",
            branch: preparedWorktree.documentStoreCloneBranch,
            commitSha: commitResult.commitSha,
            commitSubject: commitResult.commitSubject,
            commitCreated: true,
            pushSucceeded: true
          } satisfies JsonObject;
        } else if (preparedWorktree && worktreeBaseCommitSha) {
          await assertHeadMatches({
            repoRoot,
            expectedHeadSha: worktreeBaseCommitSha,
            headRef: preparedWorktree.promptBranch,
            gitOperations
          });

          const commitResult = await createPromptCommit({
            repoRoot,
            commitSubject: expectedCommitSubject,
            pathspecs: [preparedWorktree.documentStoreDir],
            gitOperations
          });

          worktreeCommitVerification = toJsonValue(
            await verifySinglePromptCommit({
              repoRoot,
              expectedBaseSha: worktreeBaseCommitSha,
              expectedCommitSha: commitResult.commitSha,
              expectedCommitSubject,
              headRef: preparedWorktree.promptBranch,
              statusPathspecs: [preparedWorktree.documentStoreDir],
              gitOperations
            })
          ) as JsonObject;

          finalGitResult = {
            repoRoot,
            remoteName: preparedWorktree.remoteName,
            branch: preparedWorktree.promptBranch,
            commitSha: commitResult.commitSha,
            commitSubject: commitResult.commitSubject,
            commitCreated: true,
            pushSucceeded: preparedWorktree.remoteConfigured
          } satisfies JsonObject;
        }
      }

      if (finalOutput.audit.appended) {
        await transitionTo(
          "syncing_audit",
          "Synchronizing obsidian-repository/audit.md into prompts.audit."
        );
        auditSyncResult = await executeAuditSync({
          promptId: prompt.id,
          artifacts,
          repoRoot: auditSyncRepoRoot,
          auditPath,
          scriptRepoRoot: controllerRepoRoot
        });
      }

      if (terminalStatus === "completed" && preparedWorktree) {
        await transitionTo(
          "pushing",
          preparedWorktree.outerAutomationRemoteSync
            ? "Promoting the final prompt commit onto the automation branch."
            : "Cleaning prompt worktree after final document-store push.",
          {
            finalGit: finalGitResult || undefined
          }
        );
        finalizedWorktree = toJsonValue(
          await finalizePromptWorktree(preparedWorktree)
        ) as JsonObject;

        if (
          preparedWorktree.outerAutomationRemoteSync &&
          isJsonObject(finalGitResult) &&
          typeof finalizedWorktree.automationBranch === "string" &&
          typeof finalizedWorktree.automationCommitSha === "string"
        ) {
          finalGitResult = {
            ...finalGitResult,
            branch: finalizedWorktree.automationBranch,
            commitSha: finalizedWorktree.automationCommitSha,
            pushSucceeded: preparedWorktree.remoteConfigured
          };
        }
      }

      await updatePrompt(prompt.id, {
        status: terminalStatus,
        setFinishedAt: true,
        metadataPatch: {
          runner: {
            ...runnerMetadata,
            finalOutputCapturedAt: new Date().toISOString(),
            durationMs: Date.now() - promptStartedAt,
            auditTiming: auditTimingResult,
            finalGit: finalGitResult
          },
          execution: {
            finalOutput,
            finalGit: finalGitResult,
            outputPath: artifacts.outputPath,
            stdoutPath: artifacts.stdoutPath,
            stderrPath: artifacts.stderrPath
          },
          auditSync: auditSyncResult
            ? {
                ...auditSyncResult,
                outputPath: artifacts.auditSyncOutputPath,
                stderrPath: artifacts.auditSyncStderrPath,
                syncedAt: new Date().toISOString()
              }
            : {
                skipped: true,
                reason: "Codex did not append an audit section.",
                outputPath: artifacts.auditSyncOutputPath,
                stderrPath: artifacts.auditSyncStderrPath
              },
          worktree: preparedWorktree
            ? {
                path: preparedWorktree.worktreePath,
                promptBranch: preparedWorktree.promptBranch,
                automationBranch: preparedWorktree.automationBranch,
                baseRef: preparedWorktree.baseRef,
                documentStoreDir: preparedWorktree.documentStoreDir,
                documentStoreSeedMode: preparedWorktree.documentStoreSeedMode,
                documentStoreSeedPaths: preparedWorktree.documentStoreSeedPaths,
                documentStoreCloneRepoUrl: preparedWorktree.documentStoreCloneRepoUrl,
                documentStoreCloneBranch: preparedWorktree.documentStoreCloneBranch,
                controllerSyncedPaths: preparedWorktree.controllerSyncedPaths,
                controllerRemovedPaths: preparedWorktree.controllerRemovedPaths,
                remoteConfigured: preparedWorktree.remoteConfigured,
                outerAutomationRemoteSync: preparedWorktree.outerAutomationRemoteSync,
                commitVerification: worktreeCommitVerification,
                documentStoreVerification: clonedDocumentStoreVerification,
                finalized: finalizedWorktree
              }
            : null,
          containerRepo: containerDocumentRepo
            ? {
                path: containerDocumentRepo.repoRoot,
                branch: containerDocumentRepo.branch,
                remoteName: containerDocumentRepo.remoteName,
                remoteUrl: containerDocumentRepo.remoteUrl,
                remoteConfigured: containerDocumentRepo.remoteConfigured,
                verification: containerVerification
              }
            : null
        },
        errorMessage:
          terminalStatus === "failed"
            ? finalOutput.blockers.join("; ") || "Codex reported a failed run."
            : null
      });
    } catch (error) {
      const message = toErrorMessage(error);
      const failureTelemetry = buildFailureTelemetry(error);

      await updatePrompt(prompt.id, {
        status: "failed",
        setFinishedAt: true,
        metadataPatch: {
          runner: runnerMetadata,
          failure: failureTelemetry,
          execution: {
            outputPath: artifacts.outputPath,
            stdoutPath: artifacts.stdoutPath,
            stderrPath: artifacts.stderrPath
          },
          auditSync: {
            outputPath: artifacts.auditSyncOutputPath,
            stderrPath: artifacts.auditSyncStderrPath
          },
          worktree: preparedWorktree
            ? {
                path: preparedWorktree.worktreePath,
                promptBranch: preparedWorktree.promptBranch,
                automationBranch: preparedWorktree.automationBranch,
                documentStoreDir: preparedWorktree.documentStoreDir,
                documentStoreSeedMode: preparedWorktree.documentStoreSeedMode,
                documentStoreCloneRepoUrl: preparedWorktree.documentStoreCloneRepoUrl,
                documentStoreCloneBranch: preparedWorktree.documentStoreCloneBranch,
                remoteConfigured: preparedWorktree.remoteConfigured,
                outerAutomationRemoteSync: preparedWorktree.outerAutomationRemoteSync,
                preserved: true
              }
            : null,
          containerRepo: containerDocumentRepo
            ? {
                path: containerDocumentRepo.repoRoot,
                branch: containerDocumentRepo.branch,
                remoteName: containerDocumentRepo.remoteName,
                remoteConfigured: containerDocumentRepo.remoteConfigured
              }
            : null
        },
        errorMessage: message
      });

      console.error(`Prompt ${prompt.id} failed`, error);
    } finally {
      this.processingPrompt = false;
      this.activePromptId = null;
      this.activePromptStatus = null;
      publishPromptWorkspaceEvent({
        reason: "Prompt runner cleared active prompt state.",
        promptId: prompt.id,
        scope: "runner"
      });
    }
  }
}
