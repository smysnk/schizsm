import type {
  CanvasGraphCamera,
  CanvasGraphEdgeRecord,
  CanvasGraphPinnedNodeState,
  CanvasGraphRenderNode,
  CanvasGraphRenderState,
  CanvasGraphSnapshotRecord
} from "./canvas-graph-types";

type Viewport = {
  width: number;
  height: number;
};

type CanvasGraphScreenNode = Pick<CanvasGraphRenderNode, "id" | "radius"> & {
  x: number;
  y: number;
};

export type CanvasGraphEdgeGeometry = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  controlX: number;
  controlY: number;
  labelX: number;
  labelY: number;
  arrowAngle: number;
  bend: number;
};

type ForceGraphStepOptions = {
  dt?: number;
  repelStrength?: number;
  springStrength?: number;
  centerPull?: number;
  anchorPull?: number;
  damping?: number;
  selectedNodeId?: string | null;
};

export type CanvasGraphTuningSettings = {
  repelStrength: number;
  springStrength: number;
  centerPull: number;
  anchorPull: number;
  damping: number;
};

const DEFAULT_MIN_RADIUS = 16;
const DEFAULT_MAX_RADIUS = 28;
const DEFAULT_CAMERA_SCALE = 1;
const MIN_CAMERA_SCALE = 0.24;
const MAX_CAMERA_SCALE = 4.8;

export const defaultCanvasGraphTuningSettings: CanvasGraphTuningSettings = {
  repelStrength: 1600,
  springStrength: 0.012,
  centerPull: 0.0018,
  anchorPull: 0.012,
  damping: 0.88
};

export const canvasGraphTuningStorageKey = "schizm.canvas-graph.tuning";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const hashString = (value: string) => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
};

const hasFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const circleFallback = (index: number, total: number) => {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  const radius = 220 + (index % 7) * 18;

  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
};

const computeRadius = (degree: number) =>
  clamp(DEFAULT_MIN_RADIUS + degree * 2.6, DEFAULT_MIN_RADIUS, DEFAULT_MAX_RADIUS);

const normalizeAnchors = (positions: Array<{ x: number; y: number }>) => {
  if (!positions.length) {
    return positions;
  }

  const centerX = positions.reduce((sum, position) => sum + position.x, 0) / positions.length;
  const centerY = positions.reduce((sum, position) => sum + position.y, 0) / positions.length;

  return positions.map((position) => ({
    x: position.x - centerX,
    y: position.y - centerY
  }));
};

export const buildCanvasGraphAdjacency = (snapshot: CanvasGraphSnapshotRecord) => {
  const adjacency = new Map<string, Set<string>>();

  for (const node of snapshot.nodes) {
    adjacency.set(node.id, new Set());
  }

  for (const edge of snapshot.edges) {
    if (!adjacency.has(edge.sourceId) || !adjacency.has(edge.targetId)) {
      continue;
    }

    adjacency.get(edge.sourceId)?.add(edge.targetId);
    adjacency.get(edge.targetId)?.add(edge.sourceId);
  }

  return adjacency;
};

export const filterCanvasGraphSnapshotToNeighborhood = (
  snapshot: CanvasGraphSnapshotRecord,
  anchorId: string | null
): CanvasGraphSnapshotRecord => {
  if (!anchorId || !snapshot.nodes.some((node) => node.id === anchorId)) {
    return snapshot;
  }

  const neighborhood = getCanvasGraphNeighborhood(buildCanvasGraphAdjacency(snapshot), anchorId);

  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => neighborhood.has(node.id)),
    edges: snapshot.edges.filter(
      (edge) => neighborhood.has(edge.sourceId) && neighborhood.has(edge.targetId)
    )
  };
};

