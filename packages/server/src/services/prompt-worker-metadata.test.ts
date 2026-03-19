import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWorkerMetadataPatch } from "./prompt-worker-metadata";

test("buildPromptWorkerMetadataPatch creates hardened worker metadata", () => {
  const metadata = buildPromptWorkerMetadataPatch({
    attempt: 3,
    phase: "running",
    jobName: "prompt-123",
    namespace: "schizm",
    executorImage: "executor:v1",
    publisherImage: "publisher:v1"
  });

  assert.deepEqual(metadata.worker, {
    executionMode: "kube-worker",
    hardened: true,
    isolatedSecretHandling: true,
    attempt: 3,
    phase: "running",
    jobName: "prompt-123",
    podName: null,
    namespace: "schizm",
    images: {
      executor: "executor:v1",
      publisher: "publisher:v1"
    },
    secretBoundaries: {
      executorHasGitSecrets: false,
      executorHasCodexSecretsAtLaunch: true,
      executorScrubsCodexSecretsAfterLaunch: true
    },
    logsPreview: {
      stdout: null,
      stderr: null
    }
  });
});
