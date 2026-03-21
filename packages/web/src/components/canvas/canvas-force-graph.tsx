"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import {
  applyPinnedNodes,
  buildCanvasGraphRenderState,
  canvasGraphCategoryColor,
  type CanvasGraphTuningSettings,
  findNodeAtWorldPoint,
  fitCameraToGraph,
  getCanvasGraphEdgeGeometry,
  getCanvasGraphPinnedStorageKey,
  getCanvasGraphNeighborhood,
  mockCanvasGraphSnapshot,
  normalizeCanvasGraphTuningSettings,
  serializePinnedNodes,
  screenToWorld,
  stepCanvasGraphSimulation,
  worldToScreen,
  zoomCameraAtPoint
} from "./canvas-graph-layout";
import type {
  CanvasGraphCamera,
  CanvasGraphRenderNode,
  CanvasGraphSnapshotRecord
} from "./canvas-graph-types";

type CanvasForceGraphProps = {
  snapshot?: CanvasGraphSnapshotRecord;
  className?: string;
  onSelectNode?: (node: CanvasGraphRenderNode | null) => void;
  highlightedNodeIds?: string[];
  highlightedPromptLabel?: string | null;
  tuning?: Partial<CanvasGraphTuningSettings>;
};

export type CanvasForceGraphHandle = {
  fitGraph: () => void;
  resetLayout: () => void;
};

const DRAG_THRESHOLD = 4;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const edgeStyle = (selectedNeighborhood: Set<string>, edge: CanvasGraphSnapshotRecord["edges"][number]) => {
  const emphasized =
    !selectedNeighborhood.size ||
    (selectedNeighborhood.has(edge.sourceId) && selectedNeighborhood.has(edge.targetId));

  return {
    opacity: emphasized ? (edge.kind === "markdown-link" ? 0.36 : 0.55) : 0.12,
    width: edge.kind === "markdown-link" ? 1.1 : 1.6,
    stroke: edge.tentative ? "rgba(129, 217, 216, 0.72)" : "rgba(137, 255, 151, 0.42)"
  };
};

const drawEdgeArrow = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number
) => {
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(
    x - Math.cos(angle - Math.PI / 6) * size,
    y - Math.sin(angle - Math.PI / 6) * size
  );
  context.lineTo(
    x - Math.cos(angle + Math.PI / 6) * size,
    y - Math.sin(angle + Math.PI / 6) * size
  );
  context.closePath();
  context.fill();
};

