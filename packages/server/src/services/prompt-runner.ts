import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env";
import {
  finalizePromptWorktree,
  preparePromptWorktree,
  type PreparedPromptWorktree
} from "./git-worktree";
import { setPromptRunner } from "./prompt-runner-registry";
import {
  formatCanvasValidationError,
  validateCanvasState,
  type CanvasValidationReport
} from "./canvas-validator";
import {
  claimNextQueuedPrompt,
  recoverActivePrompts,
  type JsonObject,
  type JsonValue,
  type Prompt,
  type PromptStatus,
  updatePrompt
} from "../repositories/prompt-repository";

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

type FailureTelemetry = JsonObject & {
  stage: string;
  capturedAt: string;
  promptId: string;
  runnerSessionId: string;
  statusAtFailure: string;
  message: string;
};

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
  documentStoreRoot,
  programPath,
  auditPath,
  schemaPath,
  automationBranch,
  promptBranch,
  remoteName
}: {
  prompt: Prompt;
  repoRoot: string;
  documentStoreRoot: string;
  programPath: string;
  auditPath: string;
  schemaPath: string;
  automationBranch: string;
  promptBranch: string;
  remoteName: string;
}) => `You are processing a queued repository-maintenance prompt for this project.

Repository root: ${repoRoot}
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
- Treat every path outside ${documentStoreRoot} as read-only unless the human explicitly asked otherwise.
- Treat ${path.join(repoRoot, "packages")} and ${path.join(repoRoot, "scripts")} as read-only unless absolutely required by the contract.

User prompt:
"""text
${prompt.content}
"""

Run requirements:
- Update markdown and canvas files according to the contract in program.md.
- Append exactly one audit section to ${auditPath} using the required markers for prompt ${prompt.id} if the run reaches a coherent stopping point.
- Commit and push the resulting repository changes if the run succeeds.
- Return only a single JSON object that matches ${schemaPath}.
- The returned JSON must use promptId "${prompt.id}".
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
  repoRoot
}: {
  promptId: string;
  artifacts: RunArtifacts;
  repoRoot: string;
}) => {
  const tsxBin = resolveTsxBin(env.promptRunnerRepoRoot);
  const scriptPath = path.join(repoRoot, "scripts", "sync-prompt-audit.ts");
  const args = [scriptPath, "--prompt-id", promptId];

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
  private inFlight = false;
  private paused = false;
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
  }

  pause(): PromptRunnerStateSnapshot {
    this.paused = true;
    return this.getState();
  }

  resume(): PromptRunnerStateSnapshot {
    this.paused = false;
    void this.tick();
    return this.getState();
  }

  getState(): PromptRunnerStateSnapshot {
    return {
      paused: this.paused,
      inFlight: this.inFlight,
      activePromptId: this.activePromptId,
      activePromptStatus: this.activePromptStatus,
      pollMs: env.promptRunnerPollMs,
      automationBranch: env.promptRunnerAutomationBranch,
      worktreeRoot: path.relative(env.promptRunnerRepoRoot, env.promptRunnerWorktreeRoot) ||
        env.promptRunnerWorktreeRoot,
      runnerSessionId: this.runnerSessionId
    };
  }

  private async tick() {
    if (this.inFlight || this.paused) {
      return;
    }

    this.inFlight = true;

    try {
      const prompt = await claimNextQueuedPrompt();

      if (!prompt) {
        return;
      }

      await this.processPrompt(prompt);
    } catch (error) {
      console.error("Prompt runner tick failed", error);
    } finally {
      this.inFlight = false;
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
    let finalizedWorktree: JsonObject | null = null;

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

      preparedWorktree = await preparePromptWorktree({
        repoRoot: controllerRepoRoot,
        worktreeRoot: env.promptRunnerWorktreeRoot,
        automationBranch: env.promptRunnerAutomationBranch,
        promptId: prompt.id,
        remoteName: env.promptRunnerRemoteName,
        documentStoreDir: env.documentStoreDir
      });

      const repoRoot = preparedWorktree.worktreePath;
      const documentStoreRoot = path.join(repoRoot, env.documentStoreDir);
      const programPath = path.join(repoRoot, "program.md");
      const auditPath = path.join(documentStoreRoot, "audit.md");
      const schemaPath = path.join(repoRoot, "schemas", "codex-run-output.schema.json");

      Object.assign(runnerMetadata, {
        repoRoot,
        documentStoreRoot,
        programPath,
        auditPath,
        schemaPath,
        auditSyncScriptPath: path.join(repoRoot, "scripts", "sync-prompt-audit.ts"),
        worktreePath: preparedWorktree.worktreePath,
        promptBranch: preparedWorktree.promptBranch,
        remoteConfigured: preparedWorktree.remoteConfigured,
        baseRef: preparedWorktree.baseRef,
        documentStoreDir: preparedWorktree.documentStoreDir,
        documentStoreSeedMode: preparedWorktree.documentStoreSeedMode,
        documentStoreSeedPaths: preparedWorktree.documentStoreSeedPaths,
        controllerSyncedPaths: preparedWorktree.controllerSyncedPaths,
        controllerRemovedPaths: preparedWorktree.controllerRemovedPaths
      });

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
        documentStoreRoot,
        programPath,
        auditPath,
        schemaPath,
        automationBranch: preparedWorktree.automationBranch,
        promptBranch: preparedWorktree.promptBranch,
        remoteName: preparedWorktree.remoteName
      });

      await transitionTo("deciding", "Prepared Codex instruction payload.", {
        instructionLength: instruction.length
      });

      await transitionTo("writing", "Launching Codex CLI.");
      const execution = await executeCodex({
        instruction,
        artifacts,
        repoRoot,
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

      if (finalOutput.audit.appended) {
        await transitionTo(
          "syncing_audit",
          "Synchronizing obsidian-repository/audit.md into prompts.audit."
        );
        auditSyncResult = await executeAuditSync({
          promptId: prompt.id,
          artifacts,
          repoRoot
        });
      } else if (terminalStatus === "completed") {
        throw new Error("Codex reported a completed run without appending an audit section.");
      }

      if (terminalStatus === "completed" && preparedWorktree) {
        await transitionTo("committing", "Promoting the prompt branch onto the automation branch.");
        finalizedWorktree = toJsonValue(
          await finalizePromptWorktree(preparedWorktree)
        ) as JsonObject;
        await transitionTo("pushing", "Automation branch pushed. Cleaning prompt worktree.", {
          finalizedWorktree
        });
      }

      await updatePrompt(prompt.id, {
        status: terminalStatus,
        setFinishedAt: true,
        metadataPatch: {
          runner: {
            ...runnerMetadata,
            finalOutputCapturedAt: new Date().toISOString(),
            durationMs: Date.now() - promptStartedAt
          },
          execution: {
            finalOutput,
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
                controllerSyncedPaths: preparedWorktree.controllerSyncedPaths,
                controllerRemovedPaths: preparedWorktree.controllerRemovedPaths,
                remoteConfigured: preparedWorktree.remoteConfigured,
                finalized: finalizedWorktree
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
                remoteConfigured: preparedWorktree.remoteConfigured,
                preserved: true
              }
            : null
        },
        errorMessage: message
      });

      console.error(`Prompt ${prompt.id} failed`, error);
    } finally {
      this.activePromptId = null;
      this.activePromptStatus = null;
    }
  }
}
