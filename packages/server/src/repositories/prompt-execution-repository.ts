import { query, withTransaction } from "../db/pool";
import { publishPromptWorkspaceEvent } from "../services/prompt-workspace-events";
import type { JsonObject } from "./prompt-repository";

export const promptExecutionStatuses = [
  "dispatched",
  "bootstrapping",
  "running",
  "publishing",
  "completed",
  "failed",
  "cancelled"
] as const;

export type PromptExecutionStatus = (typeof promptExecutionStatuses)[number];

export type PromptExecutionMode =
  | "kube-worker"
  | "container"
  | "worktree"
  | "unknown";

export type PromptExecution = {
  id: string;
  promptId: string;
  attempt: number;
  status: PromptExecutionStatus;
  executionMode: PromptExecutionMode;
  jobName: string | null;
  podName: string | null;
  namespace: string | null;
  image: string | null;
  workerNode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
};

type PromptExecutionRow = {
  id: string;
  prompt_id: string;
  attempt: number;
  status: PromptExecutionStatus;
  execution_mode: PromptExecutionMode;
  job_name: string | null;
  pod_name: string | null;
  namespace: string | null;
  image: string | null;
  worker_node: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  exit_code: number | null;
  error_message: string | null;
  metadata: JsonObject | null;
  created_at: Date;
  updated_at: Date;
};

type PromptExecutionUpdate = {
  status?: PromptExecutionStatus;
  jobName?: string | null;
  podName?: string | null;
  namespace?: string | null;
  image?: string | null;
  workerNode?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  metadata?: JsonObject;
  setStartedAt?: boolean;
  setFinishedAt?: boolean;
};

const promptExecutionSelection = `
  id,
  prompt_id,
  attempt,
  status,
  execution_mode,
  job_name,
  pod_name,
  namespace,
  image,
  worker_node,
  started_at,
  finished_at,
  exit_code,
  error_message,
  metadata,
  created_at,
  updated_at
`;

const isJsonObject = (value: JsonObject | undefined): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const mergeJsonObject = (current: JsonObject, patch?: JsonObject): JsonObject => {
  if (!patch) {
    return current;
  }

  const result: JsonObject = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    const currentValue = result[key];

    if (isJsonObject(currentValue as JsonObject | undefined) && isJsonObject(value as JsonObject)) {
      result[key] = mergeJsonObject(currentValue as JsonObject, value as JsonObject);
      continue;
    }

    result[key] = value;
  }

  return result;
};

