import { env } from "../config/env";
import {
  createPromptExecution,
  updatePromptExecution,
  type PromptExecution
} from "../repositories/prompt-execution-repository";
import { updatePrompt, type Prompt } from "../repositories/prompt-repository";
import {
  createKubePromptJobService,
  type KubePromptJobService
} from "./kube-prompt-jobs";
import { buildPromptWorkerMetadataPatch } from "./prompt-worker-metadata";

export const buildPromptWorkerJobName = (promptId: string, attempt: number) => {
  const compactPromptId = promptId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase();
  return `schizm-prompt-${compactPromptId}-${attempt}`;
};

export const dispatchPromptToKubeWorker = async ({
  prompt,
  runnerSessionId,
  jobService = createKubePromptJobService({
    runtimeLayout: env.promptRunnerKubeRuntimeLayout
  })
}: {
  prompt: Prompt;
  runnerSessionId: string;
  jobService?: KubePromptJobService;
}): Promise<PromptExecution> => {
  const execution = await createPromptExecution({
    promptId: prompt.id,
    executionMode: "kube-worker",
    status: "dispatched",
    metadata: {
      dispatch: {
        dispatchedAt: new Date().toISOString(),
        runnerSessionId
      }
    }
  });

  const jobName = buildPromptWorkerJobName(prompt.id, execution.attempt);

  try {
    await jobService.createJob({
      namespace: env.promptRunnerKubeNamespace,
      jobName,
      promptId: prompt.id,
      promptAttempt: execution.attempt,
      promptRunnerSessionId: runnerSessionId,
      executorImage: env.promptRunnerKubeExecutorImage,
      gitHelperImage: env.promptRunnerKubeGitHelperImage,
      imagePullPolicy:
        env.promptRunnerKubeImagePullPolicy as "Always" | "IfNotPresent" | "Never",
      runtimeSecretName: env.promptRunnerKubeRuntimeSecretName,
      ttlSecondsAfterFinished: env.promptRunnerKubeJobTtlSeconds,
      backoffLimit: env.promptRunnerKubeBackoffLimit,
      workspaceDir: env.promptRunnerKubeWorkspaceDir,
      runtimeLayout: env.promptRunnerKubeRuntimeLayout
    });

    const updatedExecution = await updatePromptExecution(execution.id, {
      jobName,
      namespace: env.promptRunnerKubeNamespace,
      image: env.promptRunnerKubeExecutorImage || null
    });

    await updatePrompt(prompt.id, {
      metadataPatch: buildPromptWorkerMetadataPatch({
        attempt: updatedExecution.attempt,
        phase: updatedExecution.status,
        jobName,
        namespace: env.promptRunnerKubeNamespace,
        executorImage: env.promptRunnerKubeExecutorImage || null,
        publisherImage:
          env.promptRunnerKubeRuntimeLayout === "isolated"
            ? env.promptRunnerKubeGitHelperImage || null
            : env.promptRunnerKubeExecutorImage || null
      })
    });

    return updatedExecution;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to dispatch prompt worker.";

    await updatePromptExecution(execution.id, {
      status: "failed",
      jobName,
      namespace: env.promptRunnerKubeNamespace,
      image: env.promptRunnerKubeExecutorImage || null,
      errorMessage: message,
      setFinishedAt: true
    });

    await updatePrompt(prompt.id, {
      status: "failed",
      setFinishedAt: true,
      errorMessage: message,
      metadataPatch: {
        failure: {
          stage: "dispatching_job",
          message,
          capturedAt: new Date().toISOString()
        },
        ...buildPromptWorkerMetadataPatch({
          attempt: execution.attempt,
          phase: "failed",
          jobName,
          namespace: env.promptRunnerKubeNamespace,
          executorImage: env.promptRunnerKubeExecutorImage || null,
          publisherImage:
            env.promptRunnerKubeRuntimeLayout === "isolated"
              ? env.promptRunnerKubeGitHelperImage || null
              : env.promptRunnerKubeExecutorImage || null,
          stderrPreview: message
        })
      }
    });

    throw error;
  }
};
