import { env } from "../config/env";
import {
  getLatestPromptExecution,
  listPromptExecutionsForObservation,
  updatePromptExecution,
  type PromptExecution,
  type PromptExecutionStatus
} from "../repositories/prompt-execution-repository";
import { getPrompt, updatePrompt, type Prompt } from "../repositories/prompt-repository";
import {
  createKubePromptJobService,
  type KubePromptJobService
} from "./kube-prompt-jobs";
import { buildPromptWorkerMetadataPatch } from "./prompt-worker-metadata";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown) =>
  typeof value === "string" && value.trim().length ? value.trim() : null;

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const trimLogTail = (value: string | null, maxLines = 8, maxChars = 1600) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/).slice(-maxLines);
  const joined = lines.join("\n");

  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
};

const unwrapKubeBody = (value: unknown) => {
  if (isRecord(value) && isRecord(value.body)) {
    return value.body;
  }

  return isRecord(value) ? value : null;
};

const selectLatestPod = (pods: unknown[]) => {
  const normalizedPods = pods
    .map((pod) => unwrapKubeBody(pod))
    .filter((pod): pod is Record<string, unknown> => Boolean(pod));

  normalizedPods.sort((left, right) => {
    const leftTimestamp = Date.parse(
      readString(unwrapKubeBody(left)?.metadata && (unwrapKubeBody(left)?.metadata as Record<string, unknown>).creationTimestamp) ||
        ""
    );
    const rightTimestamp = Date.parse(
      readString(unwrapKubeBody(right)?.metadata && (unwrapKubeBody(right)?.metadata as Record<string, unknown>).creationTimestamp) ||
        ""
    );

    return rightTimestamp - leftTimestamp;
  });

  return normalizedPods[0] || null;
};

const getPodInfo = (pod: Record<string, unknown> | null) => {
  if (!pod) {
    return {
      podName: null,
      namespace: null,
      phase: null,
      workerNode: null,
      failureMessage: null
    };
  }

  const metadata = isRecord(pod.metadata) ? pod.metadata : null;
  const spec = isRecord(pod.spec) ? pod.spec : null;
  const status = isRecord(pod.status) ? pod.status : null;
  const containerStatuses = Array.isArray(status?.containerStatuses)
    ? status.containerStatuses.filter(isRecord)
    : [];

  const terminatedState = containerStatuses
    .map((entry) => (isRecord(entry.state) ? entry.state : null))
    .map((state) => (state && isRecord(state.terminated) ? state.terminated : null))
    .find(Boolean);
  const waitingState = containerStatuses
    .map((entry) => (isRecord(entry.state) ? entry.state : null))
    .map((state) => (state && isRecord(state.waiting) ? state.waiting : null))
    .find(Boolean);

  const failureMessage =
    readString(terminatedState?.message) ||
    readString(terminatedState?.reason) ||
    (readNumber(terminatedState?.exitCode) && readNumber(terminatedState?.exitCode) !== 0
      ? `Worker container exited with code ${readNumber(terminatedState?.exitCode)}.`
      : null) ||
    readString(waitingState?.message) ||
    readString(waitingState?.reason) ||
    null;

  return {
    podName: readString(metadata?.name),
    namespace: readString(metadata?.namespace),
    phase: readString(status?.phase),
    workerNode: readString(spec?.nodeName),
    failureMessage
  };
};

const getJobFailureMessage = (job: Record<string, unknown> | null) => {
  if (!job) {
    return null;
  }

  const status = isRecord(job.status) ? job.status : null;
  const failed = readNumber(status?.failed) || 0;
  const conditions = Array.isArray(status?.conditions)
    ? status.conditions.filter(isRecord)
    : [];
  const failedCondition = conditions.find(
    (condition) =>
      readString(condition.type) === "Failed" &&
      (readString(condition.status) === "True" || readString(condition.status) === "true")
  );

  if (!failedCondition && failed < 1) {
    return null;
  }

  return (
    readString(failedCondition?.message) ||
    readString(failedCondition?.reason) ||
    `Kubernetes Job ${readString(job.metadata && (job.metadata as Record<string, unknown>).name) || "prompt-worker"} failed.`
  );
};

const readPublisherImage = (prompt: Prompt | null) => {
  if (!prompt || !isRecord(prompt.metadata.worker)) {
    return null;
  }

  const worker = prompt.metadata.worker as Record<string, unknown>;
  const images = isRecord(worker.images) ? worker.images : null;

  return readString(images?.publisher);
};

const buildObservedMetadataPatch = ({
  execution,
  prompt,
  podName,
  namespace,
  stdoutPreview,
  stderrPreview
}: {
  execution: PromptExecution;
  prompt: Prompt | null;
  podName: string | null;
  namespace: string | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
}) =>
  buildPromptWorkerMetadataPatch({
    attempt: execution.attempt,
    phase: execution.status,
    jobName: execution.jobName,
    podName,
    namespace,
    executorImage: execution.image,
    publisherImage: readPublisherImage(prompt),
    stdoutPreview,
    stderrPreview
  });

