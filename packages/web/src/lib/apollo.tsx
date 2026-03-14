"use client";

import {
  ApolloClient,
  ApolloLink,
  ApolloProvider,
  HttpLink,
  InMemoryCache,
  split
} from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import {
  createContext,
  useContext,
  useState,
  type ReactNode
} from "react";
import type { PublicRuntimeConfig } from "./runtime-config";

export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

const RealtimeConnectionContext = createContext<RealtimeConnectionStatus>("idle");

const createApolloClient = (
  runtimeConfig: PublicRuntimeConfig,
  setConnectionStatus: (status: RealtimeConnectionStatus) => void
) => {
  const httpLink = new HttpLink({
    uri: runtimeConfig.graphqlEndpoint,
    credentials: "same-origin"
  });

  const wsLink =
    typeof window === "undefined"
      ? null
      : new GraphQLWsLink(
          createClient({
            url: runtimeConfig.graphqlWsEndpoint,
            lazy: true,
            retryAttempts: 10,
            shouldRetry: () => true,
            on: {
              opened: () => setConnectionStatus("connecting"),
              connected: () => setConnectionStatus("connected"),
              closed: () => setConnectionStatus("reconnecting"),
              error: () => setConnectionStatus("error")
            }
          })
        );

  const link =
    wsLink === null
      ? httpLink
      : split(
          ({ query }) => {
            const definition = getMainDefinition(query);
            return (
              definition.kind === "OperationDefinition" &&
              definition.operation === "subscription"
            );
          },
          wsLink,
          ApolloLink.from([httpLink])
        );

  return new ApolloClient({
    cache: new InMemoryCache(),
    devtools: {
      enabled: process.env.NODE_ENV !== "production"
    },
    link
  });
};

export function ApolloRuntimeProvider({
  children,
  runtimeConfig
}: {
  children: ReactNode;
  runtimeConfig: PublicRuntimeConfig;
}) {
  const [connectionStatus, setConnectionStatus] =
    useState<RealtimeConnectionStatus>("idle");
  const [client] = useState(() =>
    createApolloClient(runtimeConfig, setConnectionStatus)
  );

  return (
    <RealtimeConnectionContext.Provider value={connectionStatus}>
      <ApolloProvider client={client}>{children}</ApolloProvider>
    </RealtimeConnectionContext.Provider>
  );
}

export const useRealtimeConnectionStatus = () => useContext(RealtimeConnectionContext);
