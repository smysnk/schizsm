import { getRuntimeConfig } from "../config/env";
import { ensureDemoGraph, getGraphSnapshot, moveIdea } from "../repositories/graph-repository";
import {
  cancelPrompt,
  createPrompt,
  getPrompt,
  listPrompts,
  retryPrompt
} from "../repositories/prompt-repository";
import { getPromptRunner } from "../services/prompt-runner-registry";
import { subscribePromptWorkspaceEvents } from "../services/prompt-workspace-events";
import { jsonScalar } from "./json-scalar";

const getPromptRunnerState = () =>
  getPromptRunner()?.getState() || {
    paused: true,
    inFlight: false,
    activePromptId: null,
    activePromptStatus: null,
    pollMs: 0,
    automationBranch: "unavailable",
    worktreeRoot: "unavailable",
    runnerSessionId: "unavailable"
  };

export const resolvers = {
  JSON: jsonScalar,
  Query: {
    health: () => "ok",
    runtimeConfig: () => getRuntimeConfig(),
    graphSnapshot: async () => getGraphSnapshot(),
    prompt: async (_: unknown, args: { id: string }) => getPrompt(args.id),
    prompts: async (_: unknown, args: { limit?: number | null }) => listPrompts(args.limit),
    promptRunnerState: () => getPromptRunnerState()
  },
  Mutation: {
    moveIdea: async (
      _: unknown,
      args: { input: { id: string; x: number; y: number } }
    ) => moveIdea(args.input.id, args.input.x, args.input.y),
    createPrompt: async (
      _: unknown,
      args: { input: { content: string } }
    ) => createPrompt(args.input.content),
    cancelPrompt: async (_: unknown, args: { id: string }) => cancelPrompt(args.id),
    retryPrompt: async (_: unknown, args: { id: string }) => retryPrompt(args.id),
    pausePromptRunner: async () => {
      const runner = getPromptRunner();

      if (!runner) {
        throw new Error("Prompt runner is not available.");
      }

      return runner.pause();
    },
    resumePromptRunner: async () => {
      const runner = getPromptRunner();

      if (!runner) {
        throw new Error("Prompt runner is not available.");
      }

      return runner.resume();
    },
    seedDemoGraph: async () => {
      await ensureDemoGraph();
      return getGraphSnapshot();
    }
  },
  Subscription: {
    promptWorkspace: {
      subscribe: () => subscribePromptWorkspaceEvents(),
      resolve: async (
        event: { emittedAt: string; reason: string; promptId: string | null },
        args: { limit?: number | null }
      ) => ({
        emittedAt: event.emittedAt,
        reason: event.reason,
        promptId: event.promptId,
        promptRunnerState: getPromptRunnerState(),
        prompts: await listPrompts(args.limit)
      })
    }
  }
};
