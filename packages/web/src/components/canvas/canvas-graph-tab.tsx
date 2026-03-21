"use client";

import { useQuery } from "@apollo/client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CANVAS_GRAPH_QUERY,
  type CanvasGraphQueryResponse
} from "../../lib/graphql";
import {
  CanvasForceGraph,
  type CanvasForceGraphHandle
} from "./canvas-force-graph";
import {
  getCanvasGraphHighlightedNodeIds
} from "./canvas-graph-prompt-context";
import {
  canvasGraphTuningStorageKey,
  defaultCanvasGraphTuningSettings,
  filterCanvasGraphSnapshotToNeighborhood,
  normalizeCanvasGraphTuningSettings,
  type CanvasGraphTuningSettings
} from "./canvas-graph-layout";
import type {
  CanvasGraphEdgeKind,
  CanvasGraphNodeCategory,
  CanvasGraphNodeKind,
  CanvasGraphRenderNode
} from "./canvas-graph-types";

const normalizeNodeKind = (kind: string): CanvasGraphNodeKind =>
  kind === "file" || kind === "text" || kind === "group" || kind === "missing"
    ? kind
    : "missing";

const normalizeNodeCategory = (category: string): CanvasGraphNodeCategory =>
  category === "fragment" ||
  category === "concept" ||
  category === "hypothesis" ||
  category === "practical" ||
  category === "other"
    ? category
    : "other";

const normalizeEdgeKind = (kind: string): CanvasGraphEdgeKind =>
  kind === "canvas" || kind === "markdown-link" || kind === "inferred" ? kind : "canvas";

const formatCanvasNodeKind = (kind: string) => kind.replace(/[-_]+/g, " ");

const formatCanvasNodeCategory = (category: string) => category.replace(/[-_]+/g, " ");

const tuningControlDefinitions: Array<{
  key: keyof CanvasGraphTuningSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}> = [
  {
    key: "repelStrength",
    label: "Repel",
    hint: "How strongly nodes push away from each other.",
    min: 200,
    max: 6000,
    step: 100,
    format: (value) => Math.round(value).toString()
  },
  {
    key: "springStrength",
    label: "Link pull",
    hint: "How tightly connected notes pull back together.",
    min: 0.002,
    max: 0.05,
    step: 0.001,
    format: (value) => value.toFixed(3)
  },
  {
    key: "anchorPull",
    label: "Canvas anchor",
    hint: "How strongly nodes return to their saved canvas positions.",
    min: 0,
    max: 0.05,
    step: 0.001,
    format: (value) => value.toFixed(3)
  },
  {
    key: "centerPull",
    label: "Centering",
    hint: "How much the whole graph drifts back toward center.",
    min: 0,
    max: 0.02,
    step: 0.0005,
    format: (value) => value.toFixed(4)
  },
  {
    key: "damping",
    label: "Damping",
    hint: "How quickly motion settles once nodes start moving.",
    min: 0.7,
    max: 0.98,
    step: 0.01,
    format: (value) => value.toFixed(2)
  }
];

type CanvasGraphTabProps = {
  refreshToken?: string | null;
  highlightedNotePaths?: string[];
  highlightedPromptLabel?: string | null;
};