export const buildCanvasGraphRenderState = (
  snapshot: CanvasGraphSnapshotRecord
): CanvasGraphRenderState => {
  const anchoredPositions = normalizeAnchors(
    snapshot.nodes.map((node, index) => {
      if (hasFiniteNumber(node.x) && hasFiniteNumber(node.y)) {
        return { x: node.x, y: node.y };
      }

      return circleFallback(index, snapshot.nodes.length);
    })
  );

  return {
    nodes: snapshot.nodes.map((node, index) => ({
      ...node,
      x: anchoredPositions[index]?.x ?? 0,
      y: anchoredPositions[index]?.y ?? 0,
      vx: 0,
      vy: 0,
      anchorX: anchoredPositions[index]?.x ?? 0,
      anchorY: anchoredPositions[index]?.y ?? 0,
      radius: computeRadius(node.degree),
      pinned: false
    })),
    edges: snapshot.edges.map((edge) => ({ ...edge })),
    adjacency: buildCanvasGraphAdjacency(snapshot)
  };
};

export const getCanvasGraphPinnedStorageKey = (canvasPath: string) =>
  `schizm.canvas-graph.pins:${canvasPath}`;

export const normalizeCanvasGraphTuningSettings = (
  value: Partial<CanvasGraphTuningSettings> | null | undefined
): CanvasGraphTuningSettings => ({
  repelStrength: clamp(
    value?.repelStrength ?? defaultCanvasGraphTuningSettings.repelStrength,
    200,
    6000
  ),
  springStrength: clamp(
    value?.springStrength ?? defaultCanvasGraphTuningSettings.springStrength,
    0.002,
    0.05
  ),
  centerPull: clamp(
    value?.centerPull ?? defaultCanvasGraphTuningSettings.centerPull,
    0,
    0.02
  ),
  anchorPull: clamp(
    value?.anchorPull ?? defaultCanvasGraphTuningSettings.anchorPull,
    0,
    0.05
  ),
  damping: clamp(value?.damping ?? defaultCanvasGraphTuningSettings.damping, 0.7, 0.98)
});

export const serializePinnedNodes = (nodes: CanvasGraphRenderNode[]): CanvasGraphPinnedNodeState[] =>
  nodes
    .filter((node) => node.pinned)
    .map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y
    }));

export const applyPinnedNodes = (
  nodes: CanvasGraphRenderNode[],
  persisted: CanvasGraphPinnedNodeState[]
) => {
  const positions = new Map(persisted.map((entry) => [entry.id, entry]));

  for (const node of nodes) {
    const saved = positions.get(node.id);

    if (!saved) {
      continue;
    }

    node.x = saved.x;
    node.y = saved.y;
    node.vx = 0;
    node.vy = 0;
    node.pinned = true;
  }
};

export const worldToScreen = (
  camera: CanvasGraphCamera,
  worldX: number,
  worldY: number
) => ({
  x: worldX * camera.scale + camera.x,
  y: worldY * camera.scale + camera.y
});

export const screenToWorld = (
  camera: CanvasGraphCamera,
  screenX: number,
  screenY: number
) => ({
  x: (screenX - camera.x) / camera.scale,
  y: (screenY - camera.y) / camera.scale
});

export const zoomCameraAtPoint = (
  camera: CanvasGraphCamera,
  pointerX: number,
  pointerY: number,
  scaleDelta: number
): CanvasGraphCamera => {
  const nextScale = clamp(camera.scale * scaleDelta, MIN_CAMERA_SCALE, MAX_CAMERA_SCALE);

  if (nextScale === camera.scale) {
    return camera;
  }

  const worldPoint = screenToWorld(camera, pointerX, pointerY);

  return {
    scale: nextScale,
    x: pointerX - worldPoint.x * nextScale,
    y: pointerY - worldPoint.y * nextScale
  };
};

