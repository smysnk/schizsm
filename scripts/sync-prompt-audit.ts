import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  env,
  resolveDocumentStoreRoot
} from "../packages/server/src/config/env";
import { pool, query } from "../packages/server/src/db/pool";
import type {
  JsonObject,
  JsonValue
} from "../packages/server/src/repositories/prompt-repository";

type SyncPromptAuditOptions = {
  promptId: string;
  repoRoot?: string;
  auditPath?: string;
};

type GitInfo = {
  available: boolean;
  branch: string | null;
  sha: string | null;
  error: string | null;
};

type PromptAuditPayload = JsonObject & {
  promptId: string;
  recordedAt: string | null;
  branch: string | null;
  sha: string | null;
  added: string[];
  modified: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
  canvas: string[];
  contextualRelevance: Array<{
    path: string;
    relationship: string;
    disposition: string;
  }>;
  timing?: JsonObject;
  performance?: JsonObject;
  hypotheses: JsonObject;
  rationales: JsonObject;
  rawSection: string;
};

type SyncPromptAuditResult = {
  promptId: string;
  auditPath: string;
  recordedAt: string | null;
  branch: string | null;
  sha: string | null;
  git: GitInfo;
  updatedAt: string;
  sectionStartMarker: string;
  sectionEndMarker: string;
};

type UpdateRow = {
  updated_at: Date;
};

const execFileAsync = promisify(execFile);

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseArgs = (argv: string[]) => {
  let promptId = "";
  let repoRoot: string | undefined;
  let auditPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--prompt-id") {
      promptId = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--repo-root") {
      repoRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--audit-path") {
      auditPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  if (!promptId.trim()) {
    throw new Error("Missing required argument: --prompt-id <prompt-id>");
  }

  return {
    promptId: promptId.trim(),
    repoRoot,
    auditPath
  };
};

export const extractAuditSection = (auditSource: string, promptId: string) => {
  const sectionStartMarker = `<!-- PROMPT-AUDIT-START:${promptId} -->`;
  const sectionEndMarker = `<!-- PROMPT-AUDIT-END:${promptId} -->`;
  const startIndex = auditSource.lastIndexOf(sectionStartMarker);

  if (startIndex < 0) {
    throw new Error(`Could not find audit start marker for prompt ${promptId}.`);
  }

  const endIndex = auditSource.indexOf(sectionEndMarker, startIndex);

  if (endIndex < 0) {
    throw new Error(`Could not find audit end marker for prompt ${promptId}.`);
  }

  return {
    sectionStartMarker,
    sectionEndMarker,
    rawSection: auditSource.slice(startIndex, endIndex + sectionEndMarker.length)
  };
};

export const extractJsonBlock = (rawSection: string) => {
  const match = rawSection.match(/```json\s*([\s\S]*?)\s*```/i);

  if (!match) {
    throw new Error("Audit section is missing its fenced JSON block.");
  }

  const parsed = JSON.parse(match[1]);

  if (!isJsonObject(parsed)) {
    throw new Error("Audit JSON block must contain a JSON object.");
  }

  return parsed;
};

const extractRecordedAt = (rawSection: string) => {
  const match = rawSection.match(/^- Date:\s*(.+)$/m);
  return match ? match[1].trim() : null;
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
};

const toMovedArray = (value: unknown): Array<{ from: string; to: string }> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }

    const from = typeof item.from === "string" ? item.from.trim() : "";
    const to = typeof item.to === "string" ? item.to.trim() : "";

    if (!from || !to) {
      return [];
    }

    return [{ from, to }];
  });
};

const toContextualRelevanceArray = (
  value: unknown
): Array<{ path: string; relationship: string; disposition: string }> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }

    const path = typeof item.path === "string" ? item.path.trim() : "";
    const relationship =
      typeof item.relationship === "string" ? item.relationship.trim() : "";
    const disposition =
      typeof item.disposition === "string" ? item.disposition.trim() : "";

    if (!path || !relationship || !disposition) {
      return [];
    }

    return [{ path, relationship, disposition }];
  });
};

const toJsonValue = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isJsonObject(value)) {
    return Object.entries(value).reduce<JsonObject>((result, [key, item]) => {
      result[key] = toJsonValue(item);
      return result;
    }, {});
  }

  return String(value);
};

const toJsonObject = (value: unknown): JsonObject => {
  if (!isJsonObject(value)) {
    return {};
  }

  return Object.entries(value).reduce<JsonObject>((result, [key, item]) => {
    result[key] = toJsonValue(item);
    return result;
  }, {});
};

