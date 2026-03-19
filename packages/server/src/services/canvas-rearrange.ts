import { spawn } from "node:child_process";
import { env } from "../config/env";
import type { JsonObject } from "../repositories/prompt-repository";

const trimOutput = (value: string, limit = 4000) => {
  const trimmed = value.trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, limit)}…`;
};

export type CanvasRearrangeResult = {
  command: string | null;
  cwd: string;
  skipped: boolean;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
};

export const runCanvasRearrangeCommand = async ({
  repoRoot,
  documentStoreRoot
}: {
  repoRoot: string;
  documentStoreRoot: string;
}): Promise<CanvasRearrangeResult> => {
  const command = (
    process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND ||
    env.promptRunnerCanvasRearrangeCommand
  ).trim();

  if (!command) {
    return {
      command: null,
      cwd: documentStoreRoot,
      skipped: true,
      reason: "PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND is not configured.",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      stdout: null,
      stderr: null
    };
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  return new Promise<CanvasRearrangeResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: documentStoreRoot,
      env: {
        ...process.env,
        DOCUMENT_STORE_DIR: documentStoreRoot,
        PROMPT_RUNNER_REPO_ROOT: repoRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", reject);

    child.once("close", (exitCode, signal) => {
      const finishedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      const stdout = trimOutput(Buffer.concat(stdoutChunks).toString("utf8"));
      const stderr = trimOutput(Buffer.concat(stderrChunks).toString("utf8"));

      const result: CanvasRearrangeResult = {
        command,
        cwd: documentStoreRoot,
        skipped: false,
        reason: null,
        startedAt,
        finishedAt,
        durationMs,
        stdout: stdout || null,
        stderr: stderr || null
      };

      if (exitCode !== 0) {
        reject(
          new Error(
            `Canvas rearranging command failed with code ${exitCode ?? "unknown"}${
              signal ? ` (signal ${signal})` : ""
            }${stderr ? `: ${stderr}` : ""}`
          )
        );
        return;
      }

      resolve(result);
    });
  });
};

export const toCanvasRearrangeMetadata = (result: CanvasRearrangeResult): JsonObject => ({
  command: result.command,
  cwd: result.cwd,
  skipped: result.skipped,
  reason: result.reason,
  startedAt: result.startedAt,
  finishedAt: result.finishedAt,
  durationMs: result.durationMs,
  stdout: result.stdout,
  stderr: result.stderr
});
