import path from "node:path";
import type { PoolClient } from "pg";
import { env } from "../config/env";
import { pool } from "../db/pool";
import {
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
import {
  claimNextQueuedPrompt,
  getPrompt,
  recoverActivePrompts,
  type JsonObject,
  type JsonValue,
  type Prompt,
  type PromptStatus,
  updatePrompt
} from "../repositories/prompt-repository";
import {
  buildPromptExecutionInstruction,
  ensureContainerDocumentRepo,
  executePromptWithCodex,
  readPromptExecutionOutput
} from "../worker/executor-runtime";
import { runPromptPublisherPhase } from "../worker/publisher-runtime";
import {
  buildPromptCommitSubject,
  createRunArtifacts,
  resolvePromptExecutionRoots,
  runGit
} from "../worker/runtime-shared";
import type { CodexRunOutput, ContainerDocumentRepo, RunArtifacts } from "../worker/runtime-types";
import { dispatchPromptToKubeWorker } from "./prompt-dispatcher";
import { reconcileKubePromptExecutions } from "./prompt-worker-observer";

export { buildPromptCommitSubject, resolvePromptExecutionRoots } from "../worker/runtime-shared";

type RunnerTransition = {
  status: PromptStatus;
  at: string;
  reason: string;
};

type FailureTelemetry = JsonObject & {
  stage: string;
  capturedAt: string;
  promptId: string;
  runnerSessionId: string;
  statusAtFailure: string;
  message: string;
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

    if (env.promptRunnerExecutionMode !== "kube-worker") {
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
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, env.promptRunnerPollMs);

    void this.tick();
    console.log(
      env.promptRunnerExecutionMode === "kube-worker"
        ? `Prompt runner enabled. Polling every ${env.promptRunnerPollMs}ms and dispatching Kubernetes worker jobs.`
        : `Prompt runner enabled. Polling every ${env.promptRunnerPollMs}ms using ${env.promptRunnerCodexBin}.`
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

  async runPromptById(promptId: string) {
    if (this.processingPrompt) {
      throw new Error("Prompt runner is already processing a prompt.");
    }

    const prompt = await getPrompt(promptId);

    if (!prompt) {
      throw new Error(`Prompt ${promptId} not found.`);
    }

    this.processingPrompt = true;
    await this.processPrompt(prompt);
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

      if (env.promptRunnerExecutionMode === "kube-worker") {
        await reconcileKubePromptExecutions();
      }

      const prompt = await claimNextQueuedPrompt();

      if (!prompt) {
        return;
      }

      this.processingPrompt = true;
      if (env.promptRunnerExecutionMode === "kube-worker") {
        await this.dispatchPrompt(prompt);
      } else {
        await this.processPrompt(prompt);
      }
    } catch (error) {
      console.error("Prompt runner tick failed", error);
    } finally {
      if (leaseAcquired) {
        await this.releaseProcessingLease();
      }
      this.ticking = false;
    }
  }

  private async dispatchPrompt(prompt: Prompt) {
    const runnerMetadata: JsonObject = {
      runnerSessionId: this.runnerSessionId,
      executionMode: "kube-worker",
      controllerRepoRoot: env.promptRunnerRepoRoot,
      worktreeRoot: env.promptRunnerWorktreeRoot,
      statusTransitions: [
        {
          status: prompt.status,
          at: new Date().toISOString(),
          reason: "Claimed prompt for Kubernetes worker dispatch."
        }
      ]
    };

    this.activePromptId = prompt.id;
    this.activePromptStatus = prompt.status;

    try {
      await updatePrompt(prompt.id, {
        metadataPatch: {
          runner: runnerMetadata
        },
        errorMessage: null
      });

      const execution = await dispatchPromptToKubeWorker({
        prompt,
        runnerSessionId: this.runnerSessionId
      });

      await updatePrompt(prompt.id, {
        metadataPatch: {
          runner: {
            ...runnerMetadata,
            workerDispatch: {
              attempt: execution.attempt,
              jobName: execution.jobName,
              namespace: execution.namespace,
              image: execution.image,
              dispatchedAt: new Date().toISOString()
            }
          }
        }
      });
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

  private async processPrompt(prompt: Prompt) {
    const controllerRepoRoot = env.promptRunnerRepoRoot;
    const artifactsRoot =
      env.promptRunnerExecutionMode === "kube-worker"
        ? env.promptRunnerKubeRuntimeDir
        : controllerRepoRoot;
    const artifacts = await createRunArtifacts(artifactsRoot, prompt.id);
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

      if (
        env.promptRunnerExecutionMode === "container" ||
        env.promptRunnerExecutionMode === "kube-worker"
      ) {
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
          executionMode: env.promptRunnerExecutionMode,
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

      const instruction = buildPromptExecutionInstruction({
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
      const execution = await executePromptWithCodex({
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

      const finalOutput = await readPromptExecutionOutput(artifacts.outputPath);

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

      let {
        auditTimingResult,
        finalGitResult,
        auditSyncResult,
        containerVerification,
        clonedDocumentStoreVerification,
        worktreeCommitVerification
      } = await runPromptPublisherPhase({
        prompt,
        terminalStatus,
        finalOutput,
        repoRoot,
        documentStoreRoot,
        auditPath,
        auditSyncRepoRoot,
        controllerRepoRoot,
        artifacts,
        expectedCommitSubject,
        containerDocumentRepo,
        preparedWorktree,
        documentStoreBaseCommitSha,
        worktreeBaseCommitSha,
        gitOperations,
        onBeforePush: async ({ target }) => {
          await transitionTo(
            "pushing",
            target === "worktree"
              ? "Promoting the final prompt commit onto the automation branch."
              : "Pushing final prompt commit to the document-store remote."
          );
        },
        onBeforeAuditSync: async () => {
          await transitionTo(
            "syncing_audit",
            "Synchronizing obsidian-repository/audit.md into prompts.audit."
          );
        }
      });

      runnerMetadata.auditTiming = auditTimingResult;

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
