"use client";

import { useMutation, useQuery, useSubscription } from "@apollo/client";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { RetroLcd, useRetroLcdController } from "react-retro-lcd";
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
  PROMPT_ZEN_TYPING_DELETE_MS,
  PROMPT_ZEN_TYPING_END_PAUSE_MS,
  PROMPT_ZEN_TYPING_MAX_MS,
  PROMPT_ZEN_TYPING_MIN_MS,
  PROMPT_ZEN_TYPING_START_PAUSE_MS,
  PROMPT_ZEN_TERMINAL_COMPLETE_DELAY_MS,
  PROMPT_ZEN_TERMINAL_LINE_PAUSE_MS,
  PROMPT_ZEN_TERMINAL_TRANSITION_DELAY_MS,
  PROMPT_ZEN_TERMINAL_TYPING_MS,
  PROMPT_ZEN_TERMINAL_WORKING_TICK_MS
} from "./prompt-zen.constants";
import {
  getCanvasGraphPromptRefreshToken,
  getPromptTouchedNotePaths
} from "./canvas-graph-prompt-context";
import {
  buildPromptTerminalBuffer,
  buildPromptTerminalEntries,
  buildPromptTerminalWorkingEntry,
  getNextTypedTerminalEntries,
  getPromptExecutionAttempts,
  getPromptFailureDetails,
  getPromptGitSummary,
  getPromptRunnerGitContext,
  getPromptTransitions,
  getPromptWorkerContext,
  terminalWorkingStatuses,
  type PromptTerminalEntry
} from "./prompt-terminal";
import { CanvasGraphTab } from "./canvas-graph-tab";
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
type WorkspaceSurface = "prompt" | "history" | "graph";

