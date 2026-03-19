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

export type PromptExecutionRecord = {
  id: string;
  promptId: string;
  attempt: number;
  status: string;
  executionMode: string;
  jobName: string | null;
  podName: string | null;
  namespace: string | null;
  image: string | null;
  workerNode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PromptRecord = {
  id: string;
  content: string;
  status: PromptStatus;
  metadata: Record<string, unknown>;
  audit: Record<string, unknown>;
  promptExecutions: PromptExecutionRecord[];
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

const promptFields = `
  id
  content
  status
  metadata
  audit
  promptExecutions {
    id
    promptId
    attempt
    status
    executionMode
    jobName
    podName
    namespace
    image
    workerNode
    startedAt
    finishedAt
    exitCode
    errorMessage
    metadata
    createdAt
    updatedAt
  }
  startedAt
  finishedAt
  errorMessage
  createdAt
  updatedAt
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
      ${promptFields}
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
        ${promptFields}
      }
    }
  }
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
