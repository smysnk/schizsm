import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWorkerJobName } from "./prompt-dispatcher";

test("buildPromptWorkerJobName creates a stable Kubernetes-safe job name", () => {
  assert.equal(
    buildPromptWorkerJobName("725a0a25-ff70-410c-8032-2c9c769f5bfa", 2),
    "schizm-prompt-725a0a25ff70-2"
  );
});