export const CanvasForceGraph = forwardRef<CanvasForceGraphHandle, CanvasForceGraphProps>(function CanvasForceGraph({
  snapshot = mockCanvasGraphSnapshot,
  className,
  onSelectNode,
  highlightedNodeIds = [],
  highlightedPromptLabel = null,
  tuning
}, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number>(0);
  const renderStateRef = useRef(buildCanvasGraphRenderState(snapshot));
  const cameraRef = useRef<CanvasGraphCamera>({ x: 0, y: 0, scale: 1 });
  const interactionRef = useRef({
    mode: "idle" as "idle" | "pan" | "node",
    nodeId: null as string | null,
    nodeOffsetX: 0,
    nodeOffsetY: 0,
    startX: 0,
    startY: 0,
    prevX: 0,
    prevY: 0,
    moved: false
  });

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const highlightedNodeSet = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const normalizedTuning = useMemo(() => normalizeCanvasGraphTuningSettings(tuning), [tuning]);

  const persistPinnedState = () => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        getCanvasGraphPinnedStorageKey(snapshot.canvasPath),
        JSON.stringify(serializePinnedNodes(renderStateRef.current.nodes))
      );
    } catch {
      // Ignore storage failures.
    }
  };

  const loadPinnedState = () => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(getCanvasGraphPinnedStorageKey(snapshot.canvasPath));

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        return;
      }

      applyPinnedNodes(
        renderStateRef.current.nodes,
        parsed.filter(
          (entry): entry is { id: string; x: number; y: number } =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as { id?: unknown }).id === "string" &&
            typeof (entry as { x?: unknown }).x === "number" &&
            typeof (entry as { y?: unknown }).y === "number"
        )
      );
    } catch {
      // Ignore storage failures.
    }
  };

  const selectedNeighborhood = useMemo(
    () => getCanvasGraphNeighborhood(renderStateRef.current.adjacency, selectedNodeId),
    [selectedNodeId, snapshot]
  );

  useEffect(() => {
    renderStateRef.current = buildCanvasGraphRenderState(snapshot);
    loadPinnedState();

    if (size.width > 0 && size.height > 0) {
      cameraRef.current = fitCameraToGraph(renderStateRef.current.nodes, size);
    }

    setHoveredNodeId(null);
    setSelectedNodeId((current) =>
      current && renderStateRef.current.nodes.some((node) => node.id === current) ? current : null
    );
  }, [size, snapshot]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const updateSize = () => {
      const element = containerRef.current;

      if (!element) {
        return;
      }

      setSize({
        // Use client dimensions so the canvas does not feed border-box growth back into the
        // container measurement loop.
        width: Math.max(320, Math.floor(element.clientWidth)),
        height: Math.max(360, Math.floor(element.clientHeight))
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size.width || !size.height) {
      return;
    }

    cameraRef.current = fitCameraToGraph(renderStateRef.current.nodes, size);
  }, [size.height, size.width]);

  useEffect(() => {
    const selected =
      renderStateRef.current.nodes.find((node) => node.id === selectedNodeId) || null;
    onSelectNode?.(selected);
  }, [onSelectNode, selectedNodeId]);

  useImperativeHandle(
    ref,
    () => ({
      fitGraph: () => {
        if (!size.width || !size.height) {
          return;
        }

        cameraRef.current = fitCameraToGraph(renderStateRef.current.nodes, size);
      },
      resetLayout: () => {
        renderStateRef.current = buildCanvasGraphRenderState(snapshot);

        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(getCanvasGraphPinnedStorageKey(snapshot.canvasPath));
          } catch {
            // Ignore storage failures.
          }
        }

        if (size.width > 0 && size.height > 0) {
          cameraRef.current = fitCameraToGraph(renderStateRef.current.nodes, size);
        }

        setHoveredNodeId(null);
        setSelectedNodeId(null);
      }
    }),
    [size, snapshot]
  );

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !size.width || !size.height) {
      return undefined;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return undefined;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    let lastTick = performance.now();

    const draw = (now: number) => {
      const dt = clamp((now - lastTick) / 16.7 || 1, 0.5, 2);
      lastTick = now;
      const state = renderStateRef.current;

      if (interactionRef.current.mode !== "node") {
        stepCanvasGraphSimulation(state, {
          dt,
          ...normalizedTuning,
          selectedNodeId
        });
      }

      context.clearRect(0, 0, size.width, size.height);
      context.fillStyle = "rgba(6, 14, 9, 0.94)";
      context.fillRect(0, 0, size.width, size.height);

      context.save();
      context.strokeStyle = "rgba(129, 255, 151, 0.06)";
      context.lineWidth = 1;

      for (let offset = 0; offset < size.height; offset += 4) {
        context.beginPath();
        context.moveTo(0, offset + 0.5);
        context.lineTo(size.width, offset + 0.5);
        context.stroke();
      }

      context.restore();

      for (const edge of state.edges) {
        const source = state.nodes.find((node) => node.id === edge.sourceId);
        const target = state.nodes.find((node) => node.id === edge.targetId);

        if (!source || !target) {
          continue;
        }

        const sourceScreen = worldToScreen(cameraRef.current, source.x, source.y);
        const targetScreen = worldToScreen(cameraRef.current, target.x, target.y);
        const style = edgeStyle(selectedNeighborhood, edge);
        const geometry = getCanvasGraphEdgeGeometry(
          {
            id: source.id,
            x: sourceScreen.x,
            y: sourceScreen.y,
            radius: source.radius * cameraRef.current.scale
          },
          {
            id: target.id,
            x: targetScreen.x,
            y: targetScreen.y,
            radius: target.radius * cameraRef.current.scale
          },
          edge
        );
        const emphasized =
          !selectedNeighborhood.size ||
          (selectedNeighborhood.has(edge.sourceId) && selectedNeighborhood.has(edge.targetId));

        context.save();
        context.strokeStyle = style.stroke;
        context.fillStyle = style.stroke;
        context.globalAlpha = style.opacity;
        context.lineWidth = style.width;

        if (edge.tentative) {
          context.setLineDash([6, 6]);
        }

        context.beginPath();
        context.moveTo(geometry.startX, geometry.startY);
        context.quadraticCurveTo(
          geometry.controlX,
          geometry.controlY,
          geometry.endX,
          geometry.endY
        );
        context.stroke();
        drawEdgeArrow(
          context,
          geometry.endX,
          geometry.endY,
          geometry.arrowAngle,
          edge.kind === "markdown-link" ? 6 : 7.5
        );
        context.restore();

        const shouldShowEdgeLabel =
          Boolean(edge.label) &&
          ((selectedNeighborhood.size > 0 && emphasized) || cameraRef.current.scale >= 1.28);

        if (edge.label && shouldShowEdgeLabel) {
          context.save();
          context.globalAlpha = style.opacity;
          context.font = `600 ${Math.max(10, 11 * cameraRef.current.scale)}px var(--font-mono, "IBM Plex Mono", monospace)`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          const metrics = context.measureText(edge.label);
          const labelWidth = metrics.width + 12;
          const labelHeight = 18;

          context.fillStyle = "rgba(7, 14, 9, 0.88)";
          context.strokeStyle = "rgba(151, 255, 155, 0.24)";
          context.lineWidth = 1;
          context.beginPath();
          context.roundRect(
            geometry.labelX - labelWidth / 2,
            geometry.labelY - labelHeight / 2,
            labelWidth,
            labelHeight,
            999
          );
          context.fill();
          context.stroke();
          context.fillStyle = "rgba(225, 255, 228, 0.9)";
          context.fillText(edge.label, geometry.labelX, geometry.labelY + 0.5);
          context.restore();
        }
      }

      for (const node of state.nodes) {
        const position = worldToScreen(cameraRef.current, node.x, node.y);
        const isSelected = node.id === selectedNodeId;
        const isHovered = node.id === hoveredNodeId;
        const isNeighbor = selectedNeighborhood.has(node.id);
        const isPromptHighlighted = highlightedNodeSet.has(node.id);
        const dimmed = selectedNeighborhood.size > 0 && !isNeighbor && !isPromptHighlighted;
        const radius = node.radius * cameraRef.current.scale;
        const fill = canvasGraphCategoryColor(node.category);

        if (isPromptHighlighted) {
          context.save();
          context.globalAlpha = dimmed ? 0.3 : 0.92;
          context.strokeStyle = "rgba(255, 244, 163, 0.92)";
          context.shadowColor = "rgba(255, 244, 163, 0.78)";
          context.shadowBlur = isSelected ? 20 : 14;
          context.lineWidth = isSelected ? 4.2 : 3.1;
          context.beginPath();
          context.arc(position.x, position.y, radius + 4, 0, Math.PI * 2);
          context.stroke();
          context.restore();
        }

        context.save();
        context.globalAlpha = dimmed ? 0.28 : 0.96;
        context.fillStyle = fill;
        context.shadowColor = fill;
        context.shadowBlur = isSelected ? 18 : isHovered ? 12 : 7;
        context.beginPath();
        context.arc(position.x, position.y, radius, 0, Math.PI * 2);
        context.fill();
        context.restore();

        context.save();
        context.globalAlpha = dimmed ? 0.22 : 1;
        context.strokeStyle = isSelected
          ? "rgba(255, 255, 255, 0.92)"
          : isPromptHighlighted
            ? "rgba(255, 244, 163, 0.92)"
          : isHovered
            ? "rgba(151, 255, 155, 0.9)"
            : "rgba(5, 14, 8, 0.92)";
        context.lineWidth = isSelected ? 2.3 : isPromptHighlighted ? 1.9 : 1.4;
        context.beginPath();
        context.arc(position.x, position.y, radius, 0, Math.PI * 2);
        context.stroke();
        context.restore();

        if (cameraRef.current.scale >= 0.72 || isSelected || isHovered) {
          context.save();
          context.globalAlpha = dimmed ? 0.34 : 0.92;
          context.font = `600 ${Math.max(11, 12 * cameraRef.current.scale)}px var(--font-mono, "IBM Plex Mono", monospace)`;
          context.textAlign = "center";
          context.fillStyle = isSelected
            ? "#ffffff"
            : isPromptHighlighted
              ? "rgba(255, 248, 194, 0.95)"
              : "rgba(225, 255, 228, 0.92)";
          context.fillText(node.label, position.x, position.y - radius - 10);
          context.restore();
        }
      }

      animationRef.current = window.requestAnimationFrame(draw);
    };

    animationRef.current = window.requestAnimationFrame(draw);

    return () => window.cancelAnimationFrame(animationRef.current);
  }, [
    highlightedNodeSet,
    hoveredNodeId,
    normalizedTuning,
    selectedNeighborhood,
    selectedNodeId,
    size.height,
    size.width
  ]);

  const updateHoveredNode = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const world = screenToWorld(cameraRef.current, clientX - rect.left, clientY - rect.top);
    const hit = findNodeAtWorldPoint(renderStateRef.current.nodes, world.x, world.y);

    setHoveredNodeId(hit?.id || null);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const world = screenToWorld(cameraRef.current, screenX, screenY);
    const hit = findNodeAtWorldPoint(renderStateRef.current.nodes, world.x, world.y);

    interactionRef.current = {
      mode: hit ? "node" : "pan",
      nodeId: hit?.id || null,
      nodeOffsetX: hit ? world.x - hit.x : 0,
      nodeOffsetY: hit ? world.y - hit.y : 0,
      startX: screenX,
      startY: screenY,
      prevX: screenX,
      prevY: screenY,
      moved: false
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    setHoveredNodeId(hit?.id || null);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const interaction = interactionRef.current;

    if (interaction.mode === "idle") {
      updateHoveredNode(event.clientX, event.clientY);
      return;
    }

    const movedDistance = Math.hypot(screenX - interaction.startX, screenY - interaction.startY);
    interaction.moved = interaction.moved || movedDistance >= DRAG_THRESHOLD;

    if (interaction.mode === "pan") {
      cameraRef.current = {
        ...cameraRef.current,
        x: cameraRef.current.x + (screenX - interaction.prevX),
        y: cameraRef.current.y + (screenY - interaction.prevY)
      };
    } else if (interaction.nodeId) {
      const node = renderStateRef.current.nodes.find((item) => item.id === interaction.nodeId);

      if (node) {
        const world = screenToWorld(cameraRef.current, screenX, screenY);
        node.pinned = true;
        node.x = world.x - interaction.nodeOffsetX;
        node.y = world.y - interaction.nodeOffsetY;
        node.vx = 0;
        node.vy = 0;
      }
    }

    interaction.prevX = screenX;
    interaction.prevY = screenY;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const interaction = interactionRef.current;
    const world = screenToWorld(cameraRef.current, screenX, screenY);
    const hit = findNodeAtWorldPoint(renderStateRef.current.nodes, world.x, world.y);

    if (interaction.mode === "node" && !interaction.moved) {
      setSelectedNodeId((current) => (current === hit?.id ? null : hit?.id || null));
    }

    interactionRef.current = {
      mode: "idle",
      nodeId: null,
      nodeOffsetX: 0,
      nodeOffsetY: 0,
      startX: 0,
      startY: 0,
      prevX: 0,
      prevY: 0,
      moved: false
    };
    event.currentTarget.releasePointerCapture(event.pointerId);
    setHoveredNodeId(hit?.id || null);

    if (interaction.mode === "node" && interaction.moved) {
      persistPinnedState();
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const scaleDelta = event.deltaY > 0 ? 0.92 : 1.08;

    cameraRef.current = zoomCameraAtPoint(cameraRef.current, screenX, screenY, scaleDelta);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const world = screenToWorld(cameraRef.current, screenX, screenY);
    const hit = findNodeAtWorldPoint(renderStateRef.current.nodes, world.x, world.y);

    if (!hit?.pinned) {
      return;
    }

    event.preventDefault();
    hit.pinned = false;
    persistPinnedState();
  };

  const selectedNode =
    renderStateRef.current.nodes.find((node) => node.id === selectedNodeId) || null;
  const hoveredNode =
    renderStateRef.current.nodes.find((node) => node.id === hoveredNodeId) || null;

  return (
    <div
      className={["canvas-force-graph", className].filter(Boolean).join(" ")}
      ref={containerRef}
    >
      <canvas
        className="canvas-force-graph__canvas"
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          if (interactionRef.current.mode === "idle") {
            setHoveredNodeId(null);
          }
        }}
        onWheel={handleWheel}
        ref={canvasRef}
      />
      <div className="canvas-force-graph__hud">
        <div className="canvas-force-graph__hud-pill">
          {selectedNode
            ? `Selected: ${selectedNode.label}`
            : hoveredNode
              ? `Hover: ${hoveredNode.label}`
              : `Canvas: ${snapshot.canvasPath}`}
        </div>
        {highlightedNodeIds.length > 0 ? (
          <div className="canvas-force-graph__hud-pill canvas-force-graph__hud-pill--highlight">
            {highlightedPromptLabel
              ? `${highlightedPromptLabel} touched ${highlightedNodeIds.length} node${highlightedNodeIds.length === 1 ? "" : "s"}`
              : `Touched nodes: ${highlightedNodeIds.length}`}
          </div>
        ) : null}
        <div className="canvas-force-graph__hud-pill canvas-force-graph__hud-pill--muted">
          Drag to pan. Scroll to zoom. Drag a node to pin it. Right click a pinned node to unpin.
        </div>
      </div>
    </div>
  );
});
