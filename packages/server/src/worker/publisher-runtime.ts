import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PreparedPromptWorktree } from "../services/git-worktree";
import { appendPromptTimingToAuditSection } from "../services/prompt-audit-timing";
import { verifyContainerDocumentRepoPush } from "../services/container-document-repo";
import type { Prompt, JsonObject } from "../repositories/prompt-repository";
import type { ContainerDocumentRepo, RunArtifacts, CodexRunOutput } from "./runtime-types";
import {
  assertHeadMatches,
  createPromptCommit,
  pushPromptCommit,
  resolveTsxBin,
  verifySinglePromptCommit
} from "./runtime-shared";

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toJsonValue = (value: unknown): unknown => {
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
      result[key] = toJsonValue(item) as never;
      return result;
    }, {});
  }

  return String(value);
};

export const executeAuditSync = async ({
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

export type PromptPublisherPhaseResult = {
  auditTimingResult: JsonObject | null;
  finalGitResult: JsonObject | null;
  auditSyncResult: JsonObject | null;
  containerVerification: JsonObject | null;
  clonedDocumentStoreVerification: JsonObject | null;
  worktreeCommitVerification: JsonObject | null;
};

export const runPromptPublisherPhase = async ({
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
  onBeforePush,
  onBeforeAuditSync
}: {
  prompt: Prompt;
  terminalStatus: "completed" | "failed";
  finalOutput: JsonObject & CodexRunOutput;
  repoRoot: string;
  documentStoreRoot: string;
  auditPath: string;
  auditSyncRepoRoot: string;
  controllerRepoRoot: string;
  artifacts: RunArtifacts;
  expectedCommitSubject: string;
  containerDocumentRepo: ContainerDocumentRepo | null;
  preparedWorktree: PreparedPromptWorktree | null;
  documentStoreBaseCommitSha: string;
  worktreeBaseCommitSha: string;
  gitOperations?: JsonObject[];
  onBeforePush?: (detail: { target: "container" | "clone" | "worktree"; branch: string }) => Promise<void> | void;
  onBeforeAuditSync?: () => Promise<void> | void;
}): Promise<PromptPublisherPhaseResult> => {
  let containerVerification: JsonObject | null = null;
  let clonedDocumentStoreVerification: JsonObject | null = null;
  let worktreeCommitVerification: JsonObject | null = null;
  let auditTimingResult: JsonObject | null = null;
  let finalGitResult: JsonObject | null = null;
  let auditSyncResult: JsonObject | null = null;

  if (!finalOutput.audit.appended && terminalStatus === "completed") {
    throw new Error("Codex reported a completed run without appending an audit section.");
  }

  if (terminalStatus === "completed") {
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

    if (containerDocumentRepo) {
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

      await onBeforePush?.({
        target: "container",
        branch: containerDocumentRepo.branch
      });

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

      await onBeforePush?.({
        target: "clone",
        branch: preparedWorktree.documentStoreCloneBranch
      });

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
    await onBeforeAuditSync?.();

    auditSyncResult = await executeAuditSync({
      promptId: prompt.id,
      artifacts,
      repoRoot: auditSyncRepoRoot,
      auditPath,
      scriptRepoRoot: controllerRepoRoot
    });
  }

  return {
    auditTimingResult,
    finalGitResult,
    auditSyncResult,
    containerVerification,
    clonedDocumentStoreVerification,
    worktreeCommitVerification
  };
};
