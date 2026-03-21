import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPinnedNodes,
  buildCanvasGraphAdjacency,
  getCanvasGraphEdgeGeometry,
  buildCanvasGraphRenderState,
  canvasGraphTuningStorageKey,
  defaultCanvasGraphTuningSettings,
  filterCanvasGraphSnapshotToNeighborhood,
  findNodeAtWorldPoint,
  fitCameraToGraph,
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

test("buildCanvasGraphAdjacency creates undirected neighbor sets from edges", () => {
  const adjacency = buildCanvasGraphAdjacency(mockCanvasGraphSnapshot);

  assert.deepEqual(Array.from(adjacency.get("hypothesis-link") || []).sort(), [
    "concept-frequency",
    "fragment-clock"
  ]);
  assert.deepEqual(Array.from(adjacency.get("fragment-clock") || []), ["hypothesis-link"]);
});

test("buildCanvasGraphRenderState normalizes anchor positions and seeds node radii", () => {
  const renderState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);

  assert.equal(renderState.nodes.length, 4);
  assert.equal(renderState.edges.length, 3);
  assert.ok(renderState.nodes.every((node) => Number.isFinite(node.anchorX)));
  assert.ok(renderState.nodes.every((node) => Number.isFinite(node.anchorY)));
  assert.ok(renderState.nodes.every((node) => node.radius >= 16));
});

test("worldToScreen and screenToWorld invert each other", () => {
  const camera = { x: 280, y: 190, scale: 1.4 };
  const screen = worldToScreen(camera, 42, -18);
  const world = screenToWorld(camera, screen.x, screen.y);

  assert.ok(Math.abs(world.x - 42) < 1e-9);
  assert.ok(Math.abs(world.y + 18) < 1e-9);
});

test("zoomCameraAtPoint preserves the world position under the cursor", () => {
  const initialCamera = { x: 300, y: 220, scale: 1 };
  const pointer = { x: 420, y: 260 };
  const worldBefore = screenToWorld(initialCamera, pointer.x, pointer.y);
  const nextCamera = zoomCameraAtPoint(initialCamera, pointer.x, pointer.y, 1.25);
  const worldAfter = screenToWorld(nextCamera, pointer.x, pointer.y);

  assert.equal(worldAfter.x, worldBefore.x);
  assert.equal(worldAfter.y, worldBefore.y);
  assert.ok(nextCamera.scale > initialCamera.scale);
});

test("fitCameraToGraph centers the graph within the viewport", () => {
  const renderState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);
  const camera = fitCameraToGraph(renderState.nodes, { width: 1200, height: 800 });

  const projected = renderState.nodes.map((node) => worldToScreen(camera, node.x, node.y));
  const minX = Math.min(...projected.map((node) => node.x));
  const maxX = Math.max(...projected.map((node) => node.x));
  const minY = Math.min(...projected.map((node) => node.y));
  const maxY = Math.max(...projected.map((node) => node.y));

  assert.ok(minX >= 40);
  assert.ok(maxX <= 1160);
  assert.ok(minY >= 40);
  assert.ok(maxY <= 760);
});

test("getCanvasGraphNeighborhood returns the selected node plus first-degree neighbors", () => {
  const adjacency = buildCanvasGraphAdjacency(mockCanvasGraphSnapshot);
  const neighborhood = getCanvasGraphNeighborhood(adjacency, "hypothesis-link");

  assert.deepEqual(Array.from(neighborhood).sort(), [
    "concept-frequency",
    "fragment-clock",
    "hypothesis-link"
  ]);
});

test("filterCanvasGraphSnapshotToNeighborhood keeps only the selected node and first-degree edges", () => {
  const focused = filterCanvasGraphSnapshotToNeighborhood(
    mockCanvasGraphSnapshot,
    "hypothesis-link"
  );

  assert.deepEqual(
    focused.nodes.map((node) => node.id).sort(),
    ["concept-frequency", "fragment-clock", "hypothesis-link"]
  );
  assert.deepEqual(
    focused.edges.map((edge) => edge.id).sort(),
    ["edge-clock-hypothesis", "edge-frequency-hypothesis"]
  );
  assert.equal(
    filterCanvasGraphSnapshotToNeighborhood(mockCanvasGraphSnapshot, "missing-anchor"),
    mockCanvasGraphSnapshot
  );
});

