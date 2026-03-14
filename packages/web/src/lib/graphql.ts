import { gql } from "@apollo/client";

export type RuntimeConfigShape = {
  appTitle: string;
  graphTitle: string;
  graphSubtitle: string;
  defaultTheme: string;
  availableThemes: string[];
  canvasRefreshMs: number;
  graphqlEndpoint: string;
  graphqlWsEndpoint: string;
};

export type IdeaNode = {
  id: string;
  title: string;
  description: string;
  cluster: string;
  x: number;
  y: number;
  radius: number;
  weight: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type Connection = {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  strength: number;
  createdAt: string;
};

export type GraphSnapshot = {
  generatedAt: string;
  ideas: IdeaNode[];
  connections: Connection[];
};

export type PromptStatus =
  | "queued"
  | "cancelled"
  | "scanning"
  | "deciding"
  | "writing"
  | "updating_canvas"
  | "auditing"
  | "committing"
  | "pushing"
  | "syncing_audit"
  | "completed"
  | "failed";

export type PromptRunnerStateRecord = {
  paused: boolean;
  inFlight: boolean;
  activePromptId: string | null;
  activePromptStatus: PromptStatus | null;
  pollMs: number;
  automationBranch: string;
  worktreeRoot: string;
  runnerSessionId: string;
};

export type PromptRecord = {
  id: string;
  content: string;
  status: PromptStatus;
  metadata: Record<string, unknown>;
  audit: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PromptWorkspaceUpdateRecord = {
  emittedAt: string;
  reason: string;
  promptId: string | null;
  promptRunnerState: PromptRunnerStateRecord;
  prompts: PromptRecord[];
};

export const CANVAS_BOOTSTRAP_QUERY = gql`
  query CanvasBootstrap {
    runtimeConfig {
      appTitle
      graphTitle
      graphSubtitle
      defaultTheme
      availableThemes
      canvasRefreshMs
      graphqlEndpoint
      graphqlWsEndpoint
    }
    graphSnapshot {
      generatedAt
      ideas {
        id
        title
        description
        cluster
        x
        y
        radius
        weight
        tags
        createdAt
        updatedAt
      }
      connections {
        id
        sourceId
        targetId
        label
        strength
        createdAt
      }
    }
  }
`;

export const MOVE_IDEA_MUTATION = gql`
  mutation MoveIdea($input: MoveIdeaInput!) {
    moveIdea(input: $input) {
      id
      x
      y
      updatedAt
    }
  }
`;

export const PROMPTS_QUERY = gql`
  query Prompts($limit: Int) {
    promptRunnerState {
      paused
      inFlight
      activePromptId
      activePromptStatus
      pollMs
      automationBranch
      worktreeRoot
      runnerSessionId
    }
    prompts(limit: $limit) {
      id
      content
      status
      metadata
      audit
      startedAt
      finishedAt
      errorMessage
      createdAt
      updatedAt
    }
  }
`;

export const PROMPT_WORKSPACE_SUBSCRIPTION = gql`
  subscription PromptWorkspace($limit: Int) {
    promptWorkspace(limit: $limit) {
      emittedAt
      reason
      promptId
      promptRunnerState {
        paused
        inFlight
        activePromptId
        activePromptStatus
        pollMs
        automationBranch
        worktreeRoot
        runnerSessionId
      }
      prompts {
        id
        content
        status
        metadata
        audit
        startedAt
        finishedAt
        errorMessage
        createdAt
        updatedAt
      }
    }
  }
`;

const promptFields = `
  id
  content
  status
  metadata
  audit
  startedAt
  finishedAt
  errorMessage
  createdAt
  updatedAt
`;

export const CREATE_PROMPT_MUTATION = gql`
  mutation CreatePrompt($input: CreatePromptInput!) {
    createPrompt(input: $input) {
      ${promptFields}
    }
  }
`;

export const CANCEL_PROMPT_MUTATION = gql`
  mutation CancelPrompt($id: ID!) {
    cancelPrompt(id: $id) {
      ${promptFields}
    }
  }
`;

export const RETRY_PROMPT_MUTATION = gql`
  mutation RetryPrompt($id: ID!) {
    retryPrompt(id: $id) {
      ${promptFields}
    }
  }
`;

export const PAUSE_PROMPT_RUNNER_MUTATION = gql`
  mutation PausePromptRunner {
    pausePromptRunner {
      paused
      inFlight
      activePromptId
      activePromptStatus
      pollMs
      automationBranch
      worktreeRoot
      runnerSessionId
    }
  }
`;

export const RESUME_PROMPT_RUNNER_MUTATION = gql`
  mutation ResumePromptRunner {
    resumePromptRunner {
      paused
      inFlight
      activePromptId
      activePromptStatus
      pollMs
      automationBranch
      worktreeRoot
      runnerSessionId
    }
  }
`;