export const getCanvasGraphEdgeGeometry = (
  source: CanvasGraphScreenNode,
  target: CanvasGraphScreenNode,
  edge: Pick<CanvasGraphEdgeRecord, "id" | "kind" | "label" | "tentative">
): CanvasGraphEdgeGeometry => {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const unitX = dx / distance;
  const unitY = dy / distance;
  const perpX = -unitY;
  const perpY = unitX;
  const bendSeed = hashString(`${edge.id}:${source.id}:${target.id}`);
  const bendSign = bendSeed % 2 === 0 ? 1 : -1;
  const bendMultiplier =
    edge.kind === "markdown-link" ? 0.82 : edge.tentative ? 1.15 : 1;
  const bend = clamp(distance * 0.12 * bendMultiplier, 18, 54) * bendSign;
  const startOffset = source.radius + 6;
  const endOffset = target.radius + 12;
  const startX = source.x + unitX * startOffset;
  const startY = source.y + unitY * startOffset;
  const endX = target.x - unitX * endOffset;
  const endY = target.y - unitY * endOffset;
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const controlX = midX + perpX * bend;
  const controlY = midY + perpY * bend;

  return {
    startX,
    startY,
    endX,
    endY,
    controlX,
    controlY,
    labelX: 0.25 * startX + 0.5 * controlX + 0.25 * endX,
    labelY: 0.25 * startY + 0.5 * controlY + 0.25 * endY,
    arrowAngle: Math.atan2(endY - controlY, endX - controlX),
    bend
  };
};

export const fitCameraToGraph = (
  nodes: CanvasGraphRenderNode[],
  viewport: Viewport,
  padding = 72
): CanvasGraphCamera => {
  if (!nodes.length || viewport.width <= 0 || viewport.height <= 0) {
    return {
      x: viewport.width / 2,
      y: viewport.height / 2,
      scale: DEFAULT_CAMERA_SCALE
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(
    Math.min(availableWidth / graphWidth, availableHeight / graphHeight),
    MIN_CAMERA_SCALE,
    MAX_CAMERA_SCALE
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    scale,
    x: viewport.width / 2 - centerX * scale,
    y: viewport.height / 2 - centerY * scale
  };
};

export const getCanvasGraphNeighborhood = (
  adjacency: Map<string, Set<string>>,
  anchorId: string | null
) => {
  const visible = new Set<string>();

  if (!anchorId) {
    return visible;
  }

  visible.add(anchorId);

  for (const neighbor of adjacency.get(anchorId) || []) {
    visible.add(neighbor);
  }

  return visible;
};

export const findNodeAtWorldPoint = (
  nodes: CanvasGraphRenderNode[],
  worldX: number,
  worldY: number
) => {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const dx = worldX - node.x;
    const dy = worldY - node.y;

    if (dx * dx + dy * dy <= node.radius * node.radius) {
      return node;
    }
  }

  return null;
};

export const stepCanvasGraphSimulation = (
  state: CanvasGraphRenderState,
  options: ForceGraphStepOptions = {}
) => {
  const dt = clamp(options.dt ?? 1, 0.4, 2.2);
  const tuning = normalizeCanvasGraphTuningSettings(options);
  const repelStrength = tuning.repelStrength;
  const springStrength = tuning.springStrength;
  const centerPull = tuning.centerPull;
  const anchorPull = tuning.anchorPull;
  const damping = tuning.damping;
  const selectedNodeId = options.selectedNodeId ?? null;

  for (let i = 0; i < state.nodes.length; i += 1) {
    for (let j = i + 1; j < state.nodes.length; j += 1) {
      const left = state.nodes[i];
      const right = state.nodes[j];
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      const distanceSquared = dx * dx + dy * dy + 0.1;
      const distance = Math.sqrt(distanceSquared);
      dx /= distance;
      dy /= distance;
      const force = repelStrength / distanceSquared;
      left.vx -= dx * force * dt;
      left.vy -= dy * force * dt;
      right.vx += dx * force * dt;
      right.vy += dy * force * dt;
    }
  }

  for (const edge of state.edges) {
    const source = state.nodes.find((node) => node.id === edge.sourceId);
    const target = state.nodes.find((node) => node.id === edge.targetId);

    if (!source || !target) {
      continue;
    }

    let dx = target.x - source.x;
    let dy = target.y - source.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 0.001;
    const restLength = 120 + (edge.weight - 1) * 24;
    const springForce = (distance - restLength) * springStrength;
    dx /= distance;
    dy /= distance;
    source.vx += dx * springForce * dt;
    source.vy += dy * springForce * dt;
    target.vx -= dx * springForce * dt;
    target.vy -= dy * springForce * dt;
  }

  for (const node of state.nodes) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    const selectedBoost = node.id === selectedNodeId ? 1.7 : 1;
    node.vx += (-node.x * centerPull + (node.anchorX - node.x) * anchorPull) * selectedBoost * dt;
    node.vy += (-node.y * centerPull + (node.anchorY - node.y) * anchorPull) * selectedBoost * dt;
    node.vx *= damping;
    node.vy *= damping;
    node.x += node.vx * dt;
    node.y += node.vy * dt;
  }
};

