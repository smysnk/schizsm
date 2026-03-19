import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const envModulePath = new URL("./env.ts", import.meta.url).pathname;
const repoRoot = path.resolve(path.dirname(envModulePath), "../../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

const inspectEnvValue = async ({
  cwd,
  explicitUrl,
  extraEnv
}: {
  cwd: string;
  explicitUrl?: string;
  extraEnv?: Record<string, string | undefined>;
}) => {
  const env = {
    ...process.env,
    ...extraEnv
  };

  if (explicitUrl !== undefined) {
    env.DOCUMENT_STORE_GIT_URL = explicitUrl;
  } else {
    delete env.DOCUMENT_STORE_GIT_URL;
  }

  const { stdout } = await execFileAsync(
    tsxBin,
    [
      "-e",
      `const mod = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify({ repoUrl: mod.env.promptRunnerContainerRepoUrl }));`
    ],
    {
      cwd,
      env,
      encoding: "utf8"
    }
  );

  return JSON.parse(stdout) as { repoUrl: string };
};

const importEnvModule = async ({
  cwd,
  extraEnv
}: {
  cwd: string;
  extraEnv?: Record<string, string | undefined>;
}) => {
  const env = {
    ...process.env,
    ...extraEnv
  };

  const { stdout } = await execFileAsync(
    tsxBin,
    [
      "-e",
      `const mod = require(${JSON.stringify(envModulePath)}); console.log(JSON.stringify({ executionMode: mod.env.promptRunnerExecutionMode, enabled: mod.env.promptRunnerEnabled }));`
    ],
    {
      cwd,
      env,
      encoding: "utf8"
    }
  );

  return JSON.parse(stdout) as { executionMode: string; enabled: boolean };
};

test("explicit process env overrides dotenv files for DOCUMENT_STORE_GIT_URL", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-env-config-"));
  const workspaceRoot = path.join(rootDirectory, "workspace");
  const serverCwd = path.join(workspaceRoot, "packages", "server");

  try {
    await mkdir(serverCwd, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".env"),
      "DOCUMENT_STORE_GIT_URL=git@github.com:example/root.git\n",
      "utf8"
    );
    await writeFile(
      path.join(serverCwd, ".env"),
      "DOCUMENT_STORE_GIT_URL=git@github.com:example/local.git\n",
      "utf8"
    );

    const inspected = await inspectEnvValue({
      cwd: serverCwd,
      explicitUrl: "git@github.com:example/explicit.git"
    });

    assert.equal(inspected.repoUrl, "git@github.com:example/explicit.git");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("package-local dotenv overrides repo-root dotenv when no explicit env is provided", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-env-config-local-"));
  const workspaceRoot = path.join(rootDirectory, "workspace");
  const serverCwd = path.join(workspaceRoot, "packages", "server");

  try {
    await mkdir(serverCwd, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".env"),
      "DOCUMENT_STORE_GIT_URL=git@github.com:example/root.git\n",
      "utf8"
    );
    await writeFile(
      path.join(serverCwd, ".env"),
      "DOCUMENT_STORE_GIT_URL=git@github.com:example/local.git\n",
      "utf8"
    );

    const inspected = await inspectEnvValue({
      cwd: serverCwd
    });

    assert.equal(inspected.repoUrl, "git@github.com:example/local.git");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("production server config rejects in-process prompt execution by default", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-env-production-guard-"));
  const workspaceRoot = path.join(rootDirectory, "workspace");
  const serverCwd = path.join(workspaceRoot, "packages", "server");

  try {
    await mkdir(serverCwd, { recursive: true });

    await assert.rejects(
      () =>
        execFileAsync(
          tsxBin,
          ["-e", `require(${JSON.stringify(envModulePath)});`],
          {
            cwd: serverCwd,
            env: {
              ...process.env,
              NODE_ENV: "production",
              PROMPT_RUNNER_ENABLED: "true",
              PROMPT_RUNNER_EXECUTION_MODE: "container"
            },
            encoding: "utf8"
          }
        ),
      /PROMPT_RUNNER_EXECUTION_MODE=kube-worker/
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("production server config allows kube-worker prompt execution", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "schizm-env-production-kube-"));
  const workspaceRoot = path.join(rootDirectory, "workspace");
  const serverCwd = path.join(workspaceRoot, "packages", "server");

  try {
    await mkdir(serverCwd, { recursive: true });

    const inspected = await importEnvModule({
      cwd: serverCwd,
      extraEnv: {
        NODE_ENV: "production",
        PROMPT_RUNNER_ENABLED: "true",
        PROMPT_RUNNER_EXECUTION_MODE: "kube-worker"
      }
    });

    assert.equal(inspected.executionMode, "kube-worker");
    assert.equal(inspected.enabled, true);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
