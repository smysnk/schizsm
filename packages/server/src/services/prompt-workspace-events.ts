import { EventEmitter, on } from "node:events";
import { pool } from "../db/pool";

export type PromptWorkspaceEvent = {
  sequence: number;
  emittedAt: string;
  reason: string;
  promptId: string | null;
  scope: "prompt" | "runner" | "workspace";
  transport: "memory" | "postgres-notify";
};

export const promptWorkspaceEventChannel = "prompt_workspace";

export type PromptWorkspaceEventEnvelope = Omit<PromptWorkspaceEvent, "sequence"> & {
  sequence?: number;
};

export type PromptWorkspaceEventBus = {
  channel: string;
  publish: (event: Omit<PromptWorkspaceEventEnvelope, "transport">) => PromptWorkspaceEvent;
  subscribe: () => AsyncGenerator<PromptWorkspaceEvent>;
};

const emitter = new EventEmitter();
let sequence = 0;
const processPublisherId = `prompt-workspace-${process.pid}`;
let listenerClientPromise: Promise<import("pg").PoolClient> | null = null;

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
    scope,
    transport: "memory"
  };

  emitter.emit("workspace", event);

  void pool
    .query("SELECT pg_notify($1, $2)", [
      promptWorkspaceEventChannel,
      serializePromptWorkspaceEvent({
        emittedAt: event.emittedAt,
        reason: event.reason,
        promptId: event.promptId,
        scope: event.scope,
        transport: "postgres-notify",
        publisherId: processPublisherId
      })
    ])
    .catch((error) => {
      console.error("Failed to publish prompt workspace event via Postgres NOTIFY", error);
    });

  return event;
};

export const serializePromptWorkspaceEvent = (
  event: Omit<PromptWorkspaceEventEnvelope, "transport"> & {
    transport?: PromptWorkspaceEvent["transport"];
    publisherId?: string;
  }
) =>
  JSON.stringify({
    sequence: event.sequence ?? null,
    emittedAt: event.emittedAt,
    reason: event.reason,
    promptId: event.promptId ?? null,
    scope: event.scope,
    transport: event.transport ?? "postgres-notify",
    publisherId: event.publisherId ?? processPublisherId
  });

const parsePromptWorkspaceNotification = (payload: string) => {
  const parsed = JSON.parse(payload) as Partial<PromptWorkspaceEvent> & {
    publisherId?: string;
  };

  return {
    publisherId: typeof parsed.publisherId === "string" ? parsed.publisherId : null,
    event: parsePromptWorkspaceEvent(payload)
  };
};

export const parsePromptWorkspaceEvent = (payload: string): PromptWorkspaceEvent => {
  const parsed = JSON.parse(payload) as Partial<PromptWorkspaceEvent>;

  if (
    typeof parsed.emittedAt !== "string" ||
    typeof parsed.reason !== "string" ||
    (parsed.promptId !== null && parsed.promptId !== undefined && typeof parsed.promptId !== "string") ||
    (parsed.scope !== "prompt" && parsed.scope !== "runner" && parsed.scope !== "workspace") ||
    (parsed.transport !== "memory" && parsed.transport !== "postgres-notify")
  ) {
    throw new Error("Invalid prompt workspace event payload.");
  }

  return {
    sequence:
      typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence)
        ? parsed.sequence
        : ++sequence,
    emittedAt: parsed.emittedAt,
    reason: parsed.reason,
    promptId: parsed.promptId ?? null,
    scope: parsed.scope,
    transport: parsed.transport
  };
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

export const inMemoryPromptWorkspaceEventBus: PromptWorkspaceEventBus = {
  channel: promptWorkspaceEventChannel,
  publish: publishPromptWorkspaceEvent,
  subscribe: subscribePromptWorkspaceEvents
};

export const initializePromptWorkspaceEventListener = async () => {
  if (listenerClientPromise) {
    await listenerClientPromise;
    return;
  }

  listenerClientPromise = (async () => {
    const client = await pool.connect();

    client.on("notification", (notification) => {
      if (notification.channel !== promptWorkspaceEventChannel || !notification.payload) {
        return;
      }

      try {
        const { publisherId, event } = parsePromptWorkspaceNotification(notification.payload);

        if (publisherId === processPublisherId) {
          return;
        }

        emitter.emit("workspace", event);
      } catch (error) {
        console.error("Failed to parse prompt workspace notification", error);
      }
    });

    await client.query(`LISTEN ${promptWorkspaceEventChannel}`);
    return client;
  })();

  await listenerClientPromise;
};

export const shutdownPromptWorkspaceEventListener = async () => {
  const client = listenerClientPromise ? await listenerClientPromise : null;
  listenerClientPromise = null;

  if (!client) {
    return;
  }

  try {
    await client.query(`UNLISTEN ${promptWorkspaceEventChannel}`);
  } finally {
    client.release();
  }
};
