import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

const explicitEnvKeys = new Set(Object.keys(process.env));

const applyEnvFile = (filePath: string, overridePreviouslyLoaded: boolean) => {
  if (!existsSync(filePath)) {
    return;
  }

  const parsed = dotenv.parse(readFileSync(filePath, "utf8"));

  for (const [key, value] of Object.entries(parsed)) {
    if (explicitEnvKeys.has(key)) {
      continue;
    }

    if (!overridePreviouslyLoaded && process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
};

applyEnvFile(path.resolve(process.cwd(), "../../.env"), false);
applyEnvFile(path.resolve(process.cwd(), ".env"), true);

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
};

const toWebSocketUrl = (value: string) =>
  value.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

const resolveRepoRoot = () => {
  if (process.env.PROMPT_RUNNER_REPO_ROOT) {
    return path.resolve(process.env.PROMPT_RUNNER_REPO_ROOT);
  }

  let current = path.resolve(process.cwd());

  while (true) {
    const hasProgram = existsSync(path.join(current, "program.md"));
    const hasPackagesDir = existsSync(path.join(current, "packages"));
    const hasRootPackage = existsSync(path.join(current, "package.json"));

    if (hasProgram && hasPackagesDir && hasRootPackage) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return path.resolve(process.cwd());
    }

    current = parent;
  }
};

