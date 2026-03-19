import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PromptWorkerContract } from "./contract";

const execFileAsync = promisify(execFile);

const readOptionalTrimmedFile = async (filePath: string) => {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
};

const readSecretValue = async (envName: string, filePath: string) =>
  process.env[envName]?.trim() || (await readOptionalTrimmedFile(filePath));

const decodeBase64 = (encodedValue: string) => Buffer.from(encodedValue, "base64");

const extractGitHost = (repoUrl: string) => {
  if (/^git@[^:]+:/u.test(repoUrl)) {
    return repoUrl.replace(/^git@/u, "").split(":")[0] || "";
  }

  const sshUrlMatch = repoUrl.match(/^(?:ssh|https?):\/\/(?:[^@]+@)?([^/:]+)/u);
  return sshUrlMatch?.[1] || "";
};

const ensureDirectory = async (directoryPath: string, mode?: number) => {
  await fs.mkdir(directoryPath, { recursive: true });

  if (mode !== undefined) {
    await fs.chmod(directoryPath, mode);
  }
};

const runCommand = async (
  command: string,
  args: string[],
  {
    cwd,
    input
  }: {
    cwd?: string;
    input?: string;
  } = {}
) => {
  if (input === undefined) {
    return execFileAsync(command, args, {
      cwd,
      env: process.env,
      encoding: "utf8"
    });
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", reject);

    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}${
              signal ? ` (signal ${signal})` : ""
            }${stderr.trim() ? `: ${stderr.trim()}` : ""}`
          )
        );
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
};

export type WorkerRuntimePaths = {
  homeDir: string;
  codexHomeDir: string;
};

export const prepareWorkerRuntimePaths = async (
  contract: PromptWorkerContract
): Promise<WorkerRuntimePaths> => {
  const homeDir = path.join(contract.runtimeDir, "home");
  const codexHomeDir = path.join(homeDir, ".codex");

  await ensureDirectory(contract.runtimeDir, 0o700);
  await ensureDirectory(homeDir, 0o700);
  await ensureDirectory(codexHomeDir, 0o700);

  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codexHomeDir;
  process.env.PROMPT_RUNTIME_DIR = contract.runtimeDir;
  process.env.DOCUMENT_STORE_DIR = contract.workspaceDir;

  return {
    homeDir,
    codexHomeDir
  };
};

export const configureWorkerSsh = async (contract: PromptWorkerContract) => {
  const encodedPrivateKey = await readSecretValue(
    "DOCUMENT_STORE_SSH_PRIVATE_KEY_BASE64",
    path.join(contract.secretPaths.git, "id_ed25519.b64")
  );

  if (!encodedPrivateKey) {
    return null;
  }

  const homeDir = process.env.HOME || path.join(contract.runtimeDir, "home");
  const sshDir = path.join(homeDir, ".ssh");
  const keyPath = path.join(sshDir, "id_ed25519");
  const knownHostsPath = path.join(sshDir, "known_hosts");
  const configPath = path.join(sshDir, "config");
  const repoUrl =
    (await readSecretValue(
      "DOCUMENT_STORE_GIT_URL",
      path.join(contract.secretPaths.git, "repo-url")
    )) || process.env.DOCUMENT_STORE_GIT_URL || "";
  const gitHost = extractGitHost(repoUrl);

  await ensureDirectory(sshDir, 0o700);
  await fs.writeFile(keyPath, decodeBase64(encodedPrivateKey));
  await fs.chmod(keyPath, 0o600);
  await fs.writeFile(knownHostsPath, "", { flag: "a" });
  await fs.chmod(knownHostsPath, 0o600);

  if (gitHost) {
    try {
      const { stdout } = await runCommand("ssh-keyscan", ["-H", gitHost]);

      if (stdout.trim()) {
        await fs.appendFile(knownHostsPath, stdout, "utf8");
      }
    } catch {
      // `StrictHostKeyChecking accept-new` below is the fallback when keyscan is unavailable.
    }
  }

  await fs.writeFile(
    configPath,
    `Host *\n  IdentitiesOnly yes\n  IdentityFile ${keyPath}\n  UserKnownHostsFile ${knownHostsPath}\n  StrictHostKeyChecking accept-new\n`,
    "utf8"
  );
  await fs.chmod(configPath, 0o600);
  process.env.GIT_SSH_COMMAND = `ssh -F ${configPath}`;

  return {
    gitHost,
    keyPath,
    knownHostsPath
  };
};

export const configureWorkerCodexAuth = async (contract: PromptWorkerContract) => {
  const codexHomeDir = process.env.CODEX_HOME || path.join(contract.runtimeDir, "home", ".codex");
  const authPath = path.join(codexHomeDir, "auth.json");
  const encodedAuthJson = await readSecretValue(
    "CODEX_AUTH_JSON_BASE64",
    path.join(contract.secretPaths.codex, "auth.json.b64")
  );

  if (encodedAuthJson) {
    await ensureDirectory(codexHomeDir, 0o700);
    await fs.writeFile(authPath, decodeBase64(encodedAuthJson));
    await fs.chmod(authPath, 0o600);
    return {
      method: "auth-json",
      authPath
    };
  }

  const openAiApiKey = await readSecretValue(
    "OPENAI_API_KEY",
    path.join(contract.secretPaths.codex, "openai-api-key")
  );

  if (!openAiApiKey) {
    return {
      method: "none",
      authPath: null
    };
  }

  process.env.OPENAI_API_KEY = openAiApiKey;
  await runCommand(process.env.CODEX_BIN || "codex", ["login", "--with-api-key"], {
    input: `${openAiApiKey}\n`
  });

  return {
    method: "api-key",
    authPath: existsSync(authPath) ? authPath : null
  };
};

export const syncWorkerDocumentStoreRepo = async (contract: PromptWorkerContract) => {
  const repoUrl = await readSecretValue(
    "DOCUMENT_STORE_GIT_URL",
    path.join(contract.secretPaths.git, "repo-url")
  );
  const branch =
    (await readSecretValue(
      "DOCUMENT_STORE_GIT_BRANCH",
      path.join(contract.secretPaths.git, "repo-branch")
    )) || "main";
  const authorName =
    (await readSecretValue(
      "DOCUMENT_STORE_GIT_AUTHOR_NAME",
      path.join(contract.secretPaths.git, "author-name")
    )) || "Schizm Bot";
  const authorEmail =
    (await readSecretValue(
      "DOCUMENT_STORE_GIT_AUTHOR_EMAIL",
      path.join(contract.secretPaths.git, "author-email")
    )) || "schizm-bot@smysnk.com";

  if (!repoUrl) {
    throw new Error("DOCUMENT_STORE_GIT_URL is required for kube-worker prompt execution.");
  }

  const repoRoot = contract.workspaceDir;
  await ensureDirectory(path.dirname(repoRoot));

  if (existsSync(path.join(repoRoot, ".git"))) {
    await runCommand("git", ["-C", repoRoot, "remote", "set-url", "origin", repoUrl]);
    await runCommand("git", ["-C", repoRoot, "fetch", "origin", branch]);
    await runCommand("git", ["-C", repoRoot, "checkout", "-B", branch, `origin/${branch}`]);
    await runCommand("git", ["-C", repoRoot, "reset", "--hard", `origin/${branch}`]);
    await runCommand("git", ["-C", repoRoot, "clean", "-fd"]);
  } else {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await runCommand("git", ["clone", "--branch", branch, "--single-branch", repoUrl, repoRoot]);
  }

  await runCommand("git", ["-C", repoRoot, "config", "user.name", authorName]);
  await runCommand("git", ["-C", repoRoot, "config", "user.email", authorEmail]);

  process.env.DOCUMENT_STORE_DIR = repoRoot;
  process.env.DOCUMENT_STORE_GIT_URL = repoUrl;
  process.env.DOCUMENT_STORE_GIT_BRANCH = branch;
  process.env.DOCUMENT_STORE_GIT_AUTHOR_NAME = authorName;
  process.env.DOCUMENT_STORE_GIT_AUTHOR_EMAIL = authorEmail;

  return {
    repoRoot,
    repoUrl,
    branch,
    authorName,
    authorEmail
  };
};
