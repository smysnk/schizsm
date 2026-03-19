import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runCanvasRearrangeCommand,
  toCanvasRearrangeMetadata
} from "./canvas-rearrange";

test("runCanvasRearrangeCommand executes the configured command in the document store root", async () => {
  const previousCommand = process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "schizm-canvas-rearrange-"));
  const markerPath = path.join(tempRoot, "rearranged.txt");

  process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND =
    "printf 'done' > rearranged.txt && printf 'rearranged'";

  try {
    const result = await runCanvasRearrangeCommand({
      repoRoot: tempRoot,
      documentStoreRoot: tempRoot
    });

    assert.equal(result.skipped, false);
    assert.equal(result.cwd, tempRoot);
    assert.equal(result.command?.includes("rearranged.txt"), true);
    assert.equal(result.stdout, "rearranged");
    assert.equal(typeof result.durationMs, "number");
    assert.equal(await readFile(markerPath, "utf8"), "done");
    assert.deepEqual(toCanvasRearrangeMetadata(result), {
      command: result.command,
      cwd: tempRoot,
      skipped: false,
      reason: null,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      stdout: "rearranged",
      stderr: null
    });
  } finally {
    if (previousCommand === undefined) {
      delete process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND;
    } else {
      process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND = previousCommand;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCanvasRearrangeCommand skips when no command is configured", async () => {
  const previousCommand = process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND;
  delete process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND;

  try {
    const result = await runCanvasRearrangeCommand({
      repoRoot: "/tmp/repo",
      documentStoreRoot: "/tmp/repo/obsidian-repository"
    });

    assert.deepEqual(result, {
      command: null,
      cwd: "/tmp/repo/obsidian-repository",
      skipped: true,
      reason: "PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND is not configured.",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      stdout: null,
      stderr: null
    });
  } finally {
    if (previousCommand === undefined) {
      delete process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND;
    } else {
      process.env.PROMPT_RUNNER_CANVAS_REARRANGE_COMMAND = previousCommand;
    }
  }
});
