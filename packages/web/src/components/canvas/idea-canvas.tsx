"use client";

import { useMutation, useQuery } from "@apollo/client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  CANVAS_BOOTSTRAP_QUERY,
  CANCEL_PROMPT_MUTATION,
  CREATE_PROMPT_MUTATION,
  MOVE_IDEA_MUTATION,
  PAUSE_PROMPT_RUNNER_MUTATION,
  PROMPTS_QUERY,
  RESUME_PROMPT_RUNNER_MUTATION,
  RETRY_PROMPT_MUTATION,
  type GraphSnapshot,
  type IdeaNode,
  type PromptRecord,
  type PromptRunnerStateRecord,
  type PromptStatus,
  type RuntimeConfigShape
} from "../../lib/graphql";
import { readRuntimeConfig } from "../../lib/runtime-config";
import { ThemeToggle } from "../ui/theme-toggle";

type BootstrapResponse = {
  runtimeConfig: RuntimeConfigShape;
  graphSnapshot: GraphSnapshot;
};

type MoveIdeaResponse = {
  moveIdea: {
    id: string;
    x: number;
    y: number;
    updatedAt: string;
  };
};

type MoveIdeaVariables = {
  input: {
    id: string;
    x: number;
    y: number;
  };
};

type PromptsResponse = {
  promptRunnerState: PromptRunnerStateRecord;
  prompts: PromptRecord[];
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
type WorkspaceSurface = "prompt" | "history" | "field";

type PromptTransitionRecord = {
  status: string;
  reason: string;
  at: string;
};

type Viewport = {
  x: number;
  y: number;
  scale: number;
};

type SurfaceInsets = {
  top: number;
  bottom: number;
};

type Interaction =
  | {
      type: "pan";
      pointerId: number;
      start: { x: number; y: number };
      origin: Viewport;
    }
  | {
      type: "drag-node";
      pointerId: number;
      nodeId: string;
      startWorld: { x: number; y: number };
      nodeOrigin: { x: number; y: number };
      moved: boolean;
    };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const PROMPTS_POLL_INTERVAL_MS = 5_000;
const RECENT_PROMPTS_LIMIT = 14;
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
  { id: "field", label: "Constellation field" }
];

const getClusterColor = (cluster: string) => {
  if (typeof window === "undefined") {
    return "#ffffff";
  }

  const styles = getComputedStyle(document.documentElement);

  switch (cluster) {
    case "signal":
      return styles.getPropertyValue("--signal").trim() || "#ff8c39";
    case "analysis":
      return styles.getPropertyValue("--analysis").trim() || "#61f4de";
    case "narrative":
      return styles.getPropertyValue("--narrative").trim() || "#9f8cff";
    case "action":
      return styles.getPropertyValue("--action").trim() || "#ffe27a";
    default:
      return styles.getPropertyValue("--accent").trim() || "#ff8c39";
  }
};

const getCssVar = (name: string, fallback: string) => {
  if (typeof window === "undefined") {
    return fallback;
  }

  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};

const formatPromptStatus = (status: PromptStatus) =>
  status.replace(/_/g, " ");

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

const canCancelPrompt = (prompt: PromptRecord | null) => prompt?.status === "queued";

const canRetryPrompt = (prompt: PromptRecord | null) =>
  prompt?.status === "failed" || prompt?.status === "cancelled";

const wrapText = (
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
) => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (context.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
      continue;
    }

    current = next;
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 3);
};