const readGitValue = async (
  repoRoot: string,
  args: string[]
): Promise<{ value: string | null; error: string | null }> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      env: process.env
    });

    const value = stdout.trim();
    return { value: value || null, error: value ? null : "Git command returned empty output." };
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim() || error.message
        : error instanceof Error
          ? error.message
          : "Git command failed.";

    return {
      value: null,
      error: message
    };
  }
};

const readGitInfo = async (repoRoot: string): Promise<GitInfo> => {
  const branchResult = await readGitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const shaResult = await readGitValue(repoRoot, ["rev-parse", "HEAD"]);
  const error = branchResult.error || shaResult.error;

  return {
    available: Boolean(branchResult.value || shaResult.value),
    branch: branchResult.value,
    sha: shaResult.value,
    error
  };
};

export const buildAuditPayload = ({
  promptId,
  rawSection,
  parsedJson,
  git
}: {
  promptId: string;
  rawSection: string;
  parsedJson: JsonObject;
  git: GitInfo;
}): PromptAuditPayload => {
  const parsedPromptId =
    typeof parsedJson.promptId === "string" ? parsedJson.promptId.trim() : "";

  if (parsedPromptId && parsedPromptId !== promptId) {
    throw new Error(
      `Audit JSON promptId mismatch. Expected ${promptId}, received ${parsedPromptId}.`
    );
  }

  const decision = isJsonObject(parsedJson.decision)
    ? toJsonObject(parsedJson.decision)
    : undefined;
  const recordedAt =
    typeof parsedJson.recordedAt === "string" && parsedJson.recordedAt.trim()
      ? parsedJson.recordedAt.trim()
      : extractRecordedAt(rawSection);
  const branchFromJson =
    typeof parsedJson.branch === "string" && parsedJson.branch.trim()
      ? parsedJson.branch.trim()
      : null;
  const shaFromJson =
    typeof parsedJson.sha === "string" && parsedJson.sha.trim()
      ? parsedJson.sha.trim()
      : null;
  const branch = git.branch || branchFromJson;
  const sha = git.sha || shaFromJson;
  const payload: PromptAuditPayload = {
    promptId,
    recordedAt,
    branch,
    sha,
    added: toStringArray(parsedJson.added),
    modified: toStringArray(parsedJson.modified),
    deleted: toStringArray(parsedJson.deleted),
    moved: toMovedArray(parsedJson.moved),
    canvas: toStringArray(parsedJson.canvas),
    contextualRelevance: toContextualRelevanceArray(parsedJson.contextualRelevance),
    timing: isJsonObject(parsedJson.timing) ? toJsonObject(parsedJson.timing) : undefined,
    performance: isJsonObject(parsedJson.performance)
      ? toJsonObject(parsedJson.performance)
      : undefined,
    hypotheses: toJsonObject(parsedJson.hypotheses),
    rationales: toJsonObject(parsedJson.rationales),
    rawSection
  };

  if (decision) {
    payload.decision = decision;
  }

  return payload;
};

export const syncPromptAudit = async ({
  promptId,
  repoRoot = env.promptRunnerRepoRoot,
  auditPath = path.join(resolveDocumentStoreRoot(repoRoot), "audit.md")
}: SyncPromptAuditOptions): Promise<SyncPromptAuditResult> => {
  const auditSource = await fs.readFile(auditPath, "utf8");
  const { sectionStartMarker, sectionEndMarker, rawSection } = extractAuditSection(
    auditSource,
    promptId
  );
  const parsedJson = extractJsonBlock(rawSection);
  const git = await readGitInfo(repoRoot);
  const auditPayload = buildAuditPayload({
    promptId,
    rawSection,
    parsedJson,
    git
  });
  const result = await query<UpdateRow>(
    `
      UPDATE prompts
      SET audit = $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
      RETURNING updated_at
    `,
    [promptId, JSON.stringify(auditPayload)]
  );

  if (!result.rowCount) {
    throw new Error(`Prompt ${promptId} not found.`);
  }

  return {
    promptId,
    auditPath,
    recordedAt: auditPayload.recordedAt,
    branch: auditPayload.branch,
    sha: auditPayload.sha,
    git,
    updatedAt: result.rows[0].updated_at.toISOString(),
    sectionStartMarker,
    sectionEndMarker
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const result = await syncPromptAudit(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void main()
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Prompt audit sync failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
