import type { JsonObject } from "../repositories/prompt-repository";
import type { PromptExecutionStatus } from "../repositories/prompt-execution-repository";

export type PromptWorkerPhase = PromptExecutionStatus;

export type PromptWorkerMetadata = {
  worker: {
    executionMode: "kube-worker";
    hardened: true;
    isolatedSecretHandling: true;
    attempt: number;
    phase: PromptWorkerPhase;
    jobName: string | null;
    podName: string | null;
    namespace: string | null;
    images: {
      executor: string | null;
      publisher: string | null;
    };
    secretBoundaries: {
      executorHasGitSecrets: false;
      executorHasCodexSecretsAtLaunch: true;
      executorScrubsCodexSecretsAfterLaunch: true;
    };
    logsPreview?: {
      stdout?: string | null;
      stderr?: string | null;
    };
  };
};

export const buildPromptWorkerMetadataPatch = ({
  attempt,
  phase,
  jobName = null,
  podName = null,
  namespace = null,
  executorImage = null,
  publisherImage = null,
  stdoutPreview = null,
  stderrPreview = null
}: {
  attempt: number;
  phase: PromptWorkerPhase;
  jobName?: string | null;
  podName?: string | null;
  namespace?: string | null;
  executorImage?: string | null;
  publisherImage?: string | null;
  stdoutPreview?: string | null;
  stderrPreview?: string | null;
}): JsonObject => ({
  worker: {
    executionMode: "kube-worker",
    hardened: true,
    isolatedSecretHandling: true,
    attempt,
    phase,
    jobName,
    podName,
    namespace,
    images: {
      executor: executorImage,
      publisher: publisherImage
    },
    secretBoundaries: {
      executorHasGitSecrets: false,
      executorHasCodexSecretsAtLaunch: true,
      executorScrubsCodexSecretsAfterLaunch: true
    },
    logsPreview: {
      stdout: stdoutPreview,
      stderr: stderrPreview
    }
  }
});
