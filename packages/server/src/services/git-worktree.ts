import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

type GitOutput = {
  stdout: string;
  stderr: string;
};

export type PreparedPromptWorktree = {
  repoRoot: string;
  worktreeRoot: string;
  worktreePath: string;
  automationBranch: string;
  promptBranch: string;
  remoteName: string;
  remoteConfigured: boolean;
  baseRef: string;
  documentStoreDir: string;
  documentStoreSeedMode: "branch" | "legacy" | "base";
  documentStoreSeedPaths: string[];
  controllerSyncedPaths: string[];
  controllerRemovedPaths: string[];
};

export type FinalizedPromptWorktree = {
  promptBranch: string;
  automationBranch: string;
  promptCommitSha: string;
  automationCommitSha: string;
  worktreeRemoved: boolean;
  promptBranchDeleted: boolean;
  remotePromptBranchDeleted: boolean;
};

const execFileAsync = promisify(execFile);
const CONTROLLER_DOC_PATHS = new Set([
  "README.md",
  "program.md",
  "prompt-agent-implementation-plan.md",
  "AGENTS.md"
]);
const LEGACY_KNOWLEDGE_IGNORED_PREFIXES = [
  ".codex-runs/",
  ".codex-workdirs/",
  ".git/",
  ".next/",
  ".yarn/",
  "node_modules/",
  "packages/",
  "references/",
  "schemas/",
  "scripts/"
];

const runGit = async (repoRoot: string, args: string[], cwd = repoRoot): Promise<GitOutput> => {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: process.env
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
};

const runGitText = async (repoRoot: string, args: string[], cwd = repoRoot) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  return stdout;
};

const tryGit = async (repoRoot: string, args: string[], cwd = repoRoot) => {
  try {
    return await runGit(repoRoot, args, cwd);
  } catch (_error) {
    return null;
  }
};

const branchExists = async (repoRoot: string, branchName: string) =>
  Boolean(await tryGit(repoRoot, ["rev-parse", "--verify", branchName]));

const remoteExists = async (repoRoot: string, remoteName: string) =>
  Boolean(await tryGit(repoRoot, ["remote", "get-url", remoteName]));