export const canvasGraphCategoryColor = (category: CanvasGraphRenderNode["category"]) => {
  switch (category) {
    case "fragment":
      return "#d8c46f";
    case "concept":
      return "#97ff9b";
    case "hypothesis":
      return "#81d9d8";
    case "practical":
      return "#a9c29c";
    default:
      return "#8eb6a1";
  }
};

export const mockCanvasGraphSnapshot: CanvasGraphSnapshotRecord = {
  generatedAt: "2026-03-20T00:00:00.000Z",
  canvasPath: "main.canvas",
  nodes: [
    {
      id: "fragment-clock",
      notePath: "fragments/repeated-clock-time.md",
      canvasNodeId: "fragment-clock",
      label: "repeated clock time",
      kind: "file",
      category: "fragment",
      canvasFile: "main.canvas",
      x: 60,
      y: 40,
      width: 320,
      height: 180,
      degree: 1,
      inboundLinkCount: 1,
      outboundLinkCount: 0,
      tags: []
    },
    {
      id: "concept-frequency",
      notePath: "concepts/frequency-illusion.md",
      canvasNodeId: "concept-frequency",
      label: "frequency illusion",
      kind: "file",
      category: "concept",
      canvasFile: "main.canvas",
      x: 480,
      y: 20,
      width: 320,
      height: 180,
      degree: 1,
      inboundLinkCount: 1,
      outboundLinkCount: 0,
      tags: []
    },
    {
      id: "hypothesis-link",
      notePath: "hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md",
      canvasNodeId: "hypothesis-link",
      label: "clock time may relate to frequency illusion",
      kind: "file",
      category: "hypothesis",
      canvasFile: "main.canvas",
      x: 260,
      y: 280,
      width: 360,
      height: 220,
      degree: 2,
      inboundLinkCount: 0,
      outboundLinkCount: 2,
      tags: []
    },
    {
      id: "practical-reminder",
      notePath: "reminders/check-evening-pattern.md",
      canvasNodeId: "practical-reminder",
      label: "check evening pattern",
      kind: "file",
      category: "practical",
      canvasFile: "main.canvas",
      x: -200,
      y: 240,
      width: 300,
      height: 180,
      degree: 1,
      inboundLinkCount: 0,
      outboundLinkCount: 1,
      tags: []
    }
  ],
  edges: [
    {
      id: "edge-clock-hypothesis",
      sourceId: "hypothesis-link",
      targetId: "fragment-clock",
      kind: "canvas",
      label: "possible explanation",
      weight: 1,
      tentative: true
    },
    {
      id: "edge-frequency-hypothesis",
      sourceId: "hypothesis-link",
      targetId: "concept-frequency",
      kind: "canvas",
      label: "possible context",
      weight: 1,
      tentative: true
    },
    {
      id: "edge-reminder-frequency",
      sourceId: "practical-reminder",
      targetId: "concept-frequency",
      kind: "canvas",
      label: "follow up",
      weight: 1,
      tentative: false
    }
  ]
};
