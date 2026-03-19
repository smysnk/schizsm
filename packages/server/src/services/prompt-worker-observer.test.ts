import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromptExecution,
  PromptExecutionStatus
} from "../repositories/prompt-execution-repository";
import type { Prompt } from "../repositories/prompt-repository";
import { reconcileKubePromptExecutions } from "./prompt-worker-observer";

const createPromptExecution = (
  overrides: Partial<PromptExecution> = {}
): PromptExecution => ({
  id: "execution-1",
  promptId: "prompt-1",
  attempt: 1,
  status: "running",
  executionMode: "kube-worker",
  jobName: "schizm-prompt-prompt1-1",
  podName: null,
  namespace: "schizm",
  image: "executor:latest",
  workerNode: null,
  startedAt: "2026-03-19T12:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  errorMessage: null,
  metadata: {},
  createdAt: "2026-03-19T12:00:00.000Z",
  updatedAt: "2026-03-19T12:00:00.000Z",
  ...overrides
});

const createPrompt = (overrides: Partial<Prompt> = {}): Prompt => ({
  id: "prompt-1",
  content: "Track this prompt worker.",
  status: "writing",
  metadata: {
    worker: {
      executionMode: "kube-worker",
      hardened: true,
      isolatedSecretHandling: true,
      attempt: 1,
      phase: "running",
      jobName: "schizm-prompt-prompt1-1",
      podName: null,
      namespace: "schizm",
      images: {
        executor: "executor:latest",
        publisher: "publisher:latest"
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
    }
  },
  audit: {},
  startedAt: "2026-03-19T12:00:00.000Z",
  finishedAt: null,
  errorMessage: null,
  createdAt: "2026-03-19T11:59:58.000Z",
  updatedAt: "2026-03-19T12:00:00.000Z",
  ...overrides
});

test("reconcileKubePromptExecutions records pod context and recent logs", async () => {
  const execution = createPromptExecution();
  const prompt = createPrompt();
  const updatedExecutions: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const updatedPrompts: Array<{ id: string; patch: Record<string, unknown> }> = [];

  await reconcileKubePromptExecutions({
    executions: [execution],
    getLatestExecution: async () => execution,
    getPromptById: async () => prompt,
    updateExecutionRecord: async (id, patch) => {
      updatedExecutions.push({ id, patch });
      return {
        ...execution,
        podName: (patch.podName as string | null | undefined) ?? execution.podName,
        namespace: (patch.namespace as string | null | undefined) ?? execution.namespace,
        workerNode: (patch.workerNode as string | null | undefined) ?? execution.workerNode,
        status: (patch.status as PromptExecutionStatus | undefined) ?? execution.status,
        errorMessage:
          (patch.errorMessage as string | null | undefined) ?? execution.errorMessage,
        metadata: {
          ...execution.metadata,
          ...(patch.metadata as Record<string, unknown> | undefined)
        }
      };
    },
    updatePromptRecord: async (id, patch) => {
      updatedPrompts.push({ id, patch: patch as Record<string, unknown> });
      return prompt;
    },
    jobService: {
      buildJobSpec: () => {
        throw new Error("not used");
      },
      createJob: async () => {
        throw new Error("not used");
      },
      getJob: async () => ({
        metadata: { name: execution.jobName },
        status: { succeeded: 0 }
      }),
      listPromptPods: async () => [
        {
          metadata: {
            name: "schizm-prompt-prompt1-1-v7wx8",
            namespace: "schizm",
            creationTimestamp: "2026-03-19T12:00:05.000Z"
          },
          spec: {
            nodeName: "worker-node-a"
          },
          status: {
            phase: "Running"
          }
        }
      ],
      getPodLogs: async () => "cloning repo\nlaunching codex\nwaiting for output",
      deleteJob: async () => undefined
    }
  });

  assert.equal(updatedExecutions.length, 1);
  assert.equal(updatedExecutions[0]?.patch.podName, "schizm-prompt-prompt1-1-v7wx8");
  assert.equal(updatedExecutions[0]?.patch.workerNode, "worker-node-a");
  assert.equal(
    (updatedExecutions[0]?.patch.metadata as Record<string, unknown>).observer &&
      ((updatedExecutions[0]?.patch.metadata as Record<string, unknown>).observer as Record<
        string,
        unknown
      >).executorLogTail,
    "cloning repo\nlaunching codex\nwaiting for output"
  );

  assert.equal(updatedPrompts.length, 1);
  const metadataPatch = updatedPrompts[0]?.patch.metadataPatch as Record<string, unknown>;
  const worker = metadataPatch.worker as Record<string, unknown>;
  const logsPreview = worker.logsPreview as Record<string, unknown>;

  assert.equal(worker.jobName, execution.jobName);
  assert.equal(worker.podName, "schizm-prompt-prompt1-1-v7wx8");
  assert.equal(logsPreview.stdout, "cloning repo\nlaunching codex\nwaiting for output");
});

test("reconcileKubePromptExecutions marks the prompt failed when the worker job fails", async () => {
  const execution = createPromptExecution();
  const prompt = createPrompt();
  const updatedExecutions: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const updatedPrompts: Array<{ id: string; patch: Record<string, unknown> }> = [];

  await reconcileKubePromptExecutions({
    executions: [execution],
    getLatestExecution: async () => execution,
    getPromptById: async () => prompt,
    updateExecutionRecord: async (id, patch) => {
      updatedExecutions.push({ id, patch });
      return {
        ...execution,
        status: (patch.status as PromptExecutionStatus | undefined) ?? execution.status,
        errorMessage:
          (patch.errorMessage as string | null | undefined) ?? execution.errorMessage,
        metadata: {
          ...execution.metadata,
          ...(patch.metadata as Record<string, unknown> | undefined)
        }
      };
    },
    updatePromptRecord: async (id, patch) => {
      updatedPrompts.push({ id, patch: patch as Record<string, unknown> });
      return prompt;
    },
    jobService: {
      buildJobSpec: () => {
        throw new Error("not used");
      },
      createJob: async () => {
        throw new Error("not used");
      },
      getJob: async () => ({
        metadata: { name: execution.jobName },
        status: {
          failed: 1,
          conditions: [
            {
              type: "Failed",
              status: "True",
              message: "ImagePullBackOff"
            }
          ]
        }
      }),
      listPromptPods: async () => [],
      getPodLogs: async () => "",
      deleteJob: async () => undefined
    }
  });

  assert.equal(updatedExecutions.length, 1);
  assert.equal(updatedExecutions[0]?.patch.status, "failed");
  assert.equal(updatedExecutions[0]?.patch.errorMessage, "ImagePullBackOff");

  assert.equal(updatedPrompts.length, 1);
  assert.equal(updatedPrompts[0]?.patch.status, "failed");
  assert.equal(updatedPrompts[0]?.patch.errorMessage, "ImagePullBackOff");
  const metadataPatch = updatedPrompts[0]?.patch.metadataPatch as Record<string, unknown>;
  const failure = metadataPatch.failure as Record<string, unknown>;
  assert.equal(failure.stage, "worker_job_failed");
  assert.equal(failure.message, "ImagePullBackOff");
});