test("findNodeAtWorldPoint hits nodes using their rendered radii", () => {
  const renderState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);
  const targetNode = renderState.nodes[0];
  const found = findNodeAtWorldPoint(renderState.nodes, targetNode.x, targetNode.y);

  assert.equal(found?.id, targetNode.id);
  assert.equal(findNodeAtWorldPoint(renderState.nodes, 10_000, 10_000), null);
});

test("getCanvasGraphEdgeGeometry trims edges to node rims and produces a curved label point", () => {
  const geometry = getCanvasGraphEdgeGeometry(
    { id: "source", x: 0, y: 0, radius: 20 },
    { id: "target", x: 200, y: 0, radius: 24 },
    {
      id: "edge-1",
      kind: "canvas",
      label: "related",
      tentative: false
    }
  );

  assert.ok(geometry.startX > 20);
  assert.ok(geometry.endX < 176);
  assert.notEqual(geometry.controlY, 0);
  assert.notEqual(geometry.labelY, 0);
});

test("stepCanvasGraphSimulation advances unfrozen nodes while leaving pinned nodes fixed", () => {
  const renderState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);
  const movingNode = renderState.nodes[0];
  const pinnedNode = renderState.nodes[1];
  const movingBefore = { x: movingNode.x, y: movingNode.y };
  const pinnedBefore = { x: pinnedNode.x, y: pinnedNode.y };

  pinnedNode.pinned = true;
  movingNode.vx = 6;
  movingNode.vy = -4;
  pinnedNode.vx = 5;
  pinnedNode.vy = 5;

  stepCanvasGraphSimulation(renderState, { dt: 1 });

  assert.notEqual(movingNode.x, movingBefore.x);
  assert.notEqual(movingNode.y, movingBefore.y);
  assert.equal(pinnedNode.x, pinnedBefore.x);
  assert.equal(pinnedNode.y, pinnedBefore.y);
  assert.equal(pinnedNode.vx, 0);
  assert.equal(pinnedNode.vy, 0);
});

test("pinned-node helpers serialize and reapply pinned positions by id", () => {
  const renderState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);
  renderState.nodes[0].pinned = true;
  renderState.nodes[0].x = 111;
  renderState.nodes[0].y = -45;

  const serialized = serializePinnedNodes(renderState.nodes);
  const freshState = buildCanvasGraphRenderState(mockCanvasGraphSnapshot);

  applyPinnedNodes(freshState.nodes, serialized);

  assert.equal(getCanvasGraphPinnedStorageKey("main.canvas"), "schizm.canvas-graph.pins:main.canvas");
  assert.deepEqual(serialized, [
    {
      id: renderState.nodes[0].id,
      x: 111,
      y: -45
    }
  ]);
  assert.equal(freshState.nodes[0].pinned, true);
  assert.equal(freshState.nodes[0].x, 111);
  assert.equal(freshState.nodes[0].y, -45);
});

test("normalizeCanvasGraphTuningSettings clamps persisted settings into safe ranges", () => {
  const normalized = normalizeCanvasGraphTuningSettings({
    repelStrength: -10,
    springStrength: 0.9,
    centerPull: -1,
    anchorPull: 0.08,
    damping: 2
  });

  assert.equal(canvasGraphTuningStorageKey, "schizm.canvas-graph.tuning");
  assert.deepEqual(defaultCanvasGraphTuningSettings, {
    repelStrength: 1600,
    springStrength: 0.012,
    centerPull: 0.0018,
    anchorPull: 0.012,
    damping: 0.88
  });
  assert.deepEqual(normalized, {
    repelStrength: 200,
    springStrength: 0.05,
    centerPull: 0,
    anchorPull: 0.05,
    damping: 0.98
  });
});
