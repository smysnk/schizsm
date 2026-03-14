import { query, withTransaction } from "../db/pool";
import { publishPromptWorkspaceEvent } from "../services/prompt-workspace-events";

export const promptStatuses = [
  "queued",
  "cancelled",
  "scanning",
  "deciding",
  "writing",
  "updating_canvas",
  "auditing",
  "committing",
  "pushing",
  "syncing_audit",
  "completed",
  "failed"
] as const;

export type PromptStatus = (typeof promptStatuses)[number];

export const activePromptStatuses = [
  "scanning",
  "deciding",
  "writing",
  "updating_canvas",
  "auditing",
  "committing",
  "pushing",
  "syncing_audit"
] as const satisfies readonly PromptStatus[];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

type PromptUpdate = {
  status?: PromptStatus;
  metadataPatch?: JsonObject;
  auditPatch?: JsonObject;
  replaceAudit?: JsonObject;
  errorMessage?: string | null;
  setStartedAt?: boolean;
  setFinishedAt?: boolean;
  clearStartedAt?: boolean;
  clearFinishedAt?: boolean;
};

export type Prompt = {
  id: string;
  content: string;
  status: PromptStatus;
  metadata: JsonObject;
  audit: JsonObject;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type PromptRow = {
  id: string;
  content: string;
  status: PromptStatus;
  metadata: JsonObject | null;
  audit: JsonObject | null;
  started_at: Date | null;
  finished_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

const promptSelection = `
  id,
  content,
  status,
  metadata,
  audit,
  started_at,
  finished_at,
  error_message,
  created_at,
  updated_at
`;

const clampPromptLimit = (limit?: number | null) => {
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.min(100, Math.max(1, Math.floor(limit as number)));
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const mergeJsonObject = (current: JsonObject, patch?: JsonObject): JsonObject => {
  if (!patch) {
    return current;
  }

  const result: JsonObject = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    const currentValue = result[key];

    if (isJsonObject(currentValue) && isJsonObject(value)) {
      result[key] = mergeJsonObject(currentValue, value);
      continue;
    }

    result[key] = value;
  }

  return result;
};

const toPrompt = (row: PromptRow): Prompt => ({
  id: row.id,
  content: row.content,
  status: row.status,
  metadata: row.metadata || {},
  audit: row.audit || {},
  startedAt: row.started_at ? row.started_at.toISOString() : null,
  finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  errorMessage: row.error_message,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const normalizePromptContent = (content: string) => {
  const normalized = content.trim();

  if (!normalized) {
    throw new Error("Prompt content is required");
  }

  return normalized;
};

export const createPrompt = async (content: string): Promise<Prompt> => {
  const normalizedContent = normalizePromptContent(content);
  const result = await query<PromptRow>(
    `
      INSERT INTO prompts (content, status)
      VALUES ($1, 'queued')
      RETURNING ${promptSelection}
    `,
    [normalizedContent]
  );

  const prompt = toPrompt(result.rows[0]);
  publishPromptWorkspaceEvent({
    promptId: prompt.id,
    reason: "Prompt created and queued.",
    scope: "prompt"
  });
  return prompt;
};

const assertPromptStatus = (
  prompt: Prompt,
  allowedStatuses: PromptStatus[],
  actionLabel: string
) => {
  if (!allowedStatuses.includes(prompt.status)) {
    throw new Error(
      `${actionLabel} is only allowed for ${allowedStatuses.join(", ")} prompts. Current status: ${prompt.status}.`
    );
  }
};

export const getPrompt = async (id: string): Promise<Prompt | null> => {
  const result = await query<PromptRow>(
    `
      SELECT ${promptSelection}
      FROM prompts
      WHERE id = $1
    `,
    [id]
  );

  if (!result.rowCount) {
    return null;
  }

  return toPrompt(result.rows[0]);
};

export const listPrompts = async (limit?: number | null): Promise<Prompt[]> => {
  const result = await query<PromptRow>(
    `
      SELECT ${promptSelection}
      FROM prompts
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [clampPromptLimit(limit)]
  );

  return result.rows.map(toPrompt);
};

export const recoverActivePrompts = async (
  runnerSessionId: string
): Promise<Prompt[]> => {
  const result = await query<PromptRow>(
    `
      SELECT ${promptSelection}
      FROM prompts
      WHERE status = ANY($1::text[])
      ORDER BY COALESCE(started_at, created_at) ASC
    `,
    [activePromptStatuses]
  );

  if (!result.rowCount) {
    return [];
  }

  const recoveredAt = new Date().toISOString();

  return Promise.all(
    result.rows.map((row) =>
      updatePrompt(row.id, {
        status: "failed",
        setFinishedAt: true,
        metadataPatch: {
          recovery: {
            recoveredAt,
            previousStatus: row.status,
            runnerSessionId,
            note: "Recovered interrupted prompt after runner startup."
          }
        },
        errorMessage:
          row.error_message || "Recovered interrupted prompt after runner startup."
      })
    )
  );
};

export const claimNextQueuedPrompt = async (): Promise<Prompt | null> =>
  withTransaction(async (client) => {
    const result = await client.query<PromptRow>(
      `
        WITH next_prompt AS (
          SELECT id
          FROM prompts
          WHERE status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE prompts
        SET status = 'scanning',
            started_at = COALESCE(started_at, NOW()),
            error_message = NULL,
            updated_at = NOW()
        WHERE id IN (SELECT id FROM next_prompt)
        RETURNING ${promptSelection}
      `
    );

    if (!result.rowCount) {
      return null;
    }

    const prompt = toPrompt(result.rows[0]);
    publishPromptWorkspaceEvent({
      promptId: prompt.id,
      reason: "Prompt claimed for processing.",
      scope: "prompt"
    });
    return prompt;
  });

export const updatePrompt = async (
  id: string,
  {
    status,
    metadataPatch,
    auditPatch,
    replaceAudit,
    errorMessage,
    setStartedAt,
    setFinishedAt,
    clearStartedAt,
    clearFinishedAt
  }: PromptUpdate
): Promise<Prompt> => {
  const current = await getPrompt(id);

  if (!current) {
    throw new Error(`Prompt ${id} not found`);
  }

  const nextMetadata = mergeJsonObject(current.metadata, metadataPatch);
  const nextAudit = replaceAudit ? replaceAudit : mergeJsonObject(current.audit, auditPatch);
  const nextStatus = status || current.status;
  const nextErrorMessage =
    errorMessage === undefined ? current.errorMessage : errorMessage;
  const nextStartedAt =
    clearStartedAt
      ? null
      : setStartedAt && !current.startedAt
        ? new Date().toISOString()
        : current.startedAt;
  const nextFinishedAt = clearFinishedAt
    ? null
    : setFinishedAt
      ? new Date().toISOString()
      : current.finishedAt;

  const result = await query<PromptRow>(
    `
      UPDATE prompts
      SET status = $2,
          metadata = $3::jsonb,
          audit = $4::jsonb,
          error_message = $5,
          started_at = $6::timestamptz,
          finished_at = $7::timestamptz,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${promptSelection}
    `,
    [
      id,
      nextStatus,
      JSON.stringify(nextMetadata),
      JSON.stringify(nextAudit),
      nextErrorMessage,
      nextStartedAt,
      nextFinishedAt
    ]
  );

  if (!result.rowCount) {
    throw new Error(`Prompt ${id} not found`);
  }

  const prompt = toPrompt(result.rows[0]);
  publishPromptWorkspaceEvent({
    promptId: prompt.id,
    reason: `Prompt updated to ${prompt.status}.`,
    scope: "prompt"
  });
  return prompt;
};

export const cancelPrompt = async (id: string): Promise<Prompt> => {
  const current = await getPrompt(id);

  if (!current) {
    throw new Error(`Prompt ${id} not found`);
  }

  assertPromptStatus(current, ["queued", "failed"], "Cancelling a prompt");

  return updatePrompt(id, {
    status: "cancelled",
    setFinishedAt: true,
    errorMessage: "Cancelled by operator.",
    metadataPatch: {
      operator: {
        cancelledAt: new Date().toISOString(),
        previousStatus: current.status
      }
    }
  });
};

export const retryPrompt = async (id: string): Promise<Prompt> => {
  const current = await getPrompt(id);

  if (!current) {
    throw new Error(`Prompt ${id} not found`);
  }

  assertPromptStatus(current, ["failed", "cancelled"], "Retrying a prompt");

  const previousAttemptsValue =
    typeof current.metadata.operator === "object" &&
    current.metadata.operator &&
    !Array.isArray(current.metadata.operator) &&
    typeof current.metadata.operator.retryCount === "number"
      ? current.metadata.operator.retryCount
      : 0;

  return updatePrompt(id, {
    status: "queued",
    clearStartedAt: true,
    clearFinishedAt: true,
    replaceAudit: {},
    errorMessage: null,
    metadataPatch: {
      operator: {
        retriedAt: new Date().toISOString(),
        previousStatus: current.status,
        retryCount: previousAttemptsValue + 1
      },
      failure: null,
      execution: null,
      auditSync: null,
      worktree: null
    }
  });
};