type PromptTerminalSession = {
  promptId: string;
  content: string;
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
  { id: "history", label: "Prompt history" },
  { id: "graph", label: "Canvas graph" }
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

const getPromptRecoveryNote = (prompt: PromptRecord) => {
  const recovery = readRecord(prompt.metadata.recovery);
  return readString(recovery?.note);
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
  const promptPlaceholderQuestionIndexRef = useRef(0);
  const promptTerminalController = useRetroLcdController({ cursorMode: "hollow" });
  const [promptInput, setPromptInput] = useState("");
  const [animatedPromptText, setAnimatedPromptText] = useState("");
  const [promptInputFocused, setPromptInputFocused] = useState(false);
  const [promptTerminalSession, setPromptTerminalSession] =
    useState<PromptTerminalSession | null>(null);
  const [typedPromptTerminalEntries, setTypedPromptTerminalEntries] = useState<
    PromptTerminalEntry[]
  >([]);
  const [promptTerminalWorkingDots, setPromptTerminalWorkingDots] = useState(1);
  const [promptTerminalHasOverflow, setPromptTerminalHasOverflow] = useState(false);
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

  const [createPromptMutation] = useMutation<CreatePromptResponse, CreatePromptVariables>(
    CREATE_PROMPT_MUTATION
  );
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
  const selectedPromptRunnerGit = selectedPrompt ? getPromptRunnerGitContext(selectedPrompt) : null;
  const selectedPromptWorker = selectedPrompt ? getPromptWorkerContext(selectedPrompt) : null;
  const selectedPromptExecutions = selectedPrompt
    ? getPromptExecutionAttempts(selectedPrompt)
    : [];
  const latestSelectedTransition = selectedPrompt ? getLatestPromptTransition(selectedPrompt) : null;
  const promptTerminalPrompt = promptTerminalSession
    ? recentPrompts.find((prompt) => prompt.id === promptTerminalSession.promptId) || null
    : null;
  const promptTerminalTargetEntries = promptTerminalSession
    ? buildPromptTerminalEntries(promptTerminalPrompt)
    : [];
  const promptActionLoading =
    cancelPromptLoading ||
    retryPromptLoading ||
    pausePromptRunnerLoading ||
    resumePromptRunnerLoading;
  const promptTerminalCurrentTarget =
    typedPromptTerminalEntries.length > 0
      ? promptTerminalTargetEntries[typedPromptTerminalEntries.length - 1] || null
      : null;
  const promptTerminalCurrentTyped =
    typedPromptTerminalEntries[typedPromptTerminalEntries.length - 1] || null;
  const promptTerminalTypingEntryId =
    promptTerminalCurrentTarget &&
    promptTerminalCurrentTyped &&
    promptTerminalCurrentTarget.id === promptTerminalCurrentTyped.id &&
    promptTerminalCurrentTyped.text.length < promptTerminalCurrentTarget.text.length
      ? promptTerminalCurrentTyped.id
      : null;
  const promptTerminalShouldShowWorking =
    Boolean(
      promptTerminalPrompt &&
        terminalWorkingStatuses.has(promptTerminalPrompt.status)
    );
  const promptTerminalWorkingEntry = promptTerminalShouldShowWorking
    ? buildPromptTerminalWorkingEntry(promptTerminalPrompt, promptTerminalWorkingDots)
    : null;
  const promptTerminalCursorVisible = Boolean(
    promptTerminalSession &&
      (promptTerminalTypingEntryId ||
        typedPromptTerminalEntries.length < promptTerminalTargetEntries.length ||
        promptTerminalShouldShowWorking)
  );
  const promptTerminalStatusCount = typedPromptTerminalEntries.filter(
    (entry) => entry.kind === "status" || entry.kind === "failure" || entry.kind === "git"
  ).length;
  const promptTerminalEntries = promptTerminalSession
    ? [
        ...typedPromptTerminalEntries,
        ...(promptTerminalWorkingEntry ? [promptTerminalWorkingEntry] : [])
      ]
    : [];
  const promptTerminalBuffer = promptTerminalSession
    ? buildPromptTerminalBuffer(promptTerminalSession.content, promptTerminalEntries)
    : "";
  const canvasGraphRefreshToken = useMemo(
    () => getCanvasGraphPromptRefreshToken(recentPrompts),
    [recentPrompts]
  );
  const selectedPromptTouchedNotePaths = useMemo(
    () => getPromptTouchedNotePaths(selectedPrompt),
    [selectedPrompt]
  );
  const selectedPromptGraphLabel =
    selectedPromptTouchedNotePaths.length > 0 && selectedPrompt
      ? `#${selectedPrompt.id.slice(0, 8)}`
      : null;
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
    if (!promptTerminalSession) {
      setTypedPromptTerminalEntries([]);
      setPromptTerminalWorkingDots(1);
      setPromptTerminalHasOverflow(false);
      return;
    }

    setTypedPromptTerminalEntries([]);
    setPromptTerminalWorkingDots(1);
  }, [promptTerminalSession]);

  useEffect(() => {
    if (!promptTerminalSession) {
      return;
    }

    const nextStep = getNextTypedTerminalEntries(
      typedPromptTerminalEntries,
      promptTerminalTargetEntries,
      PROMPT_ZEN_TERMINAL_TYPING_MS,
      PROMPT_ZEN_TERMINAL_LINE_PAUSE_MS
    );

    if (!nextStep) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setTypedPromptTerminalEntries(nextStep.entries);
    }, nextStep.delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [promptTerminalSession, promptTerminalTargetEntries, typedPromptTerminalEntries]);

  useEffect(() => {
    if (!promptTerminalShouldShowWorking) {
      setPromptTerminalWorkingDots(1);
      return;
    }

    const intervalId = window.setInterval(() => {
      setPromptTerminalWorkingDots((current) => (current >= 3 ? 1 : current + 1));
    }, PROMPT_ZEN_TERMINAL_WORKING_TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [promptTerminalShouldShowWorking, promptTerminalPrompt?.id, promptTerminalPrompt?.status]);

  useEffect(() => {
    promptTerminalController.reset();
    promptTerminalController.setCursorMode("hollow");

    if (!promptTerminalSession) {
      promptTerminalController.setCursorVisible(false);
      setPromptTerminalHasOverflow(false);
      return;
    }

    promptTerminalController.write(promptTerminalBuffer);
    promptTerminalController.setCursorVisible(promptTerminalCursorVisible);
    setPromptTerminalHasOverflow(promptTerminalController.getSnapshot().scrollback.length > 0);
  }, [
    promptTerminalBuffer,
    promptTerminalController,
    promptTerminalCursorVisible,
    promptTerminalSession
  ]);

  useEffect(() => {
    if (
      !promptTerminalSession ||
      activeSurface !== "prompt" ||
      !promptTerminalHasOverflow ||
      promptTerminalStatusCount < 2 ||
      !promptTerminalPrompt ||
      activePromptStatuses.has(promptTerminalPrompt.status)
    ) {
      return;
    }

    const transitionDelay = PROMPT_ZEN_TERMINAL_COMPLETE_DELAY_MS;

    const timeoutId = window.setTimeout(() => {
      setHistoryFilter(
        promptTerminalPrompt.status === "completed"
          ? "completed"
          : promptTerminalPrompt.status === "failed"
            ? "failed"
            : promptTerminalPrompt.status === "cancelled"
              ? "cancelled"
              : "active"
      );
      setActiveSurface("history");
      setTypedPromptTerminalEntries([]);
      setPromptTerminalSession(null);
      setPromptTerminalWorkingDots(1);
    }, transitionDelay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeSurface,
    promptTerminalHasOverflow,
    promptTerminalPrompt,
    promptTerminalSession,
    promptTerminalStatusCount
  ]);

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
    if (
      activeSurface !== "prompt" ||
      promptInputFocused ||
      promptInput.length > 0 ||
      promptTerminalSession
    ) {
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
  }, [activeSurface, promptInput.length, promptInputFocused, promptTerminalSession]);

  const submitPrompt = async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content) {
      const message = "Enter a prompt before queueing a run.";
      setStatusLabel(message);
      return;
    }

    setStatusLabel("Queueing prompt.");

    try {
      const result = await createPromptMutation({
        variables: {
          input: { content }
        }
      });

      const createdPrompt = result.data?.createPrompt;

      setPromptInput("");
      setPromptInputFocused(false);
      setTypedPromptTerminalEntries([]);
      setPromptTerminalWorkingDots(1);
      if (createdPrompt) {
        setSelectedPromptId(createdPrompt.id);
        setPromptTerminalSession({
          promptId: createdPrompt.id,
          content: createdPrompt.content
        });
      }
      setHistoryFilter("active");
      setActiveSurface("prompt");
      setStatusLabel(
        createdPrompt
          ? `Queued prompt ${createdPrompt.id.slice(0, 8)}.`
          : "Queued prompt."
      );
      await refetchPrompts();
    } catch (mutationError) {
      const message =
        mutationError instanceof Error ? mutationError.message : "Failed to queue prompt.";
      setStatusLabel(message);
    }
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
        setTypedPromptTerminalEntries([]);
        setPromptTerminalWorkingDots(1);
        setPromptTerminalSession({
          promptId: retriedPrompt.id,
          content: retriedPrompt.content
        });
      }
      setHistoryFilter("active");
      setActiveSurface(retriedPrompt ? "prompt" : activeSurface);
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
    <main className={`workspace workspace--${activeSurface}`}>
      <div className="workspace__shell">
        {promptsError ? (
          <div className="workspace-panel workspace__banner" role="status">
            Prompt state unavailable: {promptsError.message}
          </div>
        ) : null}

        <section className={`workspace__content workspace__content--${activeSurface}`}>
          {activeSurface === "prompt" ? (
            <div className="prompt-zen">
              <div
                className="prompt-zen__frame"
                data-mode={promptTerminalSession ? "terminal" : "compose"}
                data-testid="prompt-zen-form"
              >
                {promptTerminalSession ? (
                  <div
                    className="prompt-zen__terminal-shell"
                    data-testid="prompt-terminal"
                    data-overflow={promptTerminalHasOverflow ? "true" : "false"}
                  >
                    <RetroLcd
                      mode="terminal"
                      controller={promptTerminalController}
                      cursorMode="hollow"
                      color="#97ff9b"
                      className="prompt-zen__lcd prompt-zen__lcd--terminal"
                    />
                    <div className="sr-only" data-testid="prompt-terminal-user">
                      {promptTerminalSession.content}
                    </div>
                    <div className="sr-only" data-testid="prompt-terminal-content">
                      {promptTerminalBuffer.replace(/\u001b\[[0-9;]*m/gu, "")}
                    </div>
                    <div
                      className="sr-only"
                      data-testid="prompt-terminal-working"
                      aria-hidden={promptTerminalShouldShowWorking ? undefined : true}
                    >
                      {promptTerminalWorkingEntry?.text || ""}
                    </div>
                  </div>
                ) : (
                  <RetroLcd
                    mode="value"
                    value={promptInput}
                    editable
                    placeholder={animatedPromptText}
                    cursorMode="solid"
                    color="#97ff9b"
                    className="prompt-zen__lcd"
                    onChange={setPromptInput}
                    onSubmit={submitPrompt}
                    onFocusChange={setPromptInputFocused}
                  />
                )}
              </div>
            </div>
          ) : activeSurface === "history" ? (
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

                        {(selectedPromptRunnerGit?.repository ||
                          selectedPromptRunnerGit?.branch ||
                          selectedPromptGit?.branch ||
                          selectedPromptGit?.sha) && (
                          <div className="prompt-detail__runner">
                            {selectedPromptRunnerGit?.repository ? (
                              <p className="prompt-detail__hint">
                                Working repo: {selectedPromptRunnerGit.repository}
                              </p>
                            ) : null}
                            {selectedPromptRunnerGit?.branch ? (
                              <p className="prompt-detail__hint">
                                Working branch: {selectedPromptRunnerGit.branch}
                              </p>
                            ) : null}
                            {(selectedPromptGit?.branch || selectedPromptGit?.sha) && (
                              <p className="prompt-detail__hint">
                                Last git result: {selectedPromptGit.branch || "unknown branch"}
                                {selectedPromptGit.sha
                                  ? ` @ ${selectedPromptGit.sha.slice(0, 8)}`
                                  : ""}
                              </p>
                            )}
                          </div>
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

                        {selectedPromptWorker &&
                        (selectedPromptWorker.jobName ||
                          selectedPromptWorker.podName ||
                          selectedPromptWorker.workerNode ||
                          selectedPromptWorker.attempt) ? (
                          <div className="prompt-detail__runner">
                            {selectedPromptWorker.attempt ? (
                              <p className="prompt-detail__hint">
                                Worker attempt: {selectedPromptWorker.attempt}
                              </p>
                            ) : null}
                            {selectedPromptWorker.jobName ? (
                              <p className="prompt-detail__hint">
                                Worker job: {selectedPromptWorker.jobName}
                              </p>
                            ) : null}
                            {selectedPromptWorker.podName ? (
                              <p className="prompt-detail__hint">
                                Worker pod:{" "}
                                {selectedPromptWorker.namespace
                                  ? `${selectedPromptWorker.namespace}/`
                                  : ""}
                                {selectedPromptWorker.podName}
                              </p>
                            ) : null}
                            {selectedPromptWorker.workerNode ? (
                              <p className="prompt-detail__hint">
                                Worker node: {selectedPromptWorker.workerNode}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {selectedPromptWorker?.logTail ? (
                          <div className="prompt-detail__log">
                            <div className="prompt-detail__step-row">
                              <span className="stat-card__label">Recent pod logs</span>
                              <span className="prompt-item__time">
                                {selectedPromptWorker.latestExecution?.updatedAt
                                  ? formatPromptTime(selectedPromptWorker.latestExecution.updatedAt)
                                  : "Observed"}
                              </span>
                            </div>
                            <pre className="prompt-detail__log-text">
                              {selectedPromptWorker.logTail}
                            </pre>
                          </div>
                        ) : null}

                        {selectedPromptRunnerGit?.operations.length ? (
                          <div className="prompt-detail__timeline">
                            {selectedPromptRunnerGit.operations.map((operation, index) => (
                              <div
                                className="prompt-detail__step"
                                key={`${operation.command}-${operation.at || index}`}
                              >
                                <div className="prompt-detail__step-row">
                                  <span className="stat-card__label">Git operation</span>
                                  <span className="prompt-item__time">
                                    {operation.at ? formatPromptTime(operation.at) : "Recorded"}
                                  </span>
                                </div>
                                {operation.repoRoot ? (
                                  <p className="prompt-detail__hint">
                                    Repo root: {operation.repoRoot}
                                  </p>
                                ) : null}
                                <p className="prompt-detail__git-command">{operation.command}</p>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {selectedPromptExecutions.length ? (
                          <div className="prompt-detail__timeline">
                            {selectedPromptExecutions.map((execution) => (
                              <div
                                className="prompt-detail__step"
                                key={execution.id}
                              >
                                <div className="prompt-detail__step-row">
                                  <span className="stat-card__label">
                                    Attempt {execution.attempt}
                                  </span>
                                  <span className="prompt-item__time">
                                    {execution.startedAt
                                      ? formatPromptTime(execution.startedAt)
                                      : formatPromptTime(execution.createdAt)}
                                  </span>
                                </div>
                                <p className="prompt-detail__hint">
                                  Status: {execution.status}
                                  {execution.executionMode
                                    ? ` · mode ${execution.executionMode}`
                                    : ""}
                                </p>
                                {execution.jobName ? (
                                  <p className="prompt-detail__hint">
                                    Job: {execution.jobName}
                                  </p>
                                ) : null}
                                {execution.podName ? (
                                  <p className="prompt-detail__hint">
                                    Pod: {execution.namespace ? `${execution.namespace}/` : ""}
                                    {execution.podName}
                                  </p>
                                ) : null}
                                {execution.workerNode ? (
                                  <p className="prompt-detail__hint">
                                    Node: {execution.workerNode}
                                  </p>
                                ) : null}
                                {execution.exitCode !== null ? (
                                  <p className="prompt-detail__hint">
                                    Exit code: {execution.exitCode}
                                  </p>
                                ) : null}
                                {execution.errorMessage ? (
                                  <p className="prompt-detail__reason">
                                    {execution.errorMessage}
                                  </p>
                                ) : null}
                              </div>
                            ))}
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
          ) : (
            <CanvasGraphTab
              highlightedNotePaths={selectedPromptTouchedNotePaths}
              highlightedPromptLabel={selectedPromptGraphLabel}
              refreshToken={canvasGraphRefreshToken}
            />
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
            <span className={`workspace__footer-note ${runnerStatusTone}`.trim()}>
              {runnerStatusLabel}
            </span>
            <span
              className={`workspace__footer-note workspace__socket-status ${getRealtimeConnectionTone(realtimeConnectionStatus)}`.trim()}
              aria-label={formatRealtimeConnectionStatus(realtimeConnectionStatus)}
              title={formatRealtimeConnectionStatus(realtimeConnectionStatus)}
            >
              <span className="workspace__socket-status-dot" aria-hidden="true" />
              <span className="workspace__socket-status-text">
                {formatRealtimeConnectionStatus(realtimeConnectionStatus)}
              </span>
            </span>
          </div>

          <div
            className="workspace__footer-center"
            id="graph-menubar-slot"
            aria-live="polite"
          />

          <div className="workspace__footer-utilities">
            <a
              className="workspace__footer-note workspace__repo-link"
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span>{repoLabel}</span>
              <GitHubMark />
            </a>
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
          </div>
        </header>
      </div>
    </main>
  );
}
