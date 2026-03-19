import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Prompt, JsonObject } from "../repositories/prompt-repository";
import { env } from "../config/env";
import { ensureGitRepository } from "../services/git-worktree";
import type { ContainerDocumentRepo, CodexRunOutput, RunArtifacts } from "./runtime-types";
import { runGit } from "./runtime-shared";

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readJsonFile = async (filePath: string): Promise<JsonObject> => {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!isJsonObject(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }

  return parsed;
};

export const buildPromptExecutionInstruction = ({
  prompt,
  repoRoot,
  executionRepoRoot,
  documentStoreRoot,
  programPath,
  auditPath,
  schemaPath,
  automationBranch,
  promptBranch,
  remoteName,
  expectedCommitSubject,
  documentStoreIsRepoRoot,
  documentStoreHasDedicatedGitRepo
}: {
  prompt: Prompt;
  repoRoot: string;
  executionRepoRoot: string;
  documentStoreRoot: string;
  programPath: string;
  auditPath: string;
  schemaPath: string;
  automationBranch: string;
  promptBranch: string;
  remoteName: string;
  expectedCommitSubject: string;
  documentStoreIsRepoRoot?: boolean;
  documentStoreHasDedicatedGitRepo?: boolean;
}) => `You are processing a queued repository-maintenance prompt for this project.

Repository root: ${repoRoot}
Execution repository root: ${executionRepoRoot}
Document store root: ${documentStoreRoot}
Program contract: ${programPath}
Audit log: ${auditPath}
Final output schema: ${schemaPath}
Prompt ID: ${prompt.id}
Automation branch: ${automationBranch}
Prompt branch: ${promptBranch}
Git remote: ${remoteName}

Before making changes:
- Read ${programPath} and follow it strictly.
- Inspect the current markdown corpus and canvas files under ${documentStoreRoot}.
- ${
  documentStoreIsRepoRoot
    ? `In this environment, the document store repository itself is the writable root. Treat references in program.md to obsidian-repository/ as meaning ${documentStoreRoot}.`
    : `Treat ${documentStoreRoot} as the only writable document store root.`
}
- ${
  documentStoreHasDedicatedGitRepo
    ? `The document store at ${documentStoreRoot} is its own dedicated Git repository. The runner will perform the final commit/push there, not in the outer controller repository at ${repoRoot}.`
    : `The runner will perform the final commit/push in the repository rooted at ${repoRoot}.`
}
- The default git working directory for this run is ${executionRepoRoot}. Make all file edits there, but leave the final git commit/push to the runner.
- Treat every path outside ${documentStoreRoot} as read-only unless the human explicitly asked otherwise.
- Treat ${path.join(repoRoot, "packages")} and ${path.join(repoRoot, "scripts")} as read-only unless absolutely required by the contract.

User prompt:
"""text
${prompt.content}
"""

Run requirements:
- Update markdown and canvas files according to the contract in program.md.
- Append exactly one audit section to ${auditPath} using the required markers for prompt ${prompt.id} if the run reaches a coherent stopping point.
- If you update canvas files, expect the runner to optionally run a configured canvas rearranging command before the final audit write and commit.
- Do not commit or push changes yourself. The runner will append timing details to the audit entry, then create the single final commit and push.
- Do not create intermediate commits for markdown changes, canvas updates, audit updates, or any other partial step.
- Use this exact final commit subject: ${JSON.stringify(expectedCommitSubject)}
- Return only a single JSON object that matches ${schemaPath}.
- The returned JSON must use promptId "${prompt.id}".
- In the returned JSON git object, report the target branch and leave commitSha as null with commitCreated=false and pushSucceeded=false.
`;

export const ensureContainerDocumentRepo = async ({
  gitOperations
}: {
  gitOperations?: JsonObject[];
} = {}): Promise<ContainerDocumentRepo> => {
  const repoRoot = path.resolve(env.documentStoreDir);

  if (!env.promptRunnerContainerRepoUrl.trim()) {
    throw new Error(
      "Container prompt runner mode requires DOCUMENT_STORE_GIT_URL to be configured."
    );
  }

  await ensureGitRepository(repoRoot);

  const remoteName = env.promptRunnerRemoteName;
  const remoteUrl = await runGit(repoRoot, ["remote", "get-url", remoteName], gitOperations).catch(
    () => ""
  );

  if (!remoteUrl) {
    throw new Error(
      `Container document store repo at ${repoRoot} is missing remote ${remoteName}.`
    );
  }

  if (remoteUrl !== env.promptRunnerContainerRepoUrl) {
    throw new Error(
      `Container document store remote mismatch. Expected ${env.promptRunnerContainerRepoUrl}, received ${remoteUrl}.`
    );
  }

  const branch = env.promptRunnerContainerRepoBranch;

  await runGit(repoRoot, ["fetch", remoteName, branch], gitOperations);
  await runGit(repoRoot, ["checkout", "-B", branch, `${remoteName}/${branch}`], gitOperations);
  await runGit(
    repoRoot,
    ["config", "user.name", env.promptRunnerContainerGitAuthorName],
    gitOperations
  );
  await runGit(
    repoRoot,
    ["config", "user.email", env.promptRunnerContainerGitAuthorEmail],
    gitOperations
  );

  return {
    repoRoot,
    documentStoreRoot: repoRoot,
    branch,
    remoteName,
    remoteUrl,
    remoteConfigured: true
  };
};

export const executePromptWithCodex = async ({
  instruction,
  artifacts,
  repoRoot,
  schemaPath
}: {
  instruction: string;
  artifacts: RunArtifacts;
  repoRoot: string;
  schemaPath: string;
}) => {
  const args = [
    "exec",
    "-C",
    repoRoot,
    "-s",
    "danger-full-access",
    "-c",
    `model_reasoning_effort="${env.promptRunnerReasoningEffort}"`,
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "-o",
    artifacts.outputPath,
    "-"
  ];

  await fs.writeFile(artifacts.instructionPath, instruction, "utf8");

  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const stdoutStream = createWriteStream(artifacts.stdoutPath, { flags: "a" });
      const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
      const child = spawn(env.promptRunnerCodexBin, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      child.stdout.pipe(stdoutStream);
      child.stderr.pipe(stderrStream);

      child.stdin.write(instruction);
      child.stdin.end();

      child.once("error", (error) => {
        stdoutStream.end();
        stderrStream.end();
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        stdoutStream.end();
        stderrStream.end();
        resolve({ exitCode, signal });
      });
    }
  );
};

export const readPromptExecutionOutput = async (
  outputPath: string
): Promise<JsonObject & CodexRunOutput> => readJsonFile(outputPath) as Promise<JsonObject & CodexRunOutput>;
