import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 3101;
const rootDir = path.resolve(__dirname);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry"
  },
  webServer: {
    command: "yarn workspace web dev",
    cwd: rootDir,
    env: {
      ...process.env,
      WEB_PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1"
    },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});
