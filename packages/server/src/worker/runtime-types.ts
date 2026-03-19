export type CodexRunOutput = {
  promptId: string;
  resultStatus: "completed" | "completed_with_noop" | "failed";
  decision: {
    mode: "create" | "integrate" | "append";
    summary: string;
    targetFiles: string[];
  };
  summary: string;
  repoChanges: {
    added: string[];
    modified: string[];
    deleted: string[];
    moved: Array<{ from: string; to: string }>;
    canvasUpdated: boolean;
  };
  contextualRelevance: Array<{
    path: string;
    relationship: string;
    disposition:
      | "related_but_unproven"
      | "supports_existing_topic"
      | "complicates_existing_topic"
      | "contradicts_existing_topic";
  }>;
  hypotheses: {
    created: string[];
    updated: string[];
    strengthened: string[];
    weakened: string[];
    disproved: string[];
    resolved: string[];
  };
  audit: {
    path: string;
    appended: boolean;
    promptId: string;
    sectionStartMarker: string;
    sectionEndMarker: string;
  };
  git: {
    branch: string;
    commitSha: string | null;
    commitCreated: boolean;
    pushSucceeded: boolean;
  };
  blockers: string[];
  notes?: string[];
};

export type RunArtifacts = {
  runDirectory: string;
  instructionPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath: string;
  auditSyncOutputPath: string;
  auditSyncStderrPath: string;
};

export type ContainerDocumentRepo = {
  repoRoot: string;
  documentStoreRoot: string;
  branch: string;
  remoteName: string;
  remoteUrl: string;
  remoteConfigured: boolean;
};
