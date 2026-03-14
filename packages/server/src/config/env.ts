import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

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
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:5432/schizm",
  dbSsl: parseBoolean(process.env.DB_SSL, false),
  seedDemoGraph: parseBoolean(process.env.SEED_DEMO_GRAPH, true),
  promptRunnerEnabled: parseBoolean(process.env.PROMPT_RUNNER_ENABLED, true),
  promptRunnerPollMs: parseNumber(process.env.PROMPT_RUNNER_POLL_MS, 5_000),
  promptRunnerCodexBin: process.env.CODEX_BIN || "codex",
  promptRunnerRepoRoot: resolveRepoRoot(),
  promptRunnerAutomationBranch:
    process.env.PROMPT_RUNNER_AUTOMATION_BRANCH || "codex/mindmap",
  promptRunnerRemoteName: process.env.PROMPT_RUNNER_REMOTE_NAME || "origin",
  promptRunnerReasoningEffort:
    process.env.PROMPT_RUNNER_REASONING_EFFORT || "medium",
  promptRunnerWorktreeRoot:
    process.env.PROMPT_RUNNER_WORKTREE_ROOT ||
    path.join(resolveRepoRoot(), ".codex-workdirs"),
  nodeEnv: process.env.NODE_ENV || "development"
};

export type RuntimeConfig = {
  appTitle: string;
  graphTitle: string;
  graphSubtitle: string;
  defaultTheme: string;
  availableThemes: string[];
  canvasRefreshMs: number;
  graphqlEndpoint: string;
};

export const getRuntimeConfig = (): RuntimeConfig => ({
  appTitle: env.appTitle,
  graphTitle: env.graphTitle,
  graphSubtitle: env.graphSubtitle,
  defaultTheme: env.defaultTheme,
  availableThemes: env.availableThemes,
  canvasRefreshMs: env.canvasRefreshMs,
  graphqlEndpoint: env.graphqlEndpoint
});
