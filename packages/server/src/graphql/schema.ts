export const typeDefs = `#graphql
  scalar JSON

  type RuntimeConfig {
    appTitle: String!
    graphTitle: String!
    graphSubtitle: String!
    defaultTheme: String!
    availableThemes: [String!]!
    canvasRefreshMs: Int!
    graphqlEndpoint: String!
    graphqlWsEndpoint: String!
  }

  type IdeaNode {
    id: ID!
    title: String!
    description: String!
    cluster: String!
    x: Float!
    y: Float!
    radius: Float!
    weight: Int!
    tags: [String!]!
    createdAt: String!
    updatedAt: String!
  }

  type Connection {
    id: ID!
    sourceId: ID!
    targetId: ID!
    label: String!
    strength: Float!
    createdAt: String!
  }

  type GraphSnapshot {
    generatedAt: String!
    ideas: [IdeaNode!]!
    connections: [Connection!]!
  }

  enum PromptStatus {
    queued
    cancelled
    scanning
    deciding
    writing
    updating_canvas
    auditing
    committing
    pushing
    syncing_audit
    completed
    failed
  }

  type Prompt {
    id: ID!
    content: String!
    status: PromptStatus!
    metadata: JSON!
    audit: JSON!
    startedAt: String
    finishedAt: String
    errorMessage: String
    createdAt: String!
    updatedAt: String!
  }

  type PromptRunnerState {
    paused: Boolean!
    inFlight: Boolean!
    activePromptId: ID
    activePromptStatus: PromptStatus
    pollMs: Int!
    automationBranch: String!
    worktreeRoot: String!
    runnerSessionId: String!
  }

  type PromptWorkspaceUpdate {
    emittedAt: String!
    reason: String!
    promptId: ID
    promptRunnerState: PromptRunnerState!
    prompts: [Prompt!]!
  }

  input MoveIdeaInput {
    id: ID!
    x: Float!
    y: Float!
  }

  input CreatePromptInput {
    content: String!
  }

  type Query {
    health: String!
    runtimeConfig: RuntimeConfig!
    graphSnapshot: GraphSnapshot!
    prompt(id: ID!): Prompt
    prompts(limit: Int): [Prompt!]!
    promptRunnerState: PromptRunnerState!
  }

  type Mutation {
    moveIdea(input: MoveIdeaInput!): IdeaNode!
    seedDemoGraph: GraphSnapshot!
    createPrompt(input: CreatePromptInput!): Prompt!
    cancelPrompt(id: ID!): Prompt!
    retryPrompt(id: ID!): Prompt!
    pausePromptRunner: PromptRunnerState!
    resumePromptRunner: PromptRunnerState!
  }

  type Subscription {
    promptWorkspace(limit: Int): PromptWorkspaceUpdate!
  }
`;