const sanitizePromptBranchName = (promptId: string) =>
  `codex/run-${promptId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;

const isWithinDirectory = (relativePath: string, directory: string) =>
  relativePath === directory || relativePath.startsWith(`${directory}/`);

const shouldTreatAsLegacyKnowledge = (
  relativePath: string,
  documentStoreDir: string
) => {
  if (!/\.(md|canvas)$/i.test(relativePath)) {
    return false;
  }

  if (isWithinDirectory(relativePath, documentStoreDir)) {
    return false;
  }

  if (CONTROLLER_DOC_PATHS.has(relativePath)) {
    return false;
  }

  return !LEGACY_KNOWLEDGE_IGNORED_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix)
  );
};

const listRefFiles = async (repoRoot: string, ref: string) => {
  const output = await runGitText(repoRoot, ["ls-tree", "-r", "--name-only", ref]);

  return output
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
};

const listWorktreeFiles = async (worktreePath: string) => {
  const output = await runGitText(worktreePath, ["ls-files"], worktreePath);

  return output
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
};

const readRefText = async (repoRoot: string, ref: string, relativePath: string) =>
  runGitText(repoRoot, ["show", `${ref}:${relativePath}`]);

const writeTextFile = async (
  worktreePath: string,
  relativePath: string,
  contents: string
) => {
  const targetPath = path.join(worktreePath, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, "utf8");
};

const removeFileIfPresent = async (worktreePath: string, relativePath: string) => {
  await fs.rm(path.join(worktreePath, relativePath), { force: true });
};

const rewriteLegacyCanvasForDocumentStore = (rawCanvas: string) => {
  try {
    const parsed = JSON.parse(rawCanvas) as {
      nodes?: Array<Record<string, unknown>>;
    };

    if (!Array.isArray(parsed.nodes)) {
      return rawCanvas;
    }

    const rewrites = new Map([
      ["README.md", "../README.md"],
      ["program.md", "../program.md"],
      ["prompt-agent-implementation-plan.md", "../prompt-agent-implementation-plan.md"],
      ["AGENTS.md", "../AGENTS.md"]
    ]);

    parsed.nodes = parsed.nodes.map((node) => {
      if (
        node &&
        typeof node === "object" &&
        typeof node.file === "string" &&
        rewrites.has(node.file)
      ) {
        return {
          ...node,
          file: rewrites.get(node.file)
        };
      }

      return node;
    });

    return JSON.stringify(parsed, null, 2);
  } catch (_error) {
    return rawCanvas;
  }
};

const migrateLegacyKnowledgeIntoDocumentStore = async ({
  worktreePath,
  documentStoreDir
}: {
  worktreePath: string;
  documentStoreDir: string;
}) => {
  const trackedFiles = await listWorktreeFiles(worktreePath);
  const legacyPaths = trackedFiles.filter((relativePath) =>
    shouldTreatAsLegacyKnowledge(relativePath, documentStoreDir)
  );

  if (!legacyPaths.length) {
    return [];
  }

  await fs.mkdir(path.join(worktreePath, documentStoreDir), { recursive: true });

  const migratedPaths: string[] = [];

  for (const relativePath of legacyPaths) {
    const destinationPath =
      relativePath === "audit.md" || relativePath === "main.canvas"
        ? path.join(documentStoreDir, path.basename(relativePath))
        : path.join(documentStoreDir, relativePath);
    const sourcePath = path.join(worktreePath, relativePath);
    let contents = await fs.readFile(sourcePath, "utf8");

    if (relativePath === "main.canvas") {
      contents = rewriteLegacyCanvasForDocumentStore(contents);
    }

    await writeTextFile(worktreePath, destinationPath, contents);
    migratedPaths.push(destinationPath);
  }

  return migratedPaths;
};

const seedDocumentStoreFromBaseRef = async ({
  repoRoot,
  worktreePath,
  baseRef,
  documentStoreDir
}: {
  repoRoot: string;
  worktreePath: string;
  baseRef: string;
  documentStoreDir: string;
}) => {
  const basePaths = (await listRefFiles(repoRoot, baseRef)).filter((relativePath) =>
    isWithinDirectory(relativePath, documentStoreDir)
  );

  for (const relativePath of basePaths) {
    await writeTextFile(
      worktreePath,
      relativePath,
      await readRefText(repoRoot, baseRef, relativePath)
    );
  }

  return basePaths;
};

const syncControllerPathsFromBaseRef = async ({
  repoRoot,
  worktreePath,
  baseRef,
  promptBranch,
  documentStoreDir
}: {
  repoRoot: string;
  worktreePath: string;
  baseRef: string;
  promptBranch: string;
  documentStoreDir: string;
}) => {
  const [basePaths, promptPaths] = await Promise.all([
    listRefFiles(repoRoot, baseRef),
    listRefFiles(repoRoot, promptBranch)
  ]);

  const basePathSet = new Set(basePaths);
  const allPaths = [...new Set([...basePaths, ...promptPaths])]
    .filter((relativePath) => !isWithinDirectory(relativePath, documentStoreDir))
    .sort();
  const syncedPaths: string[] = [];
  const removedPaths: string[] = [];

  for (const relativePath of allPaths) {
    if (basePathSet.has(relativePath)) {
      await writeTextFile(
        worktreePath,
        relativePath,
        await readRefText(repoRoot, baseRef, relativePath)
      );
      syncedPaths.push(relativePath);
      continue;
    }

    await removeFileIfPresent(worktreePath, relativePath);
    removedPaths.push(relativePath);
  }

  return {
    syncedPaths,
    removedPaths
  };
};

const resolveBaseRef = async (repoRoot: string) => {
  for (const candidate of ["main", "master", "HEAD"]) {
    if (candidate === "HEAD" || (await branchExists(repoRoot, candidate))) {
      return candidate;
    }
  }

  return "HEAD";
};

export const ensureGitRepository = async (repoRoot: string) => {
  const result = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);

  if (result.stdout !== "true") {
    throw new Error(`${repoRoot} is not a Git work tree.`);
  }
};

export const ensureAutomationBranch = async ({
  repoRoot,
  automationBranch,
  remoteName
}: {
  repoRoot: string;
  automationBranch: string;
  remoteName: string;
}) => {
  if (!(await branchExists(repoRoot, automationBranch))) {
    const baseRef = await resolveBaseRef(repoRoot);
    await runGit(repoRoot, ["branch", automationBranch, baseRef]);
  }

  if (await remoteExists(repoRoot, remoteName)) {
    await runGit(repoRoot, ["push", "-u", remoteName, automationBranch]);
    return true;
  }

  return false;
};

export const preparePromptWorktree = async ({
  repoRoot,
  worktreeRoot,
  automationBranch,
  promptId,
  remoteName,
  documentStoreDir
}: {
  repoRoot: string;
  worktreeRoot: string;
  automationBranch: string;
  promptId: string;
  remoteName: string;
  documentStoreDir: string;
}): Promise<PreparedPromptWorktree> => {
  await ensureGitRepository(repoRoot);
  await fs.mkdir(worktreeRoot, { recursive: true });

  const baseRef = await resolveBaseRef(repoRoot);
  const remoteConfigured = await ensureAutomationBranch({
    repoRoot,
    automationBranch,
    remoteName
  });
  const worktreePath = path.join(worktreeRoot, promptId);
  const promptBranch = sanitizePromptBranchName(promptId);

  if (existsSync(worktreePath)) {
    throw new Error(`Prompt worktree path already exists: ${worktreePath}`);
  }

  if (await branchExists(repoRoot, promptBranch)) {
    throw new Error(`Prompt branch already exists: ${promptBranch}`);
  }

  await runGit(repoRoot, ["worktree", "add", "-b", promptBranch, worktreePath, automationBranch]);

  let documentStoreSeedMode: PreparedPromptWorktree["documentStoreSeedMode"] = "branch";
  let documentStoreSeedPaths: string[] = [];
  const documentStoreRoot = path.join(worktreePath, documentStoreDir);

  if (!existsSync(documentStoreRoot)) {
    documentStoreSeedPaths = await migrateLegacyKnowledgeIntoDocumentStore({
      worktreePath,
      documentStoreDir
    });

    if (documentStoreSeedPaths.length) {
      documentStoreSeedMode = "legacy";
    } else {
      documentStoreSeedPaths = await seedDocumentStoreFromBaseRef({
        repoRoot,
        worktreePath,
        baseRef,
        documentStoreDir
      });
      documentStoreSeedMode = "base";
    }
  }

  const controllerSync = await syncControllerPathsFromBaseRef({
    repoRoot,
    worktreePath,
    baseRef,
    promptBranch,
    documentStoreDir
  });

  if (remoteConfigured) {
    await runGit(repoRoot, ["push", "-u", remoteName, promptBranch], worktreePath);
  }

  return {
    repoRoot,
    worktreeRoot,
    worktreePath,
    automationBranch,
    promptBranch,
    remoteName,
    remoteConfigured,
    baseRef,
    documentStoreDir,
    documentStoreSeedMode,
    documentStoreSeedPaths,
    controllerSyncedPaths: controllerSync.syncedPaths,
    controllerRemovedPaths: controllerSync.removedPaths
  };
};

export const finalizePromptWorktree = async (
  prepared: PreparedPromptWorktree
): Promise<FinalizedPromptWorktree> => {
  const promptCommitSha = (
    await runGit(prepared.repoRoot, ["rev-parse", prepared.promptBranch])
  ).stdout;

  await runGit(prepared.repoRoot, ["branch", "-f", prepared.automationBranch, promptCommitSha]);

  if (prepared.remoteConfigured) {
    await runGit(prepared.repoRoot, ["push", prepared.remoteName, prepared.automationBranch]);
  }

  await runGit(prepared.repoRoot, ["worktree", "remove", prepared.worktreePath]);
  await runGit(prepared.repoRoot, ["branch", "-D", prepared.promptBranch]);

  let remotePromptBranchDeleted = false;

  if (prepared.remoteConfigured) {
    await runGit(prepared.repoRoot, ["push", prepared.remoteName, "--delete", prepared.promptBranch]);
    remotePromptBranchDeleted = true;
  }

  return {
    promptBranch: prepared.promptBranch,
    automationBranch: prepared.automationBranch,
    promptCommitSha,
    automationCommitSha: (
      await runGit(prepared.repoRoot, ["rev-parse", prepared.automationBranch])
    ).stdout,
    worktreeRemoved: !existsSync(prepared.worktreePath),
    promptBranchDeleted: !(await branchExists(prepared.repoRoot, prepared.promptBranch)),
    remotePromptBranchDeleted
  };
};