export function CanvasGraphTab({
  refreshToken = null,
  highlightedNotePaths = [],
  highlightedPromptLabel = null
}: CanvasGraphTabProps) {
  const graphRef = useRef<CanvasForceGraphHandle | null>(null);
  const lastRefreshTokenRef = useRef<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<CanvasGraphRenderNode | null>(null);
  const [showMarkdownLinks, setShowMarkdownLinks] = useState(true);
  const [focusSelectedNeighborhood, setFocusSelectedNeighborhood] = useState(false);
  const [selectedCanvasPath, setSelectedCanvasPath] = useState<string | null>(null);
  const [graphTuning, setGraphTuning] = useState<CanvasGraphTuningSettings>(
    defaultCanvasGraphTuningSettings
  );
  const { data, loading, error, refetch } = useQuery<CanvasGraphQueryResponse>(
    CANVAS_GRAPH_QUERY,
    {
      variables: { canvasPath: selectedCanvasPath },
      fetchPolicy: "cache-and-network"
    }
  );

  const canvasFiles = data?.canvasFiles || [];

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(canvasGraphTuningStorageKey);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<CanvasGraphTuningSettings>;
      setGraphTuning(normalizeCanvasGraphTuningSettings(parsed));
    } catch {
      setGraphTuning(defaultCanvasGraphTuningSettings);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(canvasGraphTuningStorageKey, JSON.stringify(graphTuning));
    } catch {
      // Ignore storage failures.
    }
  }, [graphTuning]);

  useEffect(() => {
    if (!canvasFiles.length) {
      return;
    }

    setSelectedCanvasPath((current) => {
      if (current && canvasFiles.includes(current)) {
        return current;
      }

      if (canvasFiles.includes("main.canvas")) {
        return "main.canvas";
      }

      return canvasFiles[0];
    });
  }, [canvasFiles]);

  useEffect(() => {
    if (!refreshToken) {
      lastRefreshTokenRef.current = null;
      return;
    }

    if (!lastRefreshTokenRef.current) {
      lastRefreshTokenRef.current = refreshToken;
      return;
    }

    if (lastRefreshTokenRef.current === refreshToken) {
      return;
    }

    lastRefreshTokenRef.current = refreshToken;
    void refetch({ canvasPath: selectedCanvasPath });
  }, [refetch, refreshToken, selectedCanvasPath]);

  const snapshot = useMemo(
    () =>
      data?.canvasGraph
        ? {
            ...data.canvasGraph,
            nodes: data.canvasGraph.nodes.map((node) => ({
              ...node,
              kind: normalizeNodeKind(node.kind),
              category: normalizeNodeCategory(node.category)
            })),
            edges: data.canvasGraph.edges.map((edge) => ({
              ...edge,
              kind: normalizeEdgeKind(edge.kind)
            }))
          }
        : null,
    [data]
  );
  const baseSnapshot = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return {
      ...snapshot,
      edges: snapshot.edges.filter(
        (edge) => showMarkdownLinks || edge.kind !== "markdown-link"
      )
    };
  }, [showMarkdownLinks, snapshot]);
  const visibleSnapshot = useMemo(
    () =>
      baseSnapshot && focusSelectedNeighborhood
        ? filterCanvasGraphSnapshotToNeighborhood(baseSnapshot, selectedNode?.id || null)
        : baseSnapshot,
    [baseSnapshot, focusSelectedNeighborhood, selectedNode]
  );
  const highlightedNodeIds = useMemo(
    () => getCanvasGraphHighlightedNodeIds(snapshot, highlightedNotePaths),
    [highlightedNotePaths, snapshot]
  );
  const selectedNodeTouched = Boolean(
    selectedNode && highlightedNodeIds.includes(selectedNode.id)
  );
  const markdownLinkCount = snapshot?.edges.filter((edge) => edge.kind === "markdown-link").length || 0;
  const selectedEdges = useMemo(() => {
    if (!visibleSnapshot || !selectedNode) {
      return [];
    }

    return visibleSnapshot.edges.filter(
      (edge) => edge.sourceId === selectedNode.id || edge.targetId === selectedNode.id
    );
  }, [selectedNode, visibleSnapshot]);
  const graphControls = (
    <div className="graph-menubar">
      {canvasFiles.length > 1 ? (
        <label className="graph-surface__selector graph-menubar__selector">
          <span className="sr-only">Canvas file</span>
          <select
            className="graph-surface__select"
            value={selectedCanvasPath || ""}
            onChange={(event) => {
              setSelectedNode(null);
              setSelectedCanvasPath(event.target.value || null);
            }}
          >
            {canvasFiles.map((canvasFile) => (
              <option key={canvasFile} value={canvasFile}>
                {canvasFile}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="graph-menubar__controls">
        <button
          type="button"
          className="prompt-filter"
          onClick={() => graphRef.current?.fitGraph()}
        >
          Fit graph
        </button>
        <button
          type="button"
          className="prompt-filter"
          onClick={() => {
            graphRef.current?.resetLayout();
            setSelectedNode(null);
          }}
        >
          Reset layout
        </button>
        <button
          type="button"
          className="prompt-filter"
          data-active={showMarkdownLinks}
          onClick={() => setShowMarkdownLinks((current) => !current)}
        >
          {showMarkdownLinks ? "Hide markdown links" : "Show markdown links"}
        </button>
        <button
          type="button"
          className="prompt-filter"
          data-active={focusSelectedNeighborhood && Boolean(selectedNode)}
          disabled={!selectedNode}
          onClick={() => setFocusSelectedNeighborhood((current) => !current)}
        >
          {focusSelectedNeighborhood ? "Show full graph" : "Focus selected"}
        </button>
        <details className="graph-surface__tuning">
          <summary className="prompt-filter">Tune graph</summary>
          <div className="graph-surface__tuning-panel">
            <div className="graph-surface__tuning-header">
              <span className="workspace__eyebrow">Simulation</span>
              <button
                type="button"
                className="prompt-filter"
                onClick={() => setGraphTuning(defaultCanvasGraphTuningSettings)}
              >
                Reset tuning
              </button>
            </div>
            <div className="graph-surface__tuning-grid">
              {tuningControlDefinitions.map((control) => (
                <label className="graph-surface__tuning-control" key={control.key}>
                  <span className="graph-surface__tuning-row">
                    <span>{control.label}</span>
                    <strong>{control.format(graphTuning[control.key])}</strong>
                  </span>
                  <input
                    className="graph-surface__tuning-slider"
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={graphTuning[control.key]}
                    onChange={(event) => {
                      const nextValue = Number.parseFloat(event.target.value);

                      setGraphTuning((current) =>
                        normalizeCanvasGraphTuningSettings({
                          ...current,
                          [control.key]: Number.isFinite(nextValue)
                            ? nextValue
                            : current[control.key]
                        })
                      );
                    }}
                  />
                  <span className="graph-surface__tuning-hint">{control.hint}</span>
                </label>
              ))}
            </div>
          </div>
        </details>
      </div>
    </div>
  );

  if (loading && !visibleSnapshot) {
    return (
      <section className="graph-surface graph-surface--empty">
        <div className="graph-surface__empty">
          <p className="workspace__eyebrow">Canvas graph</p>
          <p className="panel-copy">Loading canvas graph.</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="graph-surface graph-surface--empty">
        <div className="graph-surface__empty">
          <p className="workspace__eyebrow">Canvas graph</p>
          <p className="panel-copy">Unable to load the graph right now.</p>
          <p className="prompt-detail__error">{error.message}</p>
        </div>
      </section>
    );
  }

  if (!visibleSnapshot || visibleSnapshot.nodes.length === 0) {
    return (
      <section className="graph-surface graph-surface--empty">
        <div className="graph-surface__empty">
          <p className="workspace__eyebrow">Canvas graph</p>
          <p className="panel-copy">
            No canvas nodes are available yet. Once `main.canvas` has note or text nodes, the graph
            will appear here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="graph-surface graph-surface--fullscreen">
      <div className="graph-surface__viewport">
        <div className="graph-surface__controls">{graphControls}</div>
        <CanvasForceGraph
          className="graph-surface__graph"
          highlightedNodeIds={highlightedNodeIds}
          highlightedPromptLabel={highlightedPromptLabel}
          onSelectNode={setSelectedNode}
          ref={graphRef}
          snapshot={visibleSnapshot}
          tuning={graphTuning}
        />

        <aside className="graph-surface__legend graph-surface__legend--dock" tabIndex={0}>
          <div className="graph-surface__legend-peek">
            <span className="workspace__eyebrow">Legend</span>
          </div>
          <div className="graph-surface__legend-panel">
            <div className="graph-surface__legend-group">
              <span className="workspace__eyebrow">Node legend</span>
              <div className="graph-surface__legend-items">
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-swatch graph-surface__legend-swatch--fragment" />
                  Fragments
                </span>
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-swatch graph-surface__legend-swatch--concept" />
                  Concepts
                </span>
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-swatch graph-surface__legend-swatch--hypothesis" />
                  Hypotheses
                </span>
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-swatch graph-surface__legend-swatch--practical" />
                  Practical
                </span>
              </div>
            </div>

            <div className="graph-surface__legend-group">
              <span className="workspace__eyebrow">Edge legend</span>
              <div className="graph-surface__legend-items">
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-line graph-surface__legend-line--canvas" />
                  Canvas edge
                </span>
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-line graph-surface__legend-line--markdown" />
                  Markdown link
                </span>
                <span className="graph-surface__legend-item">
                  <span className="graph-surface__legend-line graph-surface__legend-line--tentative" />
                  Tentative edge
                </span>
              </div>
            </div>
          </div>
        </aside>

        {selectedNode ? (
          <aside className="graph-surface__sidepanel">
            <div className="graph-surface__sidepanel-scroll">
              <section className="graph-surface__detail graph-surface__detail--floating prompt-detail">
                <div className="prompt-detail__header">
                  <div>
                    <p className="workspace__eyebrow">Selected node</p>
                    <h3>{selectedNode.label}</h3>
                  </div>
                </div>

                <div className="prompt-detail__stats">
                  <div className="stat-card">
                    <span className="stat-card__label">Kind</span>
                    <span className="stat-card__value">
                      {formatCanvasNodeKind(selectedNode.kind)}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Category</span>
                    <span className="stat-card__value">
                      {formatCanvasNodeCategory(selectedNode.category)}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Degree</span>
                    <span className="stat-card__value">{selectedNode.degree}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Inbound</span>
                    <span className="stat-card__value">{selectedNode.inboundLinkCount}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Outbound</span>
                    <span className="stat-card__value">{selectedNode.outboundLinkCount}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Canvas file</span>
                    <span className="stat-card__value">{selectedNode.canvasFile}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__label">Position</span>
                    <span className="stat-card__value">
                      {Math.round(selectedNode.x)}, {Math.round(selectedNode.y)}
                    </span>
                  </div>
                </div>

                {selectedNode.notePath ? (
                  <p className="prompt-detail__hint">Note path: {selectedNode.notePath}</p>
                ) : null}
                {selectedNodeTouched ? (
                  <p className="prompt-detail__hint">
                    Touched by {highlightedPromptLabel || "the selected prompt"}.
                  </p>
                ) : null}

                {selectedEdges.length ? (
                  <div className="prompt-detail__timeline">
                    {selectedEdges.map((edge) => {
                      const otherNodeId =
                        edge.sourceId === selectedNode.id ? edge.targetId : edge.sourceId;
                      const otherNode =
                        visibleSnapshot.nodes.find((node) => node.id === otherNodeId) || null;

                      return (
                        <div className="prompt-detail__step" key={edge.id}>
                          <div className="prompt-detail__step-row">
                            <span className="stat-card__label">{edge.kind}</span>
                            <span className="prompt-item__time">
                              {edge.tentative ? "Tentative" : "Direct"}
                            </span>
                          </div>
                          <p className="prompt-detail__reason">
                            {edge.label || "Unlabelled connection"}
                          </p>
                          {otherNode ? (
                            <p className="prompt-detail__hint">Connected to: {otherNode.label}</p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <p className="prompt-detail__hint">
                      This node does not currently have visible graph connections.
                    </p>
                    {!showMarkdownLinks && markdownLinkCount > 0 ? (
                      <p className="prompt-detail__hint">
                        Markdown-link edges are currently hidden.
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            </div>
          </aside>
        ) : null}

        <footer className="graph-surface__statusbar">
          <span className="graph-surface__status-item">
            canvas <strong>{visibleSnapshot.canvasPath}</strong>
          </span>
          <span className="graph-surface__status-item">
            nodes <strong>{visibleSnapshot.nodes.length}</strong>
          </span>
          <span className="graph-surface__status-item">
            edges <strong>{visibleSnapshot.edges.length}</strong>
          </span>
          <span className="graph-surface__status-item">
            markdown <strong>{markdownLinkCount}</strong>
          </span>
          <span className="graph-surface__status-item">
            mode <strong>{focusSelectedNeighborhood && selectedNode ? "focused" : "full"}</strong>
          </span>
          {highlightedNodeIds.length > 0 ? (
            <span className="graph-surface__status-item">
              touched <strong>{highlightedNodeIds.length}</strong>
            </span>
          ) : null}
          {selectedNode ? (
            <span className="graph-surface__status-item">
              selected <strong>{selectedNode.label}</strong>
            </span>
          ) : (
            <span className="graph-surface__status-item">
              hint <strong>select a node to inspect it</strong>
            </span>
          )}
        </footer>
      </div>
    </section>
  );
}