export const env = {
  documentStoreDir: process.env.DOCUMENT_STORE_DIR || "obsidian-repository",
  appTitle: process.env.APP_TITLE || "Schizm",
  graphTitle: process.env.GRAPH_TITLE || "Connection Field",
  graphSubtitle:
    process.env.GRAPH_SUBTITLE ||
    "Map how fragments attract, collide, and reshape each other.",
  defaultTheme: process.env.DEFAULT_THEME || "signal",
  availableThemes: ["signal", "paper", "midnight"],
  canvasRefreshMs: parseNumber(process.env.CANVAS_REFRESH_MS, 30_000),
  webPort: parseNumber(process.env.WEB_PORT, 3000),
  serverPort: parseNumber(process.env.SERVER_PORT, parseNumber(process.env.PORT, 4000)),
  serverUrl: process.env.SERVER_URL || `http://127.0.0.1:${process.env.SERVER_PORT || "4000"}`,
  graphqlEndpoint: process.env.GRAPHQL_ENDPOINT || "/graphql",
  graphqlWsUrl:
    process.env.GRAPHQL_WS_URL ||
    `${toWebSocketUrl(
      process.env.SERVER_URL || `http://127.0.0.1:${process.env.SERVER_PORT || "4000"}`
    )}${process.env.GRAPHQL_ENDPOINT || "/graphql"}`,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:5432/schizm",
  dbSsl: parseBoolean(process.env.DB_SSL, false),
  seedDemoGraph: parseBoolean(process.env.SEED_DEMO_GRAPH, true),
  promptRunnerEnabled: parseBoolean(process.env.PROMPT_RUNNER_ENABLED, true),
  promptRunnerExecutionMode:
    process.env.PROMPT_RUNNER_EXECUTION_MODE === "container"
      ? "container"
      : process.env.PROMPT_RUNNER_EXECUTION_MODE === "kube-worker"
        ? "kube-worker"
        : "worktree",
  promptRunnerPollMs: parseNumber(process.env.PROMPT_RUNNER_POLL_MS, 5_000),
  promptRunnerCodexBin: process.env.CODEX_BIN || "codex",
  promptRunnerRepoRoot: resolveRepoRoot(),
  promptRunnerAutomationBranch:
    process.env.PROMPT_RUNNER_AUTOMATION_BRANCH || "codex/mindmap",
  promptRunnerRemoteName: process.env.PROMPT_RUNNER_REMOTE_NAME || "origin",
  promptRunnerReasoningEffort:
    process.env.PROMPT_RUNNER_REASONING_EFFORT || "medium",
  promptRunnerContainerRepoUrl: process.env.DOCUMENT_STORE_GIT_URL || "",
  promptRunnerContainerRepoBranch:
    process.env.DOCUMENT_STORE_GIT_BRANCH ||
    process.env.PROMPT_RUNNER_AUTOMATION_BRANCH ||
    "main",
  promptRunnerContainerGitAuthorName:
    process.env.DOCUMENT_STORE_GIT_AUTHOR_NAME || "Schizm Bot",
  promptRunnerContainerGitAuthorEmail:
    process.env.DOCUMENT_STORE_GIT_AUTHOR_EMAIL || "schizm-bot@smysnk.com",
  promptRunnerWorktreeRoot:
    process.env.PROMPT_RUNNER_WORKTREE_ROOT ||
    path.join(resolveRepoRoot(), ".codex-workdirs"),
  promptRunnerKubeNamespace: process.env.PROMPT_RUNNER_KUBE_NAMESPACE || "schizm",
  promptRunnerKubeRuntimeSecretName:
    process.env.PROMPT_RUNNER_KUBE_RUNTIME_SECRET_NAME || "schizm-runtime-secret",
  promptRunnerKubeExecutorImage:
    process.env.PROMPT_RUNNER_KUBE_EXECUTOR_IMAGE || process.env.SCHIZM_IMAGE || "",
  promptRunnerKubeGitHelperImage:
    process.env.PROMPT_RUNNER_KUBE_GIT_HELPER_IMAGE ||
    process.env.SCHIZM_IMAGE ||
    process.env.PROMPT_RUNNER_KUBE_EXECUTOR_IMAGE ||
    "",
  promptRunnerKubeImagePullPolicy:
    process.env.PROMPT_RUNNER_KUBE_IMAGE_PULL_POLICY || "Always",
  promptRunnerKubeJobTtlSeconds: parseNumber(
    process.env.PROMPT_RUNNER_KUBE_JOB_TTL_SECONDS,
    900
  ),
  promptRunnerKubeBackoffLimit: parseNumber(
    process.env.PROMPT_RUNNER_KUBE_BACKOFF_LIMIT,
    0
  ),
  promptRunnerKubeWorkspaceDir:
    process.env.PROMPT_RUNNER_KUBE_WORKSPACE_DIR || "/workspace/document-store",
  promptRunnerKubeRuntimeDir:
    process.env.PROMPT_RUNTIME_DIR || process.env.PROMPT_RUNNER_KUBE_RUNTIME_DIR || "/run/schizm",
  promptRunnerKubeRuntimeLayout:
    process.env.PROMPT_RUNNER_KUBE_RUNTIME_LAYOUT === "isolated"
      ? "isolated"
      : "single-container",
  promptRunnerAllowInProcessProduction: parseBoolean(
    process.env.PROMPT_RUNNER_ALLOW_IN_PROCESS_PRODUCTION,
    false
  ),
  nodeEnv: process.env.NODE_ENV || "development"
};

if (
  env.nodeEnv === "production" &&
  env.promptRunnerEnabled &&
  env.promptRunnerExecutionMode !== "kube-worker" &&
  !env.promptRunnerAllowInProcessProduction
) {
  throw new Error(
    "Production prompt execution must use PROMPT_RUNNER_EXECUTION_MODE=kube-worker. Set PROMPT_RUNNER_ALLOW_IN_PROCESS_PRODUCTION=true only for temporary break-glass debugging."
  );
}

export const resolveDocumentStoreRoot = (repoRoot: string) =>
  path.isAbsolute(env.documentStoreDir)
    ? env.documentStoreDir
    : path.join(repoRoot, env.documentStoreDir);

export type RuntimeConfig = {
  appTitle: string;
  graphTitle: string;
  graphSubtitle: string;
  defaultTheme: string;
  availableThemes: string[];
  canvasRefreshMs: number;
  graphqlEndpoint: string;
  graphqlWsEndpoint: string;
};

export const getRuntimeConfig = (): RuntimeConfig => ({
  appTitle: env.appTitle,
  graphTitle: env.graphTitle,
  graphSubtitle: env.graphSubtitle,
  defaultTheme: env.defaultTheme,
  availableThemes: env.availableThemes,
  canvasRefreshMs: env.canvasRefreshMs,
  graphqlEndpoint: env.graphqlEndpoint,
  graphqlWsEndpoint: env.graphqlWsUrl
});