const updateExecutionObservation = async ({
  execution,
  podName,
  namespace,
  workerNode,
  podPhase,
  logTail,
  failureMessage,
  updateExecutionRecord
}: {
  execution: PromptExecution;
  podName: string | null;
  namespace: string | null;
  workerNode: string | null;
  podPhase: string | null;
  logTail: string | null;
  failureMessage: string | null;
  updateExecutionRecord: typeof updatePromptExecution;
}) => {
  const currentObserver = isRecord(execution.metadata.observer)
    ? (execution.metadata.observer as Record<string, unknown>)
    : null;
  const currentLogTail = readString(currentObserver?.executorLogTail);
  const currentPodPhase = readString(currentObserver?.podPhase);

  const statusPatch: Partial<{
    status: PromptExecutionStatus;
    errorMessage: string | null;
    setFinishedAt: boolean;
  }> = {};

  if (failureMessage && execution.status !== "failed") {
    statusPatch.status = "failed";
    statusPatch.errorMessage = failureMessage;
    statusPatch.setFinishedAt = true;
  }

  if (
    podName === execution.podName &&
    namespace === execution.namespace &&
    workerNode === execution.workerNode &&
    currentPodPhase === podPhase &&
    currentLogTail === logTail &&
    !statusPatch.status
  ) {
    return execution;
  }

  return updateExecutionRecord(execution.id, {
    jobName: execution.jobName,
    podName,
    namespace,
    workerNode,
    ...(statusPatch.status ? statusPatch : {}),
    metadata: {
      observer: {
        observedAt: new Date().toISOString(),
        podPhase,
        executorLogTail: logTail
      }
    }
  });
};

const syncPromptObservation = async ({
  prompt,
  execution,
  podName,
  namespace,
  logTail,
  failureMessage,
  updatePromptRecord
}: {
  prompt: Prompt | null;
  execution: PromptExecution;
  podName: string | null;
  namespace: string | null;
  logTail: string | null;
  failureMessage: string | null;
  updatePromptRecord: typeof updatePrompt;
}) => {
  if (!prompt) {
    return;
  }

  if (prompt.status === "queued" && execution.finishedAt) {
    return;
  }

  const workerPatch = buildObservedMetadataPatch({
    execution,
    prompt,
    podName,
    namespace,
    stdoutPreview: logTail,
    stderrPreview: failureMessage || null
  });
  const currentWorker = isRecord(prompt.metadata.worker)
    ? prompt.metadata.worker
    : null;

  const nextWorker = workerPatch.worker;
  const workerChanged = JSON.stringify(currentWorker || null) !== JSON.stringify(nextWorker);
  const promptNeedsFailure =
    Boolean(failureMessage) &&
    prompt.status !== "queued" &&
    prompt.status !== "failed" &&
    prompt.status !== "completed" &&
    prompt.status !== "cancelled";

  if (!workerChanged && !promptNeedsFailure) {
    return;
  }

  await updatePromptRecord(prompt.id, {
    ...(promptNeedsFailure
      ? {
          status: "failed" as const,
          setFinishedAt: true,
          errorMessage: failureMessage,
          metadataPatch: {
            ...workerPatch,
            failure: {
              stage: "worker_job_failed",
              message: failureMessage,
              capturedAt: new Date().toISOString()
            }
          }
        }
      : {
          metadataPatch: workerPatch
        })
  });
};

export const reconcileKubePromptExecutions = async ({
  jobService = createKubePromptJobService({
    runtimeLayout: env.promptRunnerKubeRuntimeLayout
  }),
  executions,
  getLatestExecution = getLatestPromptExecution,
  getPromptById = getPrompt,
  updateExecutionRecord = updatePromptExecution,
  updatePromptRecord = updatePrompt
}: {
  jobService?: KubePromptJobService;
  executions?: PromptExecution[];
  getLatestExecution?: typeof getLatestPromptExecution;
  getPromptById?: typeof getPrompt;
  updateExecutionRecord?: typeof updatePromptExecution;
  updatePromptRecord?: typeof updatePrompt;
} = {}) => {
  const candidates = executions || (await listPromptExecutionsForObservation());

  for (const candidate of candidates) {
    const latestAttempt = await getLatestExecution(candidate.promptId);

    if (!latestAttempt || latestAttempt.id !== candidate.id || !candidate.jobName) {
      continue;
    }

    const namespace = candidate.namespace || env.promptRunnerKubeNamespace;
    const prompt = await getPromptById(candidate.promptId);

    let jobRecord: Record<string, unknown> | null = null;
    let podRecord: Record<string, unknown> | null = null;
    let logTail: string | null = null;

    try {
      jobRecord = unwrapKubeBody(await jobService.getJob(namespace, candidate.jobName));
    } catch {
      jobRecord = null;
    }

    try {
      podRecord = selectLatestPod(await jobService.listPromptPods(namespace, candidate.jobName));
    } catch {
      podRecord = null;
    }

    const podInfo = getPodInfo(podRecord);

    if (podInfo.podName) {
      try {
        logTail = trimLogTail(
          await jobService.getPodLogs(namespace, podInfo.podName, "codex-executor")
        );
      } catch {
        logTail = null;
      }
    }

    const failureMessage = getJobFailureMessage(jobRecord) || podInfo.failureMessage;
    const updatedExecution = await updateExecutionObservation({
      execution: candidate,
      podName: podInfo.podName,
      namespace,
      workerNode: podInfo.workerNode,
      podPhase: podInfo.phase,
      logTail,
      failureMessage,
      updateExecutionRecord
    });

    await syncPromptObservation({
      prompt,
      execution: updatedExecution,
      podName: podInfo.podName,
      namespace,
      logTail,
      failureMessage,
      updatePromptRecord
    });
  }
};
