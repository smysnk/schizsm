import { getPrompt, updatePrompt } from "../repositories/prompt-repository";
import {
  getPromptExecutionByPromptAndAttempt,
  updatePromptExecution
} from "../repositories/prompt-execution-repository";
import { buildPromptWorkerMetadataPatch } from "../services/prompt-worker-metadata";
import { pool } from "../db/pool";
import { parsePromptWorkerEnvironment } from "./contract";
import {
  configureWorkerCodexAuth,
  configureWorkerSsh,
  prepareWorkerRuntimePaths,
  syncWorkerDocumentStoreRepo
} from "./bootstrap";

const parseRoleArg = (argv: string[]) => {
  const roleArg = argv.find((value) => value.startsWith("--role="));

  if (!roleArg) {
    return null;
  }

  return roleArg.slice("--role=".length);
};

const resolveWorkerIdentity = () => ({
  podName: process.env.WORKER_POD_NAME || process.env.HOSTNAME || null,
  namespace: process.env.WORKER_POD_NAMESPACE || null,
  workerNode: process.env.WORKER_NODE_NAME || null,
  image: process.env.PROMPT_WORKER_IMAGE || process.env.SCHIZM_IMAGE || null
});

const updatePromptWorkerPhase = async ({
  promptId,
  attempt,
  phase,
  podName,
  namespace,
  executorImage,
  publisherImage,
  stderrPreview = null
}: {
  promptId: string;
  attempt: number;
  phase: "bootstrapping" | "running" | "completed" | "failed";
  podName: string | null;
  namespace: string | null;
  executorImage: string | null;
  publisherImage: string | null;
  stderrPreview?: string | null;
}) =>
  updatePrompt(promptId, {
    metadataPatch: buildPromptWorkerMetadataPatch({
      attempt,
      phase,
      jobName: process.env.PROMPT_JOB_NAME || null,
      podName,
      namespace,
      executorImage,
      publisherImage,
      stderrPreview
    })
  });

const main = async () => {
  if (!process.env.WORKER_ROLE) {
    const roleFromArg = parseRoleArg(process.argv.slice(2));

    if (roleFromArg) {
      process.env.WORKER_ROLE = roleFromArg;
    }
  }

  const contract = parsePromptWorkerEnvironment(process.env);
  const summary = {
    role: contract.role,
    promptId: contract.promptId,
    promptAttempt: contract.promptAttempt,
    promptJobName: contract.promptJobName,
    executionMode: contract.executionMode,
    workspaceDir: contract.workspaceDir,
    runtimeDir: contract.runtimeDir
  };

  if (process.env.WORKER_CONTRACT_VALIDATE_ONLY === "1") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (contract.role !== "codex-executor") {
    throw new Error(
      `Worker role ${contract.role} is not active in Phase 3. Use PROMPT_RUNNER_KUBE_RUNTIME_LAYOUT=single-container.`
    );
  }

  const identity = resolveWorkerIdentity();
  const execution = await getPromptExecutionByPromptAndAttempt({
    promptId: contract.promptId,
    attempt: contract.promptAttempt
  });

  if (!execution) {
    throw new Error(
      `Prompt execution attempt ${contract.promptAttempt} for ${contract.promptId} was not found.`
    );
  }

  const publisherImage =
    process.env.PROMPT_RUNNER_KUBE_RUNTIME_LAYOUT === "isolated"
      ? process.env.PROMPT_RUNNER_KUBE_GIT_HELPER_IMAGE || null
      : identity.image;

  try {
    await updatePromptExecution(execution.id, {
      status: "bootstrapping",
      jobName: contract.promptJobName,
      podName: identity.podName,
      namespace: identity.namespace,
      image: identity.image,
      workerNode: identity.workerNode,
      setStartedAt: true
    });

    await updatePromptWorkerPhase({
      promptId: contract.promptId,
      attempt: execution.attempt,
      phase: "bootstrapping",
      podName: identity.podName,
      namespace: identity.namespace,
      executorImage: identity.image,
      publisherImage
    });

    await prepareWorkerRuntimePaths(contract);
    await configureWorkerSsh(contract);
    await configureWorkerCodexAuth(contract);
    const repo = await syncWorkerDocumentStoreRepo(contract);

    await updatePromptExecution(execution.id, {
      status: "running",
      jobName: contract.promptJobName,
      podName: identity.podName,
      namespace: identity.namespace,
      image: identity.image,
      workerNode: identity.workerNode,
      metadata: {
        worker: {
          role: contract.role,
          repoRoot: repo.repoRoot,
          repoUrl: repo.repoUrl,
          branch: repo.branch
        }
      }
    });

    await updatePromptWorkerPhase({
      promptId: contract.promptId,
      attempt: execution.attempt,
      phase: "running",
      podName: identity.podName,
      namespace: identity.namespace,
      executorImage: identity.image,
      publisherImage
    });

    const { PromptRunner } = await import("../services/prompt-runner");
    const promptRunner = new PromptRunner();
    await promptRunner.runPromptById(contract.promptId);

    const prompt = await getPrompt(contract.promptId);

    if (!prompt) {
      throw new Error(`Prompt ${contract.promptId} disappeared during worker execution.`);
    }

    const succeeded = prompt.status === "completed";

    await updatePromptExecution(execution.id, {
      status: succeeded ? "completed" : "failed",
      jobName: contract.promptJobName,
      podName: identity.podName,
      namespace: identity.namespace,
      image: identity.image,
      workerNode: identity.workerNode,
      errorMessage: succeeded ? null : prompt.errorMessage,
      setFinishedAt: true,
      metadata: {
        worker: {
          role: contract.role,
          finalPromptStatus: prompt.status
        }
      }
    });

    await updatePromptWorkerPhase({
      promptId: contract.promptId,
      attempt: execution.attempt,
      phase: succeeded ? "completed" : "failed",
      podName: identity.podName,
      namespace: identity.namespace,
      executorImage: identity.image,
      publisherImage,
      stderrPreview: succeeded ? null : prompt.errorMessage
    });

    if (!succeeded) {
      throw new Error(prompt.errorMessage || "Prompt execution failed inside the worker pod.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt worker failed.";

    await updatePromptExecution(execution.id, {
      status: "failed",
      jobName: contract.promptJobName,
      podName: identity.podName,
      namespace: identity.namespace,
      image: identity.image,
      workerNode: identity.workerNode,
      errorMessage: message,
      setFinishedAt: true
    }).catch(() => undefined);

    await updatePromptWorkerPhase({
      promptId: contract.promptId,
      attempt: execution.attempt,
      phase: "failed",
      podName: identity.podName,
      namespace: identity.namespace,
      executorImage: identity.image,
      publisherImage,
      stderrPreview: message
    }).catch(() => undefined);

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

void main();
