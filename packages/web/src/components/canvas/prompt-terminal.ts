import type { PromptRecord, PromptStatus } from "../../lib/graphql";

export type PromptTransitionRecord = {
  status: string;
  reason: string;
  at: string;
};

export type PromptTerminalTone = "user" | "system";
export type PromptTerminalKind = "user" | "ack" | "blank" | "status" | "git" | "failure";

export type PromptTerminalEntry = {
  id: string;
  text: string;
  tone: PromptTerminalTone;
  kind: PromptTerminalKind;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown) =>
  typeof value === "string" && value.trim().length ? value.trim() : null;

const readRecord = (value: unknown) => (isRecord(value) ? value : null);

export const terminalWorkingStatuses = new Set<PromptStatus>([
  "scanning",
  "deciding",
  "writing",
  "updating_canvas",
  "auditing",
  "committing",
  "pushing",
  "syncing_audit"
]);

export const promptTerminalStatusMessages: Record<PromptStatus, string> = {
  queued: "queued for isolated git + codex run",
  cancelled: "run cancelled by operator",
  scanning: "preparing isolated git worktree",
  deciding: "assembling codex instruction payload",
  writing: "running codex cli",
  updating_canvas: "validating obsidian canvas updates",
  auditing: "parsing codex output",
  committing: "promoting prompt branch onto codex/mindmap",
  pushing: "pushing codex/mindmap to origin",
  syncing_audit: "syncing audit.md back into the prompt row",
  completed: "run complete",
  failed: "run failed"
};

export const getPromptTransitions = (prompt: PromptRecord): PromptTransitionRecord[] => {
  const runner = readRecord(prompt.metadata.runner);
  const transitions = runner?.statusTransitions;

  if (!Array.isArray(transitions)) {
    return [];
  }

  return transitions.flatMap((transition) => {
    if (!isRecord(transition)) {
      return [];
    }

    const status = readString(transition.status);
    const at = readString(transition.at);
    const reason = readString(transition.reason);

    if (!status || !at) {
      return [];
    }

    return [{ status, at, reason: reason || "No reason recorded." }];
  });
};

export const getPromptFailureDetails = (prompt: PromptRecord) => {
  const failure = readRecord(prompt.metadata.failure);
  return {
    stage: readString(failure?.stage),
    message: readString(failure?.message) || prompt.errorMessage
  };
};

export const getPromptGitSummary = (prompt: PromptRecord) => {
  const audit = readRecord(prompt.audit);
  const auditSync = readRecord(prompt.metadata.auditSync);
  const branch = readString(audit?.branch) || readString(auditSync?.branch);
  const sha = readString(audit?.sha) || readString(auditSync?.sha);

  return { branch, sha };
};

export const buildPromptTerminalEntries = (prompt: PromptRecord | null): PromptTerminalEntry[] => {
  const entries: PromptTerminalEntry[] = [
    {
      id: "ack",
      text: "OK",
      tone: "system",
      kind: "ack"
    },
    {
      id: "spacer",
      text: "",
      tone: "system",
      kind: "blank"
    }
  ];

  const seenStatuses = new Set<PromptStatus>();
  const pushStatusEntry = (status: PromptStatus) => {
    if (seenStatuses.has(status)) {
      return;
    }

    seenStatuses.add(status);
    entries.push({
      id: `status-${status}`,
      text: `# ${promptTerminalStatusMessages[status]}`,
      tone: "system",
      kind: "status"
    });
  };

  pushStatusEntry("queued");

  if (!prompt) {
    return entries;
  }

  for (const transition of getPromptTransitions(prompt)) {
    const nextStatus = transition.status as PromptStatus;

    if (nextStatus in promptTerminalStatusMessages) {
      pushStatusEntry(nextStatus);
    }
  }

  if (!seenStatuses.has(prompt.status) && prompt.status !== "queued") {
    pushStatusEntry(prompt.status);
  }

  const failure = getPromptFailureDetails(prompt);
  if (failure.message && prompt.status === "failed") {
    entries.push({
      id: "failure-detail",
      text: `# error: ${failure.message}`,
      tone: "system",
      kind: "failure"
    });
  }

  const git = getPromptGitSummary(prompt);
  if (prompt.status === "completed" && (git.branch || git.sha)) {
    entries.push({
      id: "git-detail",
      text: `# git: ${git.branch || "unknown branch"}${git.sha ? ` @ ${git.sha.slice(0, 8)}` : ""}`,
      tone: "system",
      kind: "git"
    });
  }

  return entries;
};

export const buildPromptTerminalWorkingEntry = (
  prompt: PromptRecord | null,
  dots: number
): PromptTerminalEntry | null => {
  if (!prompt || !terminalWorkingStatuses.has(prompt.status)) {
    return null;
  }

  return {
    id: `working-${prompt.id}-${prompt.status}`,
    text: `# Working${".".repeat(Math.min(3, Math.max(1, dots)))}`,
    tone: "system",
    kind: "status"
  };
};

export const getNextTypedTerminalEntries = (
  currentEntries: PromptTerminalEntry[],
  targetEntries: PromptTerminalEntry[],
  typingDelayMs: number,
  linePauseMs: number
) => {
  for (let index = 0; index < targetEntries.length; index += 1) {
    const currentEntry = currentEntries[index];
    const targetEntry = targetEntries[index];

    if (!currentEntry) {
      return {
        entries: [
          ...currentEntries,
          {
            ...targetEntry,
            text: targetEntry.text ? targetEntry.text.slice(0, 1) : ""
          }
        ],
        delayMs: targetEntry.text ? typingDelayMs : linePauseMs
      };
    }

    if (currentEntry.id !== targetEntry.id) {
      return {
        entries: [
          ...currentEntries.slice(0, index),
          {
            ...targetEntry,
            text: targetEntry.text ? targetEntry.text.slice(0, 1) : ""
          }
        ],
        delayMs: targetEntry.text ? typingDelayMs : linePauseMs
      };
    }

    if (currentEntry.text.length < targetEntry.text.length) {
      const nextText = targetEntry.text.slice(0, currentEntry.text.length + 1);
      return {
        entries: [
          ...currentEntries.slice(0, index),
          {
            ...targetEntry,
            text: nextText
          },
          ...currentEntries.slice(index + 1)
        ],
        delayMs: nextText.length === targetEntry.text.length ? linePauseMs : typingDelayMs
      };
    }
  }

  return null;
};