export function IdeaCanvas() {
  const runtimeConfig = readRuntimeConfig();
  const containerRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphSnapshot | null>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const interactionRef = useRef<Interaction | null>(null);
  const didCenterRef = useRef(false);
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [selectedIdeaId, setSelectedIdeaId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Hydrating runtime config");
  const [promptInput, setPromptInput] = useState("");
  const [promptSubmitError, setPromptSubmitError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<PromptHistoryFilter>("all");
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>("prompt");
  const [historyInsets, setHistoryInsets] = useState<SurfaceInsets>({
    top: 220,
    bottom: 92
  });

  const { data, loading, error, refetch } = useQuery<BootstrapResponse>(CANVAS_BOOTSTRAP_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const [moveIdeaMutation] = useMutation<MoveIdeaResponse, MoveIdeaVariables>(MOVE_IDEA_MUTATION);
  const {
    data: promptsData,
    loading: promptsLoading,
    error: promptsError,
    refetch: refetchPrompts
  } = useQuery<PromptsResponse>(PROMPTS_QUERY, {
    variables: { limit: RECENT_PROMPTS_LIMIT },
    fetchPolicy: "cache-and-network",
    pollInterval: PROMPTS_POLL_INTERVAL_MS
  });
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

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    if (!data?.graphSnapshot) {
      return;
    }

    setGraph(data.graphSnapshot);
    graphRef.current = data.graphSnapshot;
    setSelectedIdeaId((current) => current || data.graphSnapshot.ideas[0]?.id || null);
    setStatusLabel("Live data from GraphQL + Postgres");
  }, [data]);

  useEffect(() => {
    if (!graph || !containerRef.current || didCenterRef.current) {
      return;
    }

    const bounds = containerRef.current.getBoundingClientRect();
    const next = fitGraphToViewport(graph, bounds.width, bounds.height);
    setViewport(next);
    viewportRef.current = next;
    didCenterRef.current = true;
  }, [graph]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;

    if (!canvas || !container) {
      return;
    }

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * ratio);
      canvas.height = Math.floor(rect.height * ratio);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      drawGraph(canvas, graphRef.current, viewportRef.current, selectedIdeaId);
    };

    resize();

    const observer = new ResizeObserver(() => resize());
    observer.observe(container);

    return () => observer.disconnect();
  }, [selectedIdeaId]);

  useEffect(() => {
    const container = containerRef.current;
    const brand = brandRef.current;
    const controls = controlsRef.current;
    const footer = footerRef.current;

    if (!container || !brand || !controls || !footer) {
      return;
    }

    const updateInsets = () => {
      const containerRect = container.getBoundingClientRect();
      const brandRect = brand.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();

      const nextTop =
        Math.max(brandRect.bottom, controlsRect.bottom) - containerRect.top + 20;
      const nextBottom = containerRect.bottom - footerRect.top + 16;

      setHistoryInsets((current) => {
        const roundedTop = Math.max(160, Math.round(nextTop));
        const roundedBottom = Math.max(72, Math.round(nextBottom));

        if (
          current.top === roundedTop &&
          current.bottom === roundedBottom
        ) {
          return current;
        }

        return {
          top: roundedTop,
          bottom: roundedBottom
        };
      });
    };

    updateInsets();

    const observer = new ResizeObserver(() => updateInsets());
    observer.observe(container);
    observer.observe(brand);
    observer.observe(controls);
    observer.observe(footer);
    window.addEventListener("resize", updateInsets);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateInsets);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    drawGraph(canvas, graph, viewport, selectedIdeaId);
  }, [graph, selectedIdeaId, viewport]);

  const selectedIdea =
    graph?.ideas.find((idea) => idea.id === selectedIdeaId) || graph?.ideas[0] || null;
  const recentPrompts = promptsData?.prompts || [];
  const promptRunnerState = promptsData?.promptRunnerState || null;
  const filteredPrompts = recentPrompts.filter((prompt) =>
    matchesPromptHistoryFilter(prompt, historyFilter)
  );
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

  const selectedConnections = graph?.connections.filter(
    (connection) =>
      connection.sourceId === selectedIdea?.id || connection.targetId === selectedIdea?.id
  ) || [];

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

  const selectedPrompt =
    filteredPrompts.find((prompt) => prompt.id === selectedPromptId) || filteredPrompts[0] || null;
  const selectedPromptTransitions = selectedPrompt ? getPromptTransitions(selectedPrompt) : [];
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
  const runnerStatusTone = promptRunnerState?.paused
    ? "prompt-status--cancelled"
    : promptRunnerState?.inFlight
      ? "prompt-status--writing"
      : "prompt-status--completed";
  const runnerStatusLabel = promptRunnerState?.paused
    ? "Runner paused"
    : promptRunnerState?.inFlight
      ? "Runner active"
      : "Runner ready";
  const renderPromptHistoryPanel = () => (
    <div className="glass-panel">
      <div className="panel-content prompt-list">
        <div className="prompt-list__header">
          <div>
            <p className="eyebrow">Prompt history</p>
            <p className="prompt-panel__subtitle">
              Inspect queue health, recovery notes, and recent run outcomes.
            </p>
          </div>
          <div className="prompt-list__header-meta">
            <span className="prompt-list__meta">
              {promptsLoading && !recentPrompts.length
                ? "Loading..."
                : `${recentPrompts.length} loaded`}
            </span>
            {promptRunnerState ? (
              <span className={`prompt-status ${runnerStatusTone}`}>
                {runnerStatusLabel}
              </span>
            ) : null}
          </div>
        </div>

        {promptsError ? (
          <p className="prompt-list__empty">
            Prompt status unavailable: {promptsError.message}
          </p>
        ) : recentPrompts.length ? (
          <>
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

            <div className="prompt-history__summary">
              <div className="prompt-history__summary-card">
                <span className="prompt-history__summary-label">Active</span>
                <strong>{promptCounts.active}</strong>
              </div>
              <div className="prompt-history__summary-card">
                <span className="prompt-history__summary-label">Queued</span>
                <strong>{promptCounts.queued}</strong>
              </div>
              <div className="prompt-history__summary-card">
                <span className="prompt-history__summary-label">Completed</span>
                <strong>{promptCounts.completed}</strong>
              </div>
              <div className="prompt-history__summary-card">
                <span className="prompt-history__summary-label">Failed</span>
                <strong>{promptCounts.failed}</strong>
              </div>
              <div className="prompt-history__summary-card">
                <span className="prompt-history__summary-label">Cancelled</span>
                <strong>{promptCounts.cancelled}</strong>
              </div>
            </div>

            {filteredPrompts.length ? (
              <div className="prompt-history__grid">
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

                {selectedPrompt ? (
                  <aside className="prompt-detail">
                    <div className="prompt-detail__header">
                      <div>
                        <p className="eyebrow">Selected prompt</p>
                        <h3>#{selectedPrompt.id.slice(0, 8)}</h3>
                      </div>
                      <span className={`prompt-status prompt-status--${selectedPrompt.status}`}>
                        {formatPromptStatus(selectedPrompt.status)}
                      </span>
                    </div>

                    <p className="prompt-detail__content">{selectedPrompt.content}</p>

                    <div className="prompt-detail__actions">
                      <button
                        type="button"
                        onClick={handleTogglePromptRunner}
                        disabled={!promptRunnerState || promptActionLoading}
                      >
                        {promptRunnerState?.paused ? "Resume runner" : "Pause runner"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelPrompt}
                        disabled={!canCancelPrompt(selectedPrompt) || promptActionLoading}
                      >
                        Cancel prompt
                      </button>
                      <button
                        type="button"
                        onClick={handleRetryPrompt}
                        disabled={!canRetryPrompt(selectedPrompt) || promptActionLoading}
                      >
                        Retry prompt
                      </button>
                    </div>

                    <div className="prompt-detail__stats">
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Submitted</span>
                        <span className="prompt-detail__value">
                          {formatPromptTime(selectedPrompt.createdAt)}
                        </span>
                      </div>
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Started</span>
                        <span className="prompt-detail__value">
                          {selectedPrompt.startedAt
                            ? formatPromptTime(selectedPrompt.startedAt)
                            : "Not started"}
                        </span>
                      </div>
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Finished</span>
                        <span className="prompt-detail__value">
                          {selectedPrompt.finishedAt
                            ? formatPromptTime(selectedPrompt.finishedAt)
                            : "In progress"}
                        </span>
                      </div>
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Duration</span>
                        <span className="prompt-detail__value">
                          {formatPromptDuration(selectedPrompt)}
                        </span>
                      </div>
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Latest stage</span>
                        <span className="prompt-detail__value">
                          {selectedPromptFailure?.stage ||
                            latestSelectedTransition?.status ||
                            "Queued"}
                        </span>
                      </div>
                      <div className="prompt-detail__stat">
                        <span className="prompt-detail__label">Repo impact</span>
                        <span className="prompt-detail__value">
                          {selectedPromptAudit?.summary || "No repo changes recorded"}
                        </span>
                      </div>
                    </div>

                    {selectedPromptGit?.branch || selectedPromptGit?.sha ? (
                      <p className="prompt-detail__hint">
                        Git: {selectedPromptGit.branch || "unknown branch"}
                        {selectedPromptGit.sha ? ` @ ${selectedPromptGit.sha.slice(0, 8)}` : ""}
                      </p>
                    ) : null}

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
                        {selectedPromptTransitions.slice(-5).map((transition) => (
                          <div
                            className="prompt-detail__step"
                            key={`${transition.status}-${transition.at}`}
                          >
                            <div className="prompt-detail__step-row">
                              <span className="prompt-detail__label">
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
                        Lifecycle details will appear here once the runner starts processing.
                      </p>
                    )}
                  </aside>
                ) : null}
              </div>
            ) : (
              <p className="prompt-list__empty">No prompts match the current filter.</p>
            )}
          </>
        ) : (
          <p className="prompt-list__empty">
            No prompts queued yet. The next submitted idea will appear here.
          </p>
        )}
      </div>
    </div>
  );

  const syncNodePosition = async (ideaId: string) => {
    const idea = graphRef.current?.ideas.find((item) => item.id === ideaId);

    if (!idea) {
      return;
    }

    try {
      await moveIdeaMutation({
        variables: {
          input: {
            id: idea.id,
            x: Number(idea.x.toFixed(2)),
            y: Number(idea.y.toFixed(2))
          }
        }
      });
      setStatusLabel(`Synced ${idea.title}`);
    } catch (_error) {
      setStatusLabel("Position sync failed");
    }
  };

  const resetView = () => {
    if (!graph || !containerRef.current) {
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const next = fitGraphToViewport(graph, rect.width, rect.height);
    setViewport(next);
    viewportRef.current = next;
    drawGraph(canvasRef.current, graphRef.current, next, selectedIdeaId);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = getPointerPoint(event);
    const currentGraph = graphRef.current;
    const currentViewport = viewportRef.current;

    if (!currentGraph) {
      return;
    }

    const hit = findIdeaAtPoint(currentGraph.ideas, point, currentViewport);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (hit) {
      const worldPoint = screenToWorld(point, currentViewport);
      interactionRef.current = {
        type: "drag-node",
        pointerId: event.pointerId,
        nodeId: hit.id,
        startWorld: worldPoint,
        nodeOrigin: { x: hit.x, y: hit.y },
        moved: false
      };
      setSelectedIdeaId(hit.id);
      setDragging(true);
      return;
    }

    interactionRef.current = {
      type: "pan",
      pointerId: event.pointerId,
      start: point,
      origin: currentViewport
    };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const point = getPointerPoint(event);

    if (interaction.type === "pan") {
      const next = {
        ...interaction.origin,
        x: interaction.origin.x + point.x - interaction.start.x,
        y: interaction.origin.y + point.y - interaction.start.y
      };
      setViewport(next);
      viewportRef.current = next;
      return;
    }

    const world = screenToWorld(point, viewportRef.current);
    const nextX = interaction.nodeOrigin.x + (world.x - interaction.startWorld.x);
    const nextY = interaction.nodeOrigin.y + (world.y - interaction.startWorld.y);
    interaction.moved = true;

    setGraph((current) => {
      if (!current) {
        return current;
      }

      const ideas = current.ideas.map((idea) =>
        idea.id === interaction.nodeId ? { ...idea, x: nextX, y: nextY } : idea
      );
      const next = { ...current, ideas };
      graphRef.current = next;
      return next;
    });
  };

  const handlePointerUp = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    interactionRef.current = null;
    setDragging(false);

    if (interaction.type === "drag-node" && interaction.moved) {
      await syncNodePosition(interaction.nodeId);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();

    const point = getPointerPoint(event);
    const current = viewportRef.current;
    const worldBefore = screenToWorld(point, current);
    const scaleDelta = event.deltaY > 0 ? 0.92 : 1.08;
    const nextScale = clamp(current.scale * scaleDelta, 0.35, 2.4);
    const next = {
      scale: nextScale,
      x: point.x - worldBefore.x * nextScale,
      y: point.y - worldBefore.y * nextScale
    };

    setViewport(next);
    viewportRef.current = next;
  };

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const content = promptInput.trim();

    if (!content) {
      setPromptSubmitError("Enter a prompt before queueing a run.");
      return;
    }

    setPromptSubmitError(null);

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
          ? `Queued prompt ${createdPrompt.id.slice(0, 8)}`
          : "Queued prompt"
      );
      await refetchPrompts();
    } catch (mutationError) {
      setPromptSubmitError(
        mutationError instanceof Error ? mutationError.message : "Failed to queue prompt."
      );
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
          ? `Cancelled prompt ${result.data.cancelPrompt.id.slice(0, 8)}`
          : "Cancelled prompt"
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
      setStatusLabel(
        retriedPrompt
          ? `Re-queued prompt ${retriedPrompt.id.slice(0, 8)}`
          : "Re-queued prompt"
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
      setStatusLabel(nextState?.paused ? "Prompt runner paused" : "Prompt runner resumed");
      await refetchPrompts();
    } catch (mutationError) {
      setStatusLabel(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update prompt runner state."
      );
    }
  };

  if (loading && !graph) {
    return (
      <div className="loading-state">
        <div className="glass-panel loading-state__panel">
          <div className="panel-content">
            <p className="eyebrow">Booting canvas</p>
            <h1 className="title">Warming the field</h1>
            <p className="subtitle">
              Fetching runtime config and the initial graph snapshot from GraphQL.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-state">
        <div className="glass-panel error-state__panel">
          <div className="panel-content">
            <p className="eyebrow">Bootstrap failed</p>
            <h1 className="title">GraphQL is not reachable</h1>
            <p className="subtitle">{error.message}</p>
            <div className="toolbar" style={{ justifyContent: "flex-start", marginTop: 18 }}>
              <button type="button" onClick={() => refetch()}>
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const liveRuntime = data?.runtimeConfig || runtimeConfig;

  return (
    <main className="workspace" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="workspace__canvas"
        data-dragging={dragging}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      />

      <div className="workspace__overlay">
        <div className="workspace__brand" ref={brandRef}>
          <div className="glass-panel glass-panel--strong">
            <div className="panel-content">
              <p className="eyebrow">{liveRuntime.appTitle}</p>
              <h1 className="title">{liveRuntime.graphTitle}</h1>
              <p className="subtitle">{liveRuntime.graphSubtitle}</p>
            </div>
          </div>

          <div className="row">
            <div className="chip">
              <span className="chip__dot" />
              Runtime hydrated
            </div>
            <div className="chip">GraphQL endpoint: {liveRuntime.graphqlEndpoint}</div>
            <div className="chip">Ideas: {graph?.ideas.length || 0}</div>
            <div className="chip">Connections: {graph?.connections.length || 0}</div>
          </div>
        </div>

        {activeSurface === "prompt" ? (
          <div className="workspace__hero">
            <div className="glass-panel glass-panel--strong">
              <div className="panel-content prompt-hero">
                <div className="prompt-hero__header">
                  <div>
                    <p className="eyebrow">New prompt</p>
                    <h2 className="prompt-hero__title">Drop a thought into the store</h2>
                    <p className="prompt-hero__subtitle">
                      Start with the rough version. The agent will queue it, organize it,
                      and wire it into the repository&apos;s mind map.
                    </p>
                  </div>
                  <div className="prompt-hero__meta">
                    <span className={`prompt-status ${runnerStatusTone}`}>
                      {runnerStatusLabel}
                    </span>
                    <span className="prompt-panel__polling">
                      Polling every {PROMPTS_POLL_INTERVAL_MS / 1000}s
                    </span>
                  </div>
                </div>

                <div className="prompt-hero__summary">
                  <div className="prompt-hero__summary-card">
                    <span className="prompt-history__summary-label">Queued</span>
                    <strong>{promptCounts.queued}</strong>
                  </div>
                  <div className="prompt-hero__summary-card">
                    <span className="prompt-history__summary-label">Active</span>
                    <strong>{promptCounts.active}</strong>
                  </div>
                  <div className="prompt-hero__summary-card">
                    <span className="prompt-history__summary-label">Completed</span>
                    <strong>{promptCounts.completed}</strong>
                  </div>
                </div>

                <form className="prompt-form prompt-form--hero" onSubmit={handlePromptSubmit}>
                  <label className="sr-only" htmlFor="prompt-input">
                    New prompt
                  </label>
                  <textarea
                    id="prompt-input"
                    name="prompt"
                    rows={6}
                    value={promptInput}
                    onChange={(event) => setPromptInput(event.target.value)}
                    placeholder="Capture the random thought, contradiction, question, or half-formed idea you do not want to lose."
                  />

                  {promptSubmitError ? (
                    <p className="form-message form-message--error">{promptSubmitError}</p>
                  ) : (
                    <p className="form-message">
                      Submitted prompts are queued in order, processed in isolated worktrees,
                      and folded back into the document store.
                    </p>
                  )}

                  <div className="toolbar prompt-form__actions prompt-form__actions--hero">
                    <button
                      type="submit"
                      disabled={createPromptLoading || !promptInput.trim()}
                    >
                      {createPromptLoading ? "Queueing..." : "Queue prompt"}
                    </button>
                    <button type="button" onClick={() => setActiveSurface("history")}>
                      Open prompt history
                    </button>
                  </div>
                </form>

                <div className="prompt-hero__foot">
                  <p className="prompt-hero__hint">
                    The field stays live underneath this prompt surface. Switch to
                    <strong> Prompt history</strong> to inspect queue state, or
                    <strong> Constellation field</strong> to explore the graph directly.
                  </p>
                  {selectedPrompt ? (
                    <p className="prompt-hero__hint">
                      Latest prompt: #{selectedPrompt.id.slice(0, 8)}{" "}
                      <span className={`prompt-status prompt-status--${selectedPrompt.status}`}>
                        {formatPromptStatus(selectedPrompt.status)}
                      </span>
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeSurface === "history" ? (
          <div
            className="workspace__history"
            style={{ top: historyInsets.top, bottom: historyInsets.bottom }}
          >
            {renderPromptHistoryPanel()}
          </div>
        ) : null}

        {activeSurface === "field" ? (
          <div className="workspace__field-note">
            <div className="glass-panel">
              <div className="panel-content">
                <p className="eyebrow">Constellation field</p>
                <p className="prompt-panel__subtitle">
                  Explore the live graph, drag nodes, and inspect how ideas cluster together.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="workspace__controls" ref={controlsRef}>
          <div className="glass-panel">
            <div className="panel-content">
              <p className="eyebrow">Surface</p>
              <div className="surface-toggle" role="tablist" aria-label="Workspace surface">
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
          </div>

          <div className="glass-panel">
            <div className="panel-content">
              <div className="toolbar">
                <button type="button" onClick={resetView}>
                  Reset view
                </button>
                <button type="button" onClick={() => refetch()}>
                  Refresh graph
                </button>
              </div>
            </div>
          </div>

          <div className="glass-panel">
            <div className="panel-content">
              <p className="eyebrow">Themes</p>
              <ThemeToggle />
            </div>
          </div>
        </div>

        <div className="workspace__footer" ref={footerRef}>
          <div className="chip">
            Surface: {activeSurface === "prompt"
              ? "Prompt"
              : activeSurface === "history"
                ? "Prompt history"
                : "Constellation field"}
          </div>
          <div className="chip">Drag empty space to pan</div>
          <div className="chip">Scroll to zoom</div>
          <div className="chip">Drag a node to persist its position</div>
          <div className="chip">{statusLabel}</div>
        </div>

        {activeSurface === "field" && selectedIdea ? (
          <div className="workspace__detail">
            <div className="glass-panel glass-panel--strong">
              <div className="panel-content detail-card">
                <div>
                  <p className="eyebrow">{selectedIdea.cluster}</p>
                  <h2>{selectedIdea.title}</h2>
                </div>

                <p>{selectedIdea.description}</p>

                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat__label">Links</span>
                    <span className="stat__value">{selectedConnections.length}</span>
                  </div>
                  <div className="stat">
                    <span className="stat__label">Weight</span>
                    <span className="stat__value">{selectedIdea.weight}</span>
                  </div>
                  <div className="stat">
                    <span className="stat__label">Radius</span>
                    <span className="stat__value">{Math.round(selectedIdea.radius)}</span>
                  </div>
                </div>

                <div className="tag-list">
                  {selectedIdea.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function getPointerPoint(
  event: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>
) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function screenToWorld(point: { x: number; y: number }, viewport: Viewport) {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale
  };
}

function worldToScreen(point: { x: number; y: number }, viewport: Viewport) {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y
  };
}

function fitGraphToViewport(
  graph: GraphSnapshot,
  width: number,
  height: number
): Viewport {
  if (!graph.ideas.length) {
    return { x: width / 2, y: height / 2, scale: 1 };
  }

  const xs = graph.ideas.map((idea) => idea.x);
  const ys = graph.ideas.map((idea) => idea.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const graphWidth = Math.max(maxX - minX, 1);
  const graphHeight = Math.max(maxY - minY, 1);
  const scale = clamp(
    Math.min(width / (graphWidth + 300), height / (graphHeight + 300)),
    0.5,
    1.4
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    scale,
    x: width / 2 - centerX * scale,
    y: height / 2 - centerY * scale
  };
}

function findIdeaAtPoint(
  ideas: IdeaNode[],
  point: { x: number; y: number },
  viewport: Viewport
) {
  const ordered = [...ideas].reverse();

  return ordered.find((idea) => {
    const screen = worldToScreen({ x: idea.x, y: idea.y }, viewport);
    const radius = idea.radius * viewport.scale;
    const dx = point.x - screen.x;
    const dy = point.y - screen.y;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  });
}

function drawGraph(
  canvas: HTMLCanvasElement | null,
  graph: GraphSnapshot | null,
  viewport: Viewport,
  selectedIdeaId: string | null
) {
  if (!canvas || !graph) {
    return;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const dotColor = getCssVar("--canvas-dot", "rgba(255,255,255,0.08)");
  const edgeColor = getCssVar("--edge", "rgba(255,255,255,0.2)");
  const ringColor = getCssVar("--node-ring", "rgba(255,255,255,0.12)");
  const selectionColor = getCssVar("--selection", "rgba(255, 140, 57, 0.24)");
  const textColor = getCssVar("--text", "#ffffff");
  const mutedColor = getCssVar("--muted", "#94a3b8");
  const panelColor = getCssVar("--panel-strong", "rgba(12,12,20,0.8)");

  drawGrid(context, rect.width, rect.height, viewport, dotColor);

  const ideasById = new Map(graph.ideas.map((idea) => [idea.id, idea]));

  for (const connection of graph.connections) {
    const source = ideasById.get(connection.sourceId);
    const target = ideasById.get(connection.targetId);

    if (!source || !target) {
      continue;
    }

    const sourceScreen = worldToScreen({ x: source.x, y: source.y }, viewport);
    const targetScreen = worldToScreen({ x: target.x, y: target.y }, viewport);
    const gradient = context.createLinearGradient(
      sourceScreen.x,
      sourceScreen.y,
      targetScreen.x,
      targetScreen.y
    );

    gradient.addColorStop(0, getClusterColor(source.cluster));
    gradient.addColorStop(1, getClusterColor(target.cluster));

    context.strokeStyle = gradient;
    context.globalAlpha = 0.25 + connection.strength * 0.45;
    context.lineWidth = 1 + connection.strength * 3;
    context.beginPath();
    context.moveTo(sourceScreen.x, sourceScreen.y);

    const midX = (sourceScreen.x + targetScreen.x) / 2;
    const midY =
      (sourceScreen.y + targetScreen.y) / 2 -
      Math.min(80, Math.abs(targetScreen.x - sourceScreen.x) * 0.1);

    context.quadraticCurveTo(midX, midY, targetScreen.x, targetScreen.y);
    context.stroke();

    if (connection.label) {
      context.save();
      context.globalAlpha = 0.8;
      context.font = '12px "IBM Plex Mono", monospace';
      context.fillStyle = edgeColor;
      context.fillText(connection.label, midX + 8, midY - 4);
      context.restore();
    }
  }

  context.globalAlpha = 1;

  for (const idea of graph.ideas) {
    const screen = worldToScreen({ x: idea.x, y: idea.y }, viewport);
    const radius = idea.radius * viewport.scale;
    const fill = getClusterColor(idea.cluster);

    if (idea.id === selectedIdeaId) {
      context.beginPath();
      context.fillStyle = selectionColor;
      context.arc(screen.x, screen.y, radius + 16, 0, Math.PI * 2);
      context.fill();
    }

    const gradient = context.createRadialGradient(
      screen.x - radius * 0.35,
      screen.y - radius * 0.4,
      radius * 0.1,
      screen.x,
      screen.y,
      radius
    );
    gradient.addColorStop(0, fill);
    gradient.addColorStop(1, panelColor);

    context.beginPath();
    context.fillStyle = gradient;
    context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    context.fill();

    context.lineWidth = idea.id === selectedIdeaId ? 2.5 : 1.25;
    context.strokeStyle = ringColor;
    context.beginPath();
    context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = textColor;
    context.font = `600 ${clamp(radius * 0.24, 14, 22)}px "Space Grotesk", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const lines = wrapText(context, idea.title, radius * 1.35);
    lines.forEach((line, index) => {
      const offset = (index - (lines.length - 1) / 2) * clamp(radius * 0.26, 16, 22);
      context.fillText(line, screen.x, screen.y - 6 + offset);
    });

    if (idea.tags[0]) {
      context.fillStyle = mutedColor;
      context.font = `500 ${clamp(radius * 0.12, 11, 14)}px "IBM Plex Mono", monospace`;
      context.fillText(idea.tags[0], screen.x, screen.y + radius * 0.45);
    }
  }
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  color: string
) {
  const spacing = 76 * viewport.scale;
  const originX = viewport.x % spacing;
  const originY = viewport.y % spacing;

  context.fillStyle = color;

  for (let x = originX; x < width; x += spacing) {
    for (let y = originY; y < height; y += spacing) {
      context.beginPath();
      context.arc(x, y, 1.4, 0, Math.PI * 2);
      context.fill();
    }
  }
}
