import {
  promptWorkerContainerRoles,
  promptWorkerRuntimeDir,
  promptWorkerSecretPaths,
  promptWorkerWorkspaceDir,
  type PromptWorkerContainerRole
} from "../services/kube-prompt-jobs";

export const promptWorkerExecutionModes = ["kube-worker"] as const;
export type PromptWorkerExecutionMode = (typeof promptWorkerExecutionModes)[number];

export type PromptWorkerContract = {
  role: PromptWorkerContainerRole;
  promptId: string;
  promptAttempt: number;
  promptJobName: string;
  promptDispatchedBySession: string;
  executionMode: PromptWorkerExecutionMode;
  workspaceDir: string;
  runtimeDir: string;
  secretPaths: typeof promptWorkerSecretPaths;
};

const parsePositiveInteger = (value: string | undefined, field: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }

  return parsed;
};

const parseRole = (value: string | undefined): PromptWorkerContainerRole => {
  if (!value || !promptWorkerContainerRoles.includes(value as PromptWorkerContainerRole)) {
    throw new Error(
      `WORKER_ROLE must be one of: ${promptWorkerContainerRoles.join(", ")}.`
    );
  }

  return value as PromptWorkerContainerRole;
};

export const parsePromptWorkerEnvironment = (
  source: NodeJS.ProcessEnv
): PromptWorkerContract => {
  const promptId = source.PROMPT_ID?.trim();
  const promptJobName = source.PROMPT_JOB_NAME?.trim();
  const promptDispatchedBySession = source.PROMPT_DISPATCHED_BY_SESSION?.trim();
  const executionMode = source.PROMPT_RUNNER_EXECUTION_MODE?.trim();

  if (!promptId) {
    throw new Error("PROMPT_ID is required.");
  }

  if (!promptJobName) {
    throw new Error("PROMPT_JOB_NAME is required.");
  }

  if (!promptDispatchedBySession) {
    throw new Error("PROMPT_DISPATCHED_BY_SESSION is required.");
  }

  if (executionMode !== "kube-worker") {
    throw new Error("PROMPT_RUNNER_EXECUTION_MODE must be kube-worker.");
  }

  return {
    role: parseRole(source.WORKER_ROLE),
    promptId,
    promptAttempt: parsePositiveInteger(source.PROMPT_ATTEMPT, "PROMPT_ATTEMPT"),
    promptJobName,
    promptDispatchedBySession,
    executionMode,
    workspaceDir: source.PROMPT_WORKSPACE_DIR?.trim() || promptWorkerWorkspaceDir,
    runtimeDir: source.PROMPT_RUNTIME_DIR?.trim() || promptWorkerRuntimeDir,
    secretPaths: promptWorkerSecretPaths
  };
};

export const getPromptWorkerAllowedSecretKinds = (role: PromptWorkerContainerRole) => {
  switch (role) {
    case "repo-bootstrap":
      return ["git"] as const;
    case "codex-executor":
      return ["codex", "database"] as const;
    case "repo-publisher":
      return ["git", "database"] as const;
  }
};
