import { EventEmitter, on } from "node:events";

export type PromptWorkspaceEvent = {
  sequence: number;
  emittedAt: string;
  reason: string;
  promptId: string | null;
  scope: "prompt" | "runner" | "workspace";
};

const emitter = new EventEmitter();
let sequence = 0;

const isAbortError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" ||
    error.message.includes("The operation was aborted"));

export const publishPromptWorkspaceEvent = ({
  reason,
  promptId = null,
  scope = "workspace",
  emittedAt = new Date().toISOString()
}: {
  reason: string;
  promptId?: string | null;
  scope?: PromptWorkspaceEvent["scope"];
  emittedAt?: string;
}) => {
  const event: PromptWorkspaceEvent = {
    sequence: ++sequence,
    emittedAt,
    reason,
    promptId,
    scope
  };

  emitter.emit("workspace", event);
  return event;
};

export const subscribePromptWorkspaceEvents = async function* (): AsyncGenerator<PromptWorkspaceEvent> {
  const controller = new AbortController();

  try {
    for await (const [event] of on(emitter, "workspace", { signal: controller.signal })) {
      yield event as PromptWorkspaceEvent;
    }
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  } finally {
    controller.abort();
  }
};
