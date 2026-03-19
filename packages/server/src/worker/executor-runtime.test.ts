import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptExecutionInstruction } from "./executor-runtime";
import type { Prompt } from "../repositories/prompt-repository";

const prompt: Prompt = {
  id: "prompt-123",
  content: "hello world",
  status: "queued",
  metadata: {},
  audit: {},
  startedAt: null,
  finishedAt: null,
  errorMessage: null,
  createdAt: "2026-03-19T00:00:00.000Z",
  updatedAt: "2026-03-19T00:00:00.000Z"
};

test("buildPromptExecutionInstruction preserves the runner-owned final commit contract", () => {
  const instruction = buildPromptExecutionInstruction({
    prompt,
    repoRoot: "/repo",
    executionRepoRoot: "/repo",
    documentStoreRoot: "/repo/obsidian-repository",
    programPath: "/repo/program.md",
    auditPath: "/repo/obsidian-repository/audit.md",
    schemaPath: "/repo/schemas/codex-run-output.schema.json",
    automationBranch: "codex/mindmap",
    promptBranch: "codex/run-prompt-123",
    remoteName: "origin",
    expectedCommitSubject: "hello world"
  });

  assert.match(instruction, /Do not commit or push changes yourself/);
  assert.match(instruction, /runner to optionally run a configured canvas rearranging command/);
  assert.match(instruction, /runner will append timing details/);
  assert.match(instruction, /Use this exact final commit subject: "hello world"/);
});

test("buildPromptExecutionInstruction explains dedicated document store mode", () => {
  const instruction = buildPromptExecutionInstruction({
    prompt,
    repoRoot: "/controller",
    executionRepoRoot: "/controller/obsidian-repository",
    documentStoreRoot: "/controller/obsidian-repository",
    programPath: "/controller/program.md",
    auditPath: "/controller/obsidian-repository/audit.md",
    schemaPath: "/controller/schemas/codex-run-output.schema.json",
    automationBranch: "main",
    promptBranch: "main",
    remoteName: "origin",
    expectedCommitSubject: "hello world",
    documentStoreIsRepoRoot: true,
    documentStoreHasDedicatedGitRepo: true
  });

  assert.match(instruction, /document store repository itself is the writable root/);
  assert.match(instruction, /runner will perform the final commit\/push there/);
});