const toPromptExecution = (row: PromptExecutionRow): PromptExecution => ({
  id: row.id,
  promptId: row.prompt_id,
  attempt: row.attempt,
  status: row.status,
  executionMode: row.execution_mode,
  jobName: row.job_name,
  podName: row.pod_name,
  namespace: row.namespace,
  image: row.image,
  workerNode: row.worker_node,
  startedAt: row.started_at ? row.started_at.toISOString() : null,
  finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  exitCode: row.exit_code,
  errorMessage: row.error_message,
  metadata: row.metadata || {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

export const createPromptExecution = async ({
  promptId,
  executionMode = "kube-worker",
  status = "dispatched",
  metadata = {},
  jobName = null,
  podName = null,
  namespace = null,
  image = null
}: {
  promptId: string;
  executionMode?: PromptExecutionMode;
  status?: PromptExecutionStatus;
  metadata?: JsonObject;
  jobName?: string | null;
  podName?: string | null;
  namespace?: string | null;
  image?: string | null;
}): Promise<PromptExecution> =>
  withTransaction(async (client) => {
    const nextAttemptResult = await client.query<{ attempt: number }>(
      `
        SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
        FROM prompt_executions
        WHERE prompt_id = $1
      `,
      [promptId]
    );

    const attempt = Number(nextAttemptResult.rows[0]?.attempt ?? 1);

    const result = await client.query<PromptExecutionRow>(
      `
        INSERT INTO prompt_executions (
          prompt_id,
          attempt,
          status,
          execution_mode,
          job_name,
          pod_name,
          namespace,
          image,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING ${promptExecutionSelection}
      `,
      [
        promptId,
        attempt,
        status,
        executionMode,
        jobName,
        podName,
        namespace,
        image,
        JSON.stringify(metadata)
      ]
    );

    const execution = toPromptExecution(result.rows[0]);
    publishPromptWorkspaceEvent({
      promptId,
      reason: `Prompt execution attempt ${execution.attempt} created.`,
      scope: "prompt"
    });
    return execution;
  });

export const getLatestPromptExecution = async (
  promptId: string
): Promise<PromptExecution | null> => {
  const result = await query<PromptExecutionRow>(
    `
      SELECT ${promptExecutionSelection}
      FROM prompt_executions
      WHERE prompt_id = $1
      ORDER BY attempt DESC
      LIMIT 1
    `,
    [promptId]
  );

  if (!result.rowCount) {
    return null;
  }

  return toPromptExecution(result.rows[0]);
};

export const getPromptExecutionByPromptAndAttempt = async ({
  promptId,
  attempt
}: {
  promptId: string;
  attempt: number;
}): Promise<PromptExecution | null> => {
  const result = await query<PromptExecutionRow>(
    `
      SELECT ${promptExecutionSelection}
      FROM prompt_executions
      WHERE prompt_id = $1
        AND attempt = $2
      LIMIT 1
    `,
    [promptId, attempt]
  );

  if (!result.rowCount) {
    return null;
  }

  return toPromptExecution(result.rows[0]);
};

export const listPromptExecutions = async (promptId: string): Promise<PromptExecution[]> => {
  const result = await query<PromptExecutionRow>(
    `
      SELECT ${promptExecutionSelection}
      FROM prompt_executions
      WHERE prompt_id = $1
      ORDER BY attempt DESC
    `,
    [promptId]
  );

  return result.rows.map(toPromptExecution);
};

export const listPromptExecutionsForObservation = async ({
  activeStatuses = ["dispatched", "bootstrapping", "running", "publishing"],
  recentTerminalStatuses = ["completed", "failed"],
  recentWindowSeconds = 600,
  limit = 50
}: {
  activeStatuses?: PromptExecutionStatus[];
  recentTerminalStatuses?: PromptExecutionStatus[];
  recentWindowSeconds?: number;
  limit?: number;
} = {}): Promise<PromptExecution[]> => {
  const result = await query<PromptExecutionRow>(
    `
      SELECT ${promptExecutionSelection}
      FROM prompt_executions
      WHERE execution_mode = 'kube-worker'
        AND (
          status = ANY($1::text[])
          OR (
            status = ANY($2::text[])
            AND updated_at >= NOW() - ($3::int * INTERVAL '1 second')
          )
        )
      ORDER BY updated_at DESC
      LIMIT $4
    `,
    [activeStatuses, recentTerminalStatuses, recentWindowSeconds, limit]
  );

  return result.rows.map(toPromptExecution);
};

export const updatePromptExecution = async (
  id: string,
  update: PromptExecutionUpdate
): Promise<PromptExecution> => {
  const currentResult = await query<PromptExecutionRow>(
    `
      SELECT ${promptExecutionSelection}
      FROM prompt_executions
      WHERE id = $1
    `,
    [id]
  );

  if (!currentResult.rowCount) {
    throw new Error(`Prompt execution ${id} not found.`);
  }

  const current = currentResult.rows[0];
  const mergedMetadata = mergeJsonObject(current.metadata || {}, update.metadata);

  const result = await query<PromptExecutionRow>(
    `
      UPDATE prompt_executions
      SET status = COALESCE($2, status),
          job_name = COALESCE($3, job_name),
          pod_name = COALESCE($4, pod_name),
          namespace = COALESCE($5, namespace),
          image = COALESCE($6, image),
          worker_node = COALESCE($7, worker_node),
          exit_code = CASE WHEN $8::int IS NULL THEN exit_code ELSE $8 END,
          error_message = CASE WHEN $9::text IS NULL THEN error_message ELSE $9 END,
          metadata = $10::jsonb,
          started_at = CASE WHEN $11::boolean THEN COALESCE(started_at, NOW()) ELSE started_at END,
          finished_at = CASE WHEN $12::boolean THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${promptExecutionSelection}
    `,
    [
      id,
      update.status ?? null,
      update.jobName ?? null,
      update.podName ?? null,
      update.namespace ?? null,
      update.image ?? null,
      update.workerNode ?? null,
      update.exitCode ?? null,
      update.errorMessage ?? null,
      JSON.stringify(mergedMetadata),
      update.setStartedAt ?? false,
      update.setFinishedAt ?? false
    ]
  );

  const execution = toPromptExecution(result.rows[0]);
  publishPromptWorkspaceEvent({
    promptId: execution.promptId,
    reason: `Prompt execution attempt ${execution.attempt} updated to ${execution.status}.`,
    scope: "prompt"
  });
  return execution;
};
