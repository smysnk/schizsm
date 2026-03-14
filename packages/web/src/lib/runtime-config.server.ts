import path from "node:path";
import dotenv from "dotenv";
import type { PublicRuntimeConfig } from "./runtime-config";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toWebSocketUrl = (value: string) =>
  value.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

const serverOrigin = process.env.SERVER_URL || `http://127.0.0.1:${process.env.SERVER_PORT || "4000"}`;
const graphqlEndpoint = process.env.GRAPHQL_ENDPOINT || "/graphql";

export const getRuntimeConfig = (): PublicRuntimeConfig => ({
  appTitle: process.env.APP_TITLE || "Schizm",
  graphTitle: process.env.GRAPH_TITLE || "Connection Field",
  graphSubtitle:
    process.env.GRAPH_SUBTITLE ||
    "Map how fragments attract, collide, and reshape each other.",
  defaultTheme: process.env.DEFAULT_THEME || "signal",
  availableThemes: ["signal", "paper", "midnight"],
  canvasRefreshMs: parseNumber(process.env.CANVAS_REFRESH_MS, 30_000),
  graphqlEndpoint,
  graphqlWsEndpoint:
    process.env.GRAPHQL_WS_URL || `${toWebSocketUrl(serverOrigin)}${graphqlEndpoint}`
});
