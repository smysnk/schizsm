import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { expressMiddleware } from "@apollo/server/express4";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { useServer } from "graphql-ws/lib/use/ws";
import { WebSocketServer } from "ws";
import { env } from "./config/env";
import { runMigrations } from "./db/migrations";
import { pool } from "./db/pool";
import { resolvers } from "./graphql/resolvers";
import { typeDefs } from "./graphql/schema";
import { ensureDemoGraph } from "./repositories/graph-repository";
import { PromptRunner } from "./services/prompt-runner";
import { setPromptRunner } from "./services/prompt-runner-registry";
import {
  initializePromptWorkspaceEventListener,
  shutdownPromptWorkspaceEventListener
} from "./services/prompt-workspace-events";

const bootstrap = async () => {
  await runMigrations();

  if (env.seedDemoGraph) {
    await ensureDemoGraph();
  }
};

const startServer = async () => {
  try {
    await pool.query("SELECT 1");
    await bootstrap();
    await initializePromptWorkspaceEventListener();
  } catch (error) {
    console.error("Failed to initialize server", error);
    process.exit(1);
  }

  if (process.argv.includes("--migrate-only")) {
    console.log("Migrations completed.");
    await shutdownPromptWorkspaceEventListener().catch(() => undefined);
    await pool.end();
    return;
  }

  const app = express();
  const httpServer = createServer(app);
  const promptRunner = new PromptRunner();
  setPromptRunner(promptRunner);
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers
  });
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: env.graphqlEndpoint
  });
  const serverCleanup = useServer(
    {
      schema
    },
    wsServer
  );
  const server = new ApolloServer({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            }
          };
        }
      }
    ]
  });

  await server.start();

  app.get("/health", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (_error) {
      response.status(500).json({ status: "error" });
    }
  });

  app.use(
    env.graphqlEndpoint,
    cors({ origin: true, credentials: true }),
    express.json(),
    expressMiddleware(server)
  );

  httpServer.listen(env.serverPort, () => {
    console.log(`GraphQL server ready at ${env.serverUrl}${env.graphqlEndpoint}`);
    console.log(`GraphQL subscriptions ready at ${env.graphqlWsUrl}`);
    void promptRunner.start();
  });

  const shutdown = async () => {
    promptRunner.stop();
    await shutdownPromptWorkspaceEventListener().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
};

void startServer();
