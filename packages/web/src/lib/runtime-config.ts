export type PublicRuntimeConfig = {
  appTitle: string;
  graphTitle: string;
  graphSubtitle: string;
  defaultTheme: string;
  availableThemes: string[];
  canvasRefreshMs: number;
  graphqlEndpoint: string;
  graphqlWsEndpoint: string;
};

declare global {
  interface Window {
    __SCHIZM_RUNTIME__?: PublicRuntimeConfig;
  }
}

const fallbackConfig: PublicRuntimeConfig = {
  appTitle: "Schizm",
  graphTitle: "Connection Field",
  graphSubtitle: "Map how fragments attract, collide, and reshape each other.",
  defaultTheme: "signal",
  availableThemes: ["signal", "paper", "midnight"],
  canvasRefreshMs: 30_000,
  graphqlEndpoint: "/graphql",
  graphqlWsEndpoint: "ws://127.0.0.1:4000/graphql"
};

export const getRuntimeConfig = (): PublicRuntimeConfig => fallbackConfig;

export const readRuntimeConfig = (): PublicRuntimeConfig => {
  if (typeof window === "undefined") {
    return fallbackConfig;
  }

  return window.__SCHIZM_RUNTIME__ || fallbackConfig;
};
