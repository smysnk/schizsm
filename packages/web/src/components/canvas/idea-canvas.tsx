"use client";

import { useMutation, useQuery, useSubscription } from "@apollo/client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  CANCEL_PROMPT_MUTATION,
  CREATE_PROMPT_MUTATION,
  PAUSE_PROMPT_RUNNER_MUTATION,
  PROMPT_WORKSPACE_SUBSCRIPTION,
  PROMPTS_QUERY,
  RESUME_PROMPT_RUNNER_MUTATION,
  RETRY_PROMPT_MUTATION,
  type PromptRecord,
  type PromptRunnerStateRecord,
  type PromptStatus,
  type PromptWorkspaceUpdateRecord
} from "../../lib/graphql";
import {
  useRealtimeConnectionStatus,
  type RealtimeConnectionStatus
} from "../../lib/apollo";
import { readRuntimeConfig } from "../../lib/runtime-config";
import {
  PROMPT_ZEN_PLACEHOLDER_QUESTIONS,
  PROMPT_ZEN_TYPING_CORRECTION_PAUSE_MS,
  PROMPT_ZEN_TYPING_DELETE_MS,
  PROMPT_ZEN_TYPING_END_PAUSE_MS,
  PROMPT_ZEN_TYPING_ERROR_RATE,
  PROMPT_ZEN_TYPING_MAX_MS,
  PROMPT_ZEN_TYPING_MIN_MS,
  PROMPT_ZEN_TYPING_START_PAUSE_MS
} from "./prompt-zen.constants";
import { ThemeToggle } from "../ui/theme-toggle";

type PromptsResponse = {
  promptRunnerState: PromptRunnerStateRecord;
  prompts: PromptRecord[];
};

type PromptWorkspaceSubscriptionResponse = {
  promptWorkspace: PromptWorkspaceUpdateRecord;
};

type CreatePromptResponse = {
  createPrompt: PromptRecord;
};

type CancelPromptResponse = {
  cancelPrompt: PromptRecord;
};

type RetryPromptResponse = {
  retryPrompt: PromptRecord;
};

type PausePromptRunnerResponse = {
  pausePromptRunner: PromptRunnerStateRecord;
};

type ResumePromptRunnerResponse = {
  resumePromptRunner: PromptRunnerStateRecord;
};

type CreatePromptVariables = {
  input: {
    content: string;
  };
};

type PromptHistoryFilter = "all" | "active" | "completed" | "failed" | "cancelled";
type WorkspaceSurface = "prompt" | "history";

type PromptTransitionRecord = {
  status: string;
  reason: string;
  at: string;
};

const RECENT_PROMPTS_LIMIT = 24;
const activePromptStatuses = new Set<PromptStatus>([
  "queued",
  "scanning",
  "deciding",
  "writing",
  "updating_canvas",
  "auditing",
  "committing",
  "pushing",
  "syncing_audit"
]);

const promptHistoryFilters: Array<{ id: PromptHistoryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" }
];

const workspaceSurfaces: Array<{ id: WorkspaceSurface; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "history", label: "Prompt history" }
];

const repoLabel = "smysnk/schizsm";
const repoUrl = "https://github.com/smysnk/schizsm";

const formatPromptStatus = (status: PromptStatus) => status.replace(/_/g, " ");

const formatPromptTime = (value: string) => {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown) =>
  typeof value === "string" && value.trim().length ? value.trim() : null;

const readRecord = (value: unknown) => (isRecord(value) ? value : null);

const readStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const getPromptTransitions = (prompt: PromptRecord): PromptTransitionRecord[] => {
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

const getLatestPromptTransition = (prompt: PromptRecord) => {
  const transitions = getPromptTransitions(prompt);
  return transitions[transitions.length - 1] || null;
};

const formatPromptDuration = (prompt: PromptRecord) => {
  const startedAt = prompt.startedAt ? Date.parse(prompt.startedAt) : NaN;
  const finishedAt = Date.parse(prompt.finishedAt || prompt.updatedAt);

  if (Number.isNaN(startedAt) || Number.isNaN(finishedAt)) {
    return prompt.startedAt ? "Timing unavailable" : "Not started";
  }

  const durationMs = Math.max(0, finishedAt - startedAt);

  if (durationMs < 1_000) {
    return "<1s";
  }

  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }

  if (durationMs < 3_600_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }

  return `${(durationMs / 3_600_000).toFixed(1)}h`;
};

