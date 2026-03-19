import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePromptWorkspaceEvent,
  promptWorkspaceEventChannel,
  serializePromptWorkspaceEvent
} from "./prompt-workspace-events";

test("serializePromptWorkspaceEvent emits a postgres-notify payload by default", () => {
  const payload = serializePromptWorkspaceEvent({
    emittedAt: "2026-03-19T12:00:00.000Z",
    reason: "Worker dispatched.",
    promptId: "prompt-123",
    scope: "prompt"
  });

  const parsed = JSON.parse(payload);

  assert.equal(parsed.transport, "postgres-notify");
  assert.equal(parsed.promptId, "prompt-123");
});

test("parsePromptWorkspaceEvent accepts a serialized payload", () => {
  const event = parsePromptWorkspaceEvent(
    serializePromptWorkspaceEvent({
      emittedAt: "2026-03-19T12:00:00.000Z",
      reason: "Worker dispatched.",
      promptId: "prompt-123",
      scope: "prompt"
    })
  );

  assert.equal(event.scope, "prompt");
  assert.equal(event.transport, "postgres-notify");
  assert.equal(promptWorkspaceEventChannel, "prompt_workspace");
});

test("parsePromptWorkspaceEvent rejects invalid payloads", () => {
  assert.throws(
    () => parsePromptWorkspaceEvent(JSON.stringify({ nope: true })),
    /Invalid prompt workspace event payload/
  );
});
