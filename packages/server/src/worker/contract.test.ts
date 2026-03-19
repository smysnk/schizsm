import test from "node:test";
import assert from "node:assert/strict";
import {
  getPromptWorkerAllowedSecretKinds,
  parsePromptWorkerEnvironment
} from "./contract";

const baseEnv = {
  PROMPT_ID: "prompt-123",
  PROMPT_ATTEMPT: "1",
  PROMPT_JOB_NAME: "job-prompt-123",
  PROMPT_DISPATCHED_BY_SESSION: "runner-abc",
  PROMPT_RUNNER_EXECUTION_MODE: "kube-worker"
};

test("parsePromptWorkerEnvironment validates a codex executor contract", () => {
  const contract = parsePromptWorkerEnvironment({
    ...baseEnv,
    WORKER_ROLE: "codex-executor"
  });

  assert.equal(contract.role, "codex-executor");
  assert.equal(contract.promptId, "prompt-123");
  assert.equal(contract.promptAttempt, 1);
  assert.equal(contract.executionMode, "kube-worker");
});

test("parsePromptWorkerEnvironment rejects invalid worker roles", () => {
  assert.throws(
    () =>
      parsePromptWorkerEnvironment({
        ...baseEnv,
        WORKER_ROLE: "invalid-role"
      }),
    /WORKER_ROLE must be one of/
  );
});

test("getPromptWorkerAllowedSecretKinds enforces per-role secret boundaries", () => {
  assert.deepEqual(getPromptWorkerAllowedSecretKinds("repo-bootstrap"), ["git"]);
  assert.deepEqual(getPromptWorkerAllowedSecretKinds("codex-executor"), [
    "codex",
    "database"
  ]);
  assert.deepEqual(getPromptWorkerAllowedSecretKinds("repo-publisher"), [
    "git",
    "database"
  ]);
});
