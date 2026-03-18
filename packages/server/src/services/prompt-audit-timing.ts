import { promises as fs } from "node:fs";

export type PromptTimingDetails = {
  queuedAt: string | null;
  startedAt: string | null;
  finalizedAt: string;
  queueWaitMs: number | null;
  processingMs: number | null;
};

const jsonFencePattern = /```json\s*([\s\S]*?)\s*```/i;

const formatDuration = (durationMs: number | null) => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "Unavailable";
  }

  if (durationMs < 1_000) {
    return `<1s (${Math.round(durationMs)} ms)`;
  }

  const totalSeconds = Math.round(durationMs / 1_000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s (${durationMs} ms)`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0
      ? `${minutes}m ${seconds}s (${durationMs} ms)`
      : `${minutes}m (${durationMs} ms)`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m (${durationMs} ms)`
    : `${hours}h (${durationMs} ms)`;
};

const parseTimestamp = (value: string | null) => {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
};

export const buildPromptTimingDetails = ({
  createdAt,
  startedAt,
  finalizedAt
}: {
  createdAt: string | null;
  startedAt: string | null;
  finalizedAt: string;
}): PromptTimingDetails => {
  const createdAtMs = parseTimestamp(createdAt);
  const startedAtMs = parseTimestamp(startedAt);
  const finalizedAtMs = parseTimestamp(finalizedAt);

  return {
    queuedAt: createdAt,
    startedAt,
    finalizedAt,
    queueWaitMs:
      createdAtMs !== null && startedAtMs !== null ? Math.max(0, startedAtMs - createdAtMs) : null,
    processingMs:
      startedAtMs !== null && finalizedAtMs !== null
        ? Math.max(0, finalizedAtMs - startedAtMs)
        : null
  };
};

const replaceJsonFence = (rawSection: string, nextJson: string) =>
  rawSection.replace(jsonFencePattern, `\`\`\`json\n${nextJson}\n\`\`\``);

const upsertTimingSection = (rawSection: string, details: PromptTimingDetails) => {
  const timingSection = `### Timing
- Queued At: ${details.queuedAt || "Unavailable"}
- Started At: ${details.startedAt || "Unavailable"}
- Finalized At: ${details.finalizedAt}
- Time In Queue: ${formatDuration(details.queueWaitMs)}
- Processing Time: ${formatDuration(details.processingMs)}

`;

  if (/^### Timing\s*$/m.test(rawSection)) {
    return rawSection.replace(
      /^### Timing\s*$[\s\S]*?(?=```json)/m,
      timingSection
    );
  }

  return rawSection.replace(jsonFencePattern, `${timingSection}\`\`\`json\n$1\n\`\`\``);
};

export const appendPromptTimingToAuditSection = async ({
  auditPath,
  promptId,
  createdAt,
  startedAt,
  finalizedAt
}: {
  auditPath: string;
  promptId: string;
  createdAt: string | null;
  startedAt: string | null;
  finalizedAt: string;
}) => {
  const auditSource = await fs.readFile(auditPath, "utf8");
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

  const rawSection = auditSource.slice(startIndex, endIndex + sectionEndMarker.length);
  const jsonMatch = rawSection.match(jsonFencePattern);

  if (!jsonMatch) {
    throw new Error(`Audit section for prompt ${promptId} is missing its JSON block.`);
  }

  const parsedJson = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
  const timing = buildPromptTimingDetails({
    createdAt,
    startedAt,
    finalizedAt
  });

  parsedJson.timing = {
    queuedAt: timing.queuedAt,
    startedAt: timing.startedAt,
    finalizedAt: timing.finalizedAt,
    queueWaitMs: timing.queueWaitMs,
    processingMs: timing.processingMs
  };

  const withTimingSection = upsertTimingSection(rawSection, timing);
  const nextSection = replaceJsonFence(withTimingSection, JSON.stringify(parsedJson, null, 2));
  const nextAudit = `${auditSource.slice(0, startIndex)}${nextSection}${auditSource.slice(
    endIndex + sectionEndMarker.length
  )}`;

  await fs.writeFile(auditPath, nextAudit, "utf8");

  return {
    auditPath,
    promptId,
    timing
  };
};