const getPromptAuditSummary = (prompt: PromptRecord) => {
  const audit = readRecord(prompt.audit);
  const added = readStringArray(audit?.added).length;
  const modified = readStringArray(audit?.modified).length;
  const deleted = readStringArray(audit?.deleted).length;
  const canvas = readStringArray(audit?.canvas).length;
  const moved = Array.isArray(audit?.moved) ? audit.moved.length : 0;
  const touchedFiles = added + modified + deleted + moved;

  return {
    touchedFiles,
    canvas,
    summary:
      touchedFiles || canvas
        ? `${touchedFiles} file${touchedFiles === 1 ? "" : "s"}${canvas ? ` + ${canvas} canvas` : ""}`
        : "No repo changes recorded"
  };
};

const getPromptFailureDetails = (prompt: PromptRecord) => {
  const failure = readRecord(prompt.metadata.failure);
  return {
    stage: readString(failure?.stage),
    message: readString(failure?.message) || prompt.errorMessage
  };
};

const getPromptRecoveryNote = (prompt: PromptRecord) => {
  const recovery = readRecord(prompt.metadata.recovery);
  return readString(recovery?.note);
};

const getPromptGitSummary = (prompt: PromptRecord) => {
  const audit = readRecord(prompt.audit);
  const auditSync = readRecord(prompt.metadata.auditSync);
  const branch = readString(audit?.branch) || readString(auditSync?.branch);
  const sha = readString(audit?.sha) || readString(auditSync?.sha);

  return { branch, sha };
};

const matchesPromptHistoryFilter = (prompt: PromptRecord, filter: PromptHistoryFilter) => {
  switch (filter) {
    case "active":
      return activePromptStatuses.has(prompt.status);
    case "completed":
      return prompt.status === "completed";
    case "failed":
      return prompt.status === "failed";
    case "cancelled":
      return prompt.status === "cancelled";
    default:
      return true;
  }
};

const canCancelPrompt = (prompt: PromptRecord | null) =>
  prompt?.status === "queued" || prompt?.status === "failed";

const canRetryPrompt = (prompt: PromptRecord | null) =>
  prompt?.status === "failed" || prompt?.status === "cancelled";

const formatRealtimeConnectionStatus = (status: RealtimeConnectionStatus) => {
  switch (status) {
    case "connected":
      return "WebSocket connected";
    case "reconnecting":
      return "WebSocket reconnecting";
    case "error":
      return "WebSocket error";
    case "connecting":
      return "WebSocket connecting";
    default:
      return "WebSocket idle";
  }
};

const getRealtimeConnectionTone = (status: RealtimeConnectionStatus) => {
  switch (status) {
    case "connected":
      return "workspace__footer-note--positive";
    case "error":
      return "workspace__footer-note--danger";
    case "reconnecting":
    case "connecting":
      return "workspace__footer-note--warning";
    default:
      return "";
  }
};

const getRandomTypingDelay = (character: string) => {
  const base =
    PROMPT_ZEN_TYPING_MIN_MS +
    Math.round(Math.random() * (PROMPT_ZEN_TYPING_MAX_MS - PROMPT_ZEN_TYPING_MIN_MS));

  if (/[.,!?]/.test(character)) {
    return base + 140;
  }

  if (/\s/.test(character)) {
    return base + 44;
  }

  return base;
};

const getMistypedCharacter = (character: string) => {
  const lowerLetters = "abcdefghijklmnopqrstuvwxyz";
  const upperLetters = lowerLetters.toUpperCase();
  const digits = "0123456789";

  const source = /[a-z]/.test(character)
    ? lowerLetters
    : /[A-Z]/.test(character)
      ? upperLetters
      : /[0-9]/.test(character)
        ? digits
        : null;

  if (!source) {
    return character;
  }

  let nextCharacter = character;

  while (nextCharacter === character) {
    nextCharacter = source[Math.floor(Math.random() * source.length)] || character;
  }

  return nextCharacter;
};

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="workspace__repo-icon"
    >
      <path d="M8 0C3.58 0 0 3.69 0 8.24c0 3.64 2.29 6.73 5.47 7.82.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.5-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.56-.01-.57.63-.01 1.08.59 1.23.83.72 1.24 1.87.89 2.33.68.07-.53.28-.89.5-1.09-1.78-.21-3.64-.92-3.64-4.08 0-.9.31-1.64.82-2.22-.08-.21-.36-1.05.08-2.18 0 0 .67-.22 2.2.85A7.38 7.38 0 0 1 8 3.49c.68 0 1.37.09 2.01.27 1.53-1.07 2.2-.85 2.2-.85.44 1.13.16 1.97.08 2.18.51.58.82 1.31.82 2.22 0 3.17-1.87 3.87-3.65 4.08.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.47.55.39A8.27 8.27 0 0 0 16 8.24C16 3.69 12.42 0 8 0Z" />
    </svg>
  );
}

function PlayMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="history-surface__runner-icon"
    >
      <path d="M4 2.62v10.76c0 .48.52.78.93.53l8.42-5.38a.62.62 0 0 0 0-1.06L4.93 2.09A.62.62 0 0 0 4 2.62Z" />
    </svg>
  );
}

function PauseMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="history-surface__runner-icon"
    >
      <path d="M4 2.5h3v11H4zm5 0h3v11H9z" />
    </svg>
  );
}

export function IdeaCanvas() {
  const runtimeConfig = readRuntimeConfig();
  const realtimeConnectionStatus = useRealtimeConnectionStatus();
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const promptCursorMarkerRef = useRef<HTMLSpanElement | null>(null);
  const promptPlaceholderQuestionIndexRef = useRef(0);
  const [promptInput, setPromptInput] = useState("");
  const [animatedPromptText, setAnimatedPromptText] = useState("");
  const [promptInputFocused, setPromptInputFocused] = useState(false);
  const [promptSelectionStart, setPromptSelectionStart] = useState(0);
  const [promptCursorPosition, setPromptCursorPosition] = useState({
    left: 0,
    top: 0,
    width: 16,
    height: 24
  });
  const [promptSubmitError, setPromptSubmitError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<PromptHistoryFilter>("all");
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>("prompt");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [, setStatusLabel] = useState("Ready to capture a prompt.");

  const {
    data: promptsData,
    loading: promptsLoading,
    error: promptsError,
    refetch: refetchPrompts
  } = useQuery<PromptsResponse>(PROMPTS_QUERY, {
    variables: { limit: RECENT_PROMPTS_LIMIT },
    fetchPolicy: "cache-and-network"
  });
  const { data: workspaceSubscriptionData } = useSubscription<PromptWorkspaceSubscriptionResponse>(
    PROMPT_WORKSPACE_SUBSCRIPTION,
    {
      variables: { limit: RECENT_PROMPTS_LIMIT }
    }
  );

  const [createPromptMutation, { loading: createPromptLoading }] = useMutation<
    CreatePromptResponse,
    CreatePromptVariables
  >(CREATE_PROMPT_MUTATION);
  const [cancelPromptMutation, { loading: cancelPromptLoading }] = useMutation<
    CancelPromptResponse,
    { id: string }
  >(CANCEL_PROMPT_MUTATION);
  const [retryPromptMutation, { loading: retryPromptLoading }] = useMutation<
    RetryPromptResponse,
    { id: string }
  >(RETRY_PROMPT_MUTATION);
  const [pausePromptRunnerMutation, { loading: pausePromptRunnerLoading }] = useMutation<
    PausePromptRunnerResponse
  >(PAUSE_PROMPT_RUNNER_MUTATION);
  const [resumePromptRunnerMutation, { loading: resumePromptRunnerLoading }] = useMutation<
    ResumePromptRunnerResponse
  >(RESUME_PROMPT_RUNNER_MUTATION);

  const workspaceSnapshot = workspaceSubscriptionData?.promptWorkspace;
  const recentPrompts = workspaceSnapshot?.prompts || promptsData?.prompts || [];
  const promptRunnerState =
    workspaceSnapshot?.promptRunnerState || promptsData?.promptRunnerState || null;
  const filteredPrompts = recentPrompts.filter((prompt) =>
    matchesPromptHistoryFilter(prompt, historyFilter)
  );
  const selectedPrompt =
    filteredPrompts.find((prompt) => prompt.id === selectedPromptId) || filteredPrompts[0] || null;
  const selectedPromptTransitions = selectedPrompt
    ? getPromptTransitions(selectedPrompt).slice().reverse()
    : [];
  const selectedPromptAudit = selectedPrompt ? getPromptAuditSummary(selectedPrompt) : null;
  const selectedPromptFailure = selectedPrompt ? getPromptFailureDetails(selectedPrompt) : null;
  const selectedPromptRecovery = selectedPrompt ? getPromptRecoveryNote(selectedPrompt) : null;
  const selectedPromptGit = selectedPrompt ? getPromptGitSummary(selectedPrompt) : null;
  const latestSelectedTransition = selectedPrompt ? getLatestPromptTransition(selectedPrompt) : null;
  const promptActionLoading =
    cancelPromptLoading ||
    retryPromptLoading ||
    pausePromptRunnerLoading ||
    resumePromptRunnerLoading;
  const promptCursorDisplayValue =
    promptInput.length > 0 ? promptInput : promptInputFocused ? "" : animatedPromptText;
  const promptCursorIndex =
    promptInput.length > 0
      ? Math.min(promptSelectionStart, promptInput.length)
      : promptInputFocused
        ? 0
        : animatedPromptText.length;
  const promptCursorLeadingText = promptCursorDisplayValue.slice(0, promptCursorIndex);
  const promptCursorTrailingText = promptCursorDisplayValue.slice(promptCursorIndex);
  const showPromptCursor = promptInputFocused || promptInput.length === 0;
  const runnerStatusTone = promptRunnerState?.paused
    ? "workspace__footer-note--warning"
    : promptRunnerState?.inFlight
      ? "workspace__footer-note--warning"
      : "workspace__footer-note--positive";
  const runnerStatusLabel = promptRunnerState?.paused
    ? "Paused"
    : promptRunnerState?.inFlight
      ? "Active"
      : "Ready";

  const promptCounts = recentPrompts.reduce(
    (summary, prompt) => {
      if (prompt.status === "completed") {
        summary.completed += 1;
      } else if (prompt.status === "failed") {
        summary.failed += 1;
      } else if (prompt.status === "cancelled") {
        summary.cancelled += 1;
      } else {
        summary.active += 1;
      }

      if (prompt.status === "queued") {
        summary.queued += 1;
      }

      return summary;
    },
    { active: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 }
  );

  useEffect(() => {
    if (!filteredPrompts.length) {
      setSelectedPromptId(null);
      return;
    }

    setSelectedPromptId((current) =>
      current && filteredPrompts.some((prompt) => prompt.id === current)
        ? current
        : filteredPrompts[0].id
    );
  }, [filteredPrompts]);

  useEffect(() => {
    if (!themeMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!themeMenuRef.current?.contains(event.target as Node)) {
        setThemeMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setThemeMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    if (activeSurface !== "prompt" || promptInputFocused || promptInput.length > 0) {
      setAnimatedPromptText("");
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const sleep = (delay: number) =>
      new Promise<void>((resolve) => {
        timeoutId = window.setTimeout(() => {
          timeoutId = null;
          resolve();
        }, delay);
      });

    const runPlaceholderLoop = async () => {
      let questionIndex =
        promptPlaceholderQuestionIndexRef.current % PROMPT_ZEN_PLACEHOLDER_QUESTIONS.length;

      while (!cancelled) {
        const question =
          PROMPT_ZEN_PLACEHOLDER_QUESTIONS[questionIndex] ||
          PROMPT_ZEN_PLACEHOLDER_QUESTIONS[0];
        let nextText = "";

        setAnimatedPromptText("");
        await sleep(PROMPT_ZEN_TYPING_START_PAUSE_MS);

        for (const character of question) {
          if (cancelled) {
            return;
          }

          if (!/\s/.test(character) && Math.random() < PROMPT_ZEN_TYPING_ERROR_RATE) {
            nextText += getMistypedCharacter(character);
            setAnimatedPromptText(nextText);
            await sleep(getRandomTypingDelay(character));

            if (cancelled) {
              return;
            }

            nextText = nextText.slice(0, -1);
            setAnimatedPromptText(nextText);
            await sleep(PROMPT_ZEN_TYPING_CORRECTION_PAUSE_MS);
          }

          nextText += character;
          setAnimatedPromptText(nextText);
          await sleep(getRandomTypingDelay(character));
        }

        await sleep(PROMPT_ZEN_TYPING_END_PAUSE_MS);

        while (!cancelled && nextText.length > 0) {
          nextText = nextText.slice(0, -1);
          setAnimatedPromptText(nextText);
          await sleep(PROMPT_ZEN_TYPING_DELETE_MS);
        }

        questionIndex = (questionIndex + 1) % PROMPT_ZEN_PLACEHOLDER_QUESTIONS.length;
        promptPlaceholderQuestionIndexRef.current = questionIndex;
      }
    };

    void runPlaceholderLoop();

    return () => {
      cancelled = true;

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeSurface, promptInput.length, promptInputFocused]);

  useLayoutEffect(() => {
    if (!showPromptCursor || activeSurface !== "prompt") {
      return;
    }

    const updatePromptCursorPosition = () => {
      const marker = promptCursorMarkerRef.current;

      if (!marker) {
        return;
      }

      const lineHeight = Number.parseFloat(window.getComputedStyle(marker).lineHeight) || 0;
      const cursorHeight = Math.max(18, Math.round(lineHeight * 0.9));
      const cursorWidth = Math.max(12, Math.round(lineHeight * 0.5));
      const topOffset = Math.max(0, (lineHeight - cursorHeight) / 2);

      setPromptCursorPosition({
        left: marker.offsetLeft,
        top: marker.offsetTop + topOffset,
        width: cursorWidth,
        height: cursorHeight
      });
    };

    updatePromptCursorPosition();
    window.addEventListener("resize", updatePromptCursorPosition);

    return () => {
      window.removeEventListener("resize", updatePromptCursorPosition);
    };
  }, [
    activeSurface,
    promptCursorLeadingText,
    promptCursorTrailingText,
    promptCursorIndex,
    showPromptCursor
  ]);

  const submitPrompt = async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content) {
      const message = "Enter a prompt before queueing a run.";
      setPromptSubmitError(message);
      setStatusLabel(message);
      return;
    }

    setPromptSubmitError(null);
    setStatusLabel("Queueing prompt.");

    try {
      const result = await createPromptMutation({
        variables: {
          input: { content }
        }
      });

      const createdPrompt = result.data?.createPrompt;

      setPromptInput("");
      if (createdPrompt) {
        setSelectedPromptId(createdPrompt.id);
      }
      setHistoryFilter("active");
      setActiveSurface("history");
      setStatusLabel(
        createdPrompt
          ? `Queued prompt ${createdPrompt.id.slice(0, 8)}.`
          : "Queued prompt."
      );
      await refetchPrompts();
    } catch (mutationError) {
      const message =
        mutationError instanceof Error ? mutationError.message : "Failed to queue prompt.";
      setPromptSubmitError(message);
      setStatusLabel(message);
    }
  };

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitPrompt(promptInput);
  };

  const handlePromptKeyDown = async (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    await submitPrompt(promptInput);
  };

  const syncPromptSelection = (selectionStart: number | null) => {
    setPromptSelectionStart(selectionStart ?? 0);
  };

  const handleCancelPrompt = async () => {
    if (!selectedPrompt || !canCancelPrompt(selectedPrompt)) {
      return;
    }

    try {
      const result = await cancelPromptMutation({
        variables: { id: selectedPrompt.id }
      });
      setStatusLabel(
        result.data?.cancelPrompt
          ? `Cancelled prompt ${result.data.cancelPrompt.id.slice(0, 8)}.`
          : "Cancelled prompt."
      );
      await refetchPrompts();
    } catch (mutationError) {
      setStatusLabel(
        mutationError instanceof Error ? mutationError.message : "Failed to cancel prompt."
      );
    }
  };

  const handleRetryPrompt = async () => {
    if (!selectedPrompt || !canRetryPrompt(selectedPrompt)) {
      return;
    }

    try {
      const result = await retryPromptMutation({
        variables: { id: selectedPrompt.id }
      });
      const retriedPrompt = result.data?.retryPrompt;
      if (retriedPrompt) {
        setSelectedPromptId(retriedPrompt.id);
      }
      setHistoryFilter("active");
      setStatusLabel(
        retriedPrompt
          ? `Re-queued prompt ${retriedPrompt.id.slice(0, 8)}.`
          : "Re-queued prompt."
      );
      await refetchPrompts();
    } catch (mutationError) {
      setStatusLabel(
        mutationError instanceof Error ? mutationError.message : "Failed to retry prompt."
      );
    }
  };

  const handleTogglePromptRunner = async () => {
    try {
      const nextState = promptRunnerState?.paused
        ? (await resumePromptRunnerMutation()).data?.resumePromptRunner || null
        : (await pausePromptRunnerMutation()).data?.pausePromptRunner || null;
      setStatusLabel(nextState?.paused ? "Prompt runner paused." : "Prompt runner resumed.");
      await refetchPrompts();
    } catch (mutationError) {
      setStatusLabel(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update prompt runner state."
      );
    }
  };

  return (
    <main className="workspace">
      <div className="workspace__shell">
        {promptsError ? (
          <div className="workspace-panel workspace__banner" role="status">
            Prompt state unavailable: {promptsError.message}
          </div>
        ) : null}

        <section className={`workspace__content workspace__content--${activeSurface}`}>
          {activeSurface === "prompt" ? (
            <div className="prompt-zen">
              <form
                className="workspace-panel workspace-panel--strong prompt-zen__form"
                onSubmit={handlePromptSubmit}
              >
                <div className="prompt-zen__halo" aria-hidden="true" />
                <div
                  className="prompt-zen__core"
                  data-empty={promptInput.length === 0}
                >
                  <div className="prompt-zen__cursor-measure" aria-hidden="true">
                    {promptCursorLeadingText}
                    <span className="prompt-zen__cursor-anchor" ref={promptCursorMarkerRef}>
                      {"\u200b"}
                    </span>
                    {promptCursorTrailingText || " "}
                  </div>
                  {showPromptCursor ? (
                    <span
                      className="prompt-zen__cursor"
                      aria-hidden="true"
                      style={{
                        left: `${promptCursorPosition.left}px`,
                        top: `${promptCursorPosition.top}px`,
                        width: `${promptCursorPosition.width}px`,
                        height: `${promptCursorPosition.height}px`
                      }}
                    />
                  ) : null}
                  <label className="sr-only" htmlFor="prompt-input">
                    New prompt
                  </label>
                  <textarea
                    id="prompt-input"
                    name="prompt"
                    rows={8}
                    value={promptInput}
                    onChange={(event) => {
                      setPromptInput(event.target.value);
                      syncPromptSelection(event.currentTarget.selectionStart);
                    }}
                    onFocus={(event) => {
                      setPromptInputFocused(true);
                      syncPromptSelection(event.currentTarget.selectionStart);
                    }}
                    onBlur={() => setPromptInputFocused(false)}
                    onClick={(event) => syncPromptSelection(event.currentTarget.selectionStart)}
                    onKeyDown={handlePromptKeyDown}
                    onKeyUp={(event) => syncPromptSelection(event.currentTarget.selectionStart)}
                    onSelect={(event) => syncPromptSelection(event.currentTarget.selectionStart)}
                    placeholder={promptInputFocused ? "" : animatedPromptText}
                  />
                </div>
                <button
                  type="submit"
                  className="sr-only"
                  disabled={createPromptLoading || !promptInput.trim()}
                >
                  {createPromptLoading ? "Queueing..." : "Queue prompt"}
                </button>
              </form>
            </div>
          ) : (
            <section className="history-surface">
              <div className="history-surface__toolbar">
                <div className="prompt-filters" role="tablist" aria-label="Prompt history filter">
                  {promptHistoryFilters.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      className="prompt-filter"
                      data-active={historyFilter === filter.id}
                      onClick={() => setHistoryFilter(filter.id)}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="prompt-summary__grid prompt-summary__grid--history">
                <div className="stat-card">
                  <span className="stat-card__label">Active</span>
                  <strong>{promptCounts.active}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-card__label">Queued</span>
                  <strong>{promptCounts.queued}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-card__label">Completed</span>
                  <strong>{promptCounts.completed}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-card__label">Failed</span>
                  <strong>{promptCounts.failed}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-card__label">Cancelled</span>
                  <strong>{promptCounts.cancelled}</strong>
                </div>
              </div>

              {filteredPrompts.length ? (
                <div className="prompt-history__grid">
                  <div className="prompt-list__column">
                    <div className="prompt-list__items prompt-list__items--history">
                      {filteredPrompts.map((prompt) => {
                        const latestTransition = getLatestPromptTransition(prompt);
                        const failure = getPromptFailureDetails(prompt);
                        const auditSummary = getPromptAuditSummary(prompt);

                        return (
                          <button
                            type="button"
                            className="prompt-item prompt-item--interactive"
                            data-selected={selectedPrompt?.id === prompt.id}
                            key={prompt.id}
                            onClick={() => setSelectedPromptId(prompt.id)}
                          >
                            <div className="prompt-item__row">
                              <span className={`prompt-status prompt-status--${prompt.status}`}>
                                {formatPromptStatus(prompt.status)}
                              </span>
                              <span className="prompt-item__time">
                                {formatPromptTime(prompt.createdAt)}
                              </span>
                            </div>

                            <p className="prompt-item__content">{prompt.content}</p>

                            <p className="prompt-item__subtext">
                              {failure.message || latestTransition?.reason || auditSummary.summary}
                            </p>

                            <div className="prompt-item__meta">
                              <span>#{prompt.id.slice(0, 8)}</span>
                              <span>{formatPromptDuration(prompt)}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <aside className="prompt-detail">
                    {selectedPrompt ? (
                      <>
                        <div className="prompt-detail__header">
                          <div>
                            <p className="workspace__eyebrow">Selected prompt</p>
                            <h3>#{selectedPrompt.id.slice(0, 8)}</h3>
                          </div>
                          <span className={`prompt-status prompt-status--${selectedPrompt.status}`}>
                            {formatPromptStatus(selectedPrompt.status)}
                          </span>
                        </div>

                        <p className="prompt-detail__content">{selectedPrompt.content}</p>

                        {selectedPrompt.status === "failed" ? (
                          <div className="prompt-detail__actions">
                            <button
                              type="button"
                              onClick={handleCancelPrompt}
                              disabled={!canCancelPrompt(selectedPrompt) || promptActionLoading}
                            >
                              Cancel prompt
                            </button>
                            <button
                              type="button"
                              className="prompt-detail__retry-button"
                              onClick={handleRetryPrompt}
                              disabled={!canRetryPrompt(selectedPrompt) || promptActionLoading}
                            >
                              Retry prompt
                            </button>
                          </div>
                        ) : null}

                        <div className="prompt-detail__stats">
                          <div className="stat-card">
                            <span className="stat-card__label">Submitted</span>
                            <span className="stat-card__value">
                              {formatPromptTime(selectedPrompt.createdAt)}
                            </span>
                          </div>
                          <div className="stat-card">
                            <span className="stat-card__label">Started</span>
                            <span className="stat-card__value">
                              {selectedPrompt.startedAt
                                ? formatPromptTime(selectedPrompt.startedAt)
                                : "Not started"}
                            </span>
                          </div>
                          <div className="stat-card">
                            <span className="stat-card__label">Finished</span>
                            <span className="stat-card__value">
                              {selectedPrompt.finishedAt
                                ? formatPromptTime(selectedPrompt.finishedAt)
                                : "In progress"}
                            </span>
                          </div>
                          <div className="stat-card">
                            <span className="stat-card__label">Duration</span>
                            <span className="stat-card__value">
                              {formatPromptDuration(selectedPrompt)}
                            </span>
                          </div>
                          <div className="stat-card">
                            <span className="stat-card__label">Latest stage</span>
                            <span className="stat-card__value">
                              {selectedPromptFailure?.stage ||
                                latestSelectedTransition?.status ||
                                "Queued"}
                            </span>
                          </div>
                          <div className="stat-card">
                            <span className="stat-card__label">Repo impact</span>
                            <span className="stat-card__value">
                              {selectedPromptAudit?.summary || "No repo changes recorded"}
                            </span>
                          </div>
                        </div>

                        {(selectedPromptGit?.branch || selectedPromptGit?.sha) && (
                          <p className="prompt-detail__hint">
                            Git: {selectedPromptGit.branch || "unknown branch"}
                            {selectedPromptGit.sha ? ` @ ${selectedPromptGit.sha.slice(0, 8)}` : ""}
                          </p>
                        )}

                        {promptRunnerState ? (
                          <div className="prompt-detail__runner">
                            <p className="prompt-detail__hint">
                              Runner branch: {promptRunnerState.automationBranch}
                            </p>
                            <p className="prompt-detail__hint">
                              Worktrees: {promptRunnerState.worktreeRoot}
                            </p>
                            {promptRunnerState.activePromptId ? (
                              <p className="prompt-detail__hint">
                                Active prompt: #{promptRunnerState.activePromptId.slice(0, 8)}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {selectedPromptRecovery ? (
                          <p className="prompt-detail__recovery">{selectedPromptRecovery}</p>
                        ) : null}

                        {selectedPromptFailure?.message ? (
                          <p className="prompt-detail__error">{selectedPromptFailure.message}</p>
                        ) : null}

                        {selectedPromptTransitions.length ? (
                          <div className="prompt-detail__timeline">
                            {selectedPromptTransitions.slice(0, 6).map((transition) => (
                              <div
                                className="prompt-detail__step"
                                key={`${transition.status}-${transition.at}`}
                              >
                                <div className="prompt-detail__step-row">
                                  <span className="stat-card__label">
                                    {formatPromptStatus(transition.status as PromptStatus)}
                                  </span>
                                  <span className="prompt-item__time">
                                    {formatPromptTime(transition.at)}
                                  </span>
                                </div>
                                <p className="prompt-detail__reason">{transition.reason}</p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="prompt-detail__hint">
                            Lifecycle details will appear once the runner starts working.
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="prompt-detail__empty">
                        <p className="workspace__eyebrow">No prompt selected</p>
                        <p className="panel-copy">
                          Choose a prompt from the list to inspect its lifecycle, audit, and git
                          output.
                        </p>
                      </div>
                    )}
                  </aside>
                </div>
              ) : (
                <div className="history-surface__empty">
                  <p className="panel-copy">
                    {promptsLoading
                      ? "Loading prompt history."
                      : "No prompts match the current filter."}
                  </p>
                </div>
              )}
            </section>
          )}
        </section>

        <header className="workspace-panel workspace__footer">
          <div className="workspace__footer-primary">
            <span className="workspace__footer-label">{runtimeConfig.appTitle}</span>
            <div
              className="surface-toggle workspace__footer-toggle"
              role="tablist"
              aria-label="Workspace view"
            >
              {workspaceSurfaces.map((surface) => (
                <button
                  key={surface.id}
                  type="button"
                  className="surface-toggle__button"
                  data-active={activeSurface === surface.id}
                  onClick={() => setActiveSurface(surface.id)}
                >
                  {surface.label}
                </button>
              ))}
            </div>
          </div>

          <div className="workspace__footer-items">
            <a
              className="workspace__footer-note workspace__repo-link"
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span>{repoLabel}</span>
              <GitHubMark />
            </a>
            <button
              type="button"
              className="workspace__footer-note workspace__runner-toggle"
              onClick={handleTogglePromptRunner}
              disabled={!promptRunnerState || promptActionLoading}
              aria-label={promptRunnerState?.paused ? "Resume runner" : "Pause runner"}
              title={promptRunnerState?.paused ? "Resume runner" : "Pause runner"}
            >
              {promptRunnerState?.paused ? <PlayMark /> : <PauseMark />}
            </button>
            <div
              className="workspace__footer-menu"
              data-open={themeMenuOpen}
              ref={themeMenuRef}
            >
              <button
                type="button"
                className="workspace__footer-note workspace__footer-menu-trigger"
                aria-expanded={themeMenuOpen}
                aria-haspopup="menu"
                onClick={() => setThemeMenuOpen((current) => !current)}
              >
                <span>Theme</span>
                <span className="workspace__footer-menu-caret" aria-hidden="true" />
              </button>
              <div
                className="workspace__footer-menu-content"
                hidden={!themeMenuOpen}
              >
                <ThemeToggle onSelect={() => setThemeMenuOpen(false)} />
              </div>
            </div>
            <span className={`workspace__footer-note ${runnerStatusTone}`.trim()}>
              {runnerStatusLabel}
            </span>
            <span className={`workspace__footer-note ${getRealtimeConnectionTone(realtimeConnectionStatus)}`.trim()}>
              {formatRealtimeConnectionStatus(realtimeConnectionStatus)}
            </span>
          </div>
        </header>
      </div>
    </main>
  );
}
