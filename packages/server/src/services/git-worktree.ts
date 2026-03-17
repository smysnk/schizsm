import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

type GitOutput = {
  stdout: string;
  stderr: string;
};

type RefEntry = {
  path: string;
  mode: string;
  type: string;
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
  documentStoreSeedMode: "branch" | "legacy" | "base" | "clone";
  documentStoreSeedPaths: string[];
  documentStoreCloneRepoUrl: string | null;
  documentStoreCloneBranch: string | null;
  controllerSyncedPaths: string[];
  controllerRemovedPaths: string[];
  outerAutomationRemoteSync: boolean;
};

export type FinalizedPromptWorktree = {
  promptBranch: string;
  automationBranch: string;
  promptCommitSha: string;
  automationCommitSha: string;
  worktreeRemoved: boolean;
  promptBranchDeleted: boolean;
  remotePromptBranchDeleted: boolean;
  automationBranchPromoted: boolean;
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

const isGitIgnored = async (repoRoot: string, relativePath: string, cwd = repoRoot) => {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", relativePath], {
      cwd,
      env: process.env
    });
    return true;
  } catch (error) {
    const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;

    if (exitCode === 1 || exitCode === "1") {
      return false;
    }

    throw error;
  }
};

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

const parseLsTreeLine = (line: string): RefEntry | null => {
  const match = line.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\t(.+)$/);

  if (!match) {
    return null;
  }

  return {
    mode: match[1],
    type: match[2],
    path: match[3]
  };
};

const listRefEntries = async (repoRoot: string, ref: string) => {
  const output = await runGitText(repoRoot, ["ls-tree", "-r", ref]);

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseLsTreeLine(line);
      return parsed ? [parsed] : [];
    });
};

const listRefFiles = async (repoRoot: string, ref: string) => {
  const entries = await listRefEntries(repoRoot, ref);
  return entries.map((entry) => entry.path);
};

const listWorktreeFiles = async (worktreePath: string) => {
  const output = await runGitText(worktreePath, ["ls-files"], worktreePath);

  const trackedPaths = output
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

  const visiblePaths: string[] = [];

  for (const relativePath of trackedPaths) {
    if (!(await isGitIgnored(worktreePath, relativePath, worktreePath))) {
      visiblePaths.push(relativePath);
    }
  }

  return visiblePaths;
};

const readRefBuffer = async (repoRoot: string, ref: string, relativePath: string) => {
  const { stdout } = await execFileAsync("git", ["show", `${ref}:${relativePath}`], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });

  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
};

const readRefText = async (repoRoot: string, ref: string, relativePath: string) => {
  const buffer = await readRefBuffer(repoRoot, ref, relativePath);
  return buffer.toString("utf8");
};

const writeTextFile = async (
  worktreePath: string,
  relativePath: string,
  contents: string
) => {
  const targetPath = path.join(worktreePath, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, "utf8");
};

const removePathIfPresent = async (targetPath: string) => {
  try {
    const stat = await fs.lstat(targetPath);

    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    }

    await fs.rm(targetPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const removeFileIfPresent = async (worktreePath: string, relativePath: string) => {
  await removePathIfPresent(path.join(worktreePath, relativePath));
};

const syncTrackedEntry = async ({
  repoRoot,
  ref,
  entry,
  worktreePath
}: {
  repoRoot: string;
  ref: string;
  entry: RefEntry;
  worktreePath: string;
}) => {
  const targetPath = path.join(worktreePath, entry.path);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await removePathIfPresent(targetPath);

  if (entry.mode === "120000") {
    await fs.symlink(await readRefText(repoRoot, ref, entry.path), targetPath);
    return;
  }

  if (entry.type !== "blob") {
    return;
  }

  await fs.writeFile(targetPath, await readRefBuffer(repoRoot, ref, entry.path));
  await fs.chmod(targetPath, entry.mode === "100755" ? 0o755 : 0o644);
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
  const baseEntries = (await listRefEntries(repoRoot, baseRef)).filter((entry) =>
    isWithinDirectory(entry.path, documentStoreDir)
  );
  const visibleBaseEntries: RefEntry[] = [];

  for (const entry of baseEntries) {
    if (!(await isGitIgnored(repoRoot, entry.path))) {
      visibleBaseEntries.push(entry);
    }
  }

  for (const entry of visibleBaseEntries) {
    await syncTrackedEntry({
      repoRoot,
      ref: baseRef,
      entry,
      worktreePath
    });
  }

  return visibleBaseEntries.map((entry) => entry.path);
};

const cloneDocumentStoreRepo = async ({
  worktreePath,
  documentStoreDir,
  documentStoreGitUrl,
  documentStoreGitBranch
}: {
  worktreePath: string;
  documentStoreDir: string;
  documentStoreGitUrl: string;
  documentStoreGitBranch: string;
}) => {
  const documentStoreRoot = path.join(worktreePath, documentStoreDir);
  await removePathIfPresent(documentStoreRoot);
  await fs.mkdir(path.dirname(documentStoreRoot), { recursive: true });

  await execFileAsync(
    "git",
    [
      "clone",
      "--branch",
      documentStoreGitBranch,
      "--single-branch",
      "--no-tags",
      documentStoreGitUrl,
      documentStoreRoot
    ],
    {
      cwd: worktreePath,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const clonedFiles = await runGitText(documentStoreRoot, ["ls-files"], documentStoreRoot);
  return clonedFiles
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((relativePath) => path.posix.join(documentStoreDir.replace(/\\/gu, "/"), relativePath));
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
  const [baseEntries, promptEntries] = await Promise.all([
    listRefEntries(repoRoot, baseRef),
    listRefEntries(repoRoot, promptBranch)
  ]);
  const visibleBaseEntries: RefEntry[] = [];
  const visiblePromptEntries: RefEntry[] = [];

  for (const entry of baseEntries) {
    if (!(await isGitIgnored(repoRoot, entry.path))) {
      visibleBaseEntries.push(entry);
    }
  }

  for (const entry of promptEntries) {
    if (!(await isGitIgnored(repoRoot, entry.path))) {
      visiblePromptEntries.push(entry);
    }
  }

  const baseEntryMap = new Map(visibleBaseEntries.map((entry) => [entry.path, entry]));
  const basePaths = visibleBaseEntries.map((entry) => entry.path);
  const promptPaths = visiblePromptEntries.map((entry) => entry.path);
  const basePathSet = new Set(basePaths);
  const allPaths = [...new Set([...basePaths, ...promptPaths])]
    .filter((relativePath) => !isWithinDirectory(relativePath, documentStoreDir))
    .sort();
  const syncedPaths: string[] = [];
  const removedPaths: string[] = [];

  for (const relativePath of allPaths) {
    if (basePathSet.has(relativePath)) {
      const entry = baseEntryMap.get(relativePath);

      if (!entry) {
        continue;
      }

      await syncTrackedEntry({
        repoRoot,
        ref: baseRef,
        entry,
        worktreePath
      });
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

const syncDirectoryFromRef = async ({
  repoRoot,
  worktreePath,
  ref,
  directory
}: {
  repoRoot: string;
  worktreePath: string;
  ref: string;
  directory: string;
}) => {
  const refEntries = (await listRefEntries(repoRoot, ref)).filter((entry) =>
    isWithinDirectory(entry.path, directory)
  );
  const visibleRefEntries: RefEntry[] = [];

  for (const entry of refEntries) {
    if (!(await isGitIgnored(repoRoot, entry.path))) {
      visibleRefEntries.push(entry);
    }
  }

  const refEntryMap = new Map(visibleRefEntries.map((entry) => [entry.path, entry]));
  const refPathSet = new Set(visibleRefEntries.map((entry) => entry.path));
  const currentPaths = (await listWorktreeFiles(worktreePath)).filter((relativePath) =>
    isWithinDirectory(relativePath, directory)
  );
  const allPaths = [...new Set([...currentPaths, ...refPathSet])].sort();

  for (const relativePath of allPaths) {
    const entry = refEntryMap.get(relativePath);

    if (entry) {
      await syncTrackedEntry({
        repoRoot,
        ref,
        entry,
        worktreePath
      });
      continue;
    }

    await removeFileIfPresent(worktreePath, relativePath);
  }
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
  documentStoreDir,
  documentStoreGitUrl,
  documentStoreGitBranch
}: {
  repoRoot: string;
  worktreeRoot: string;
  automationBranch: string;
  promptId: string;
  remoteName: string;
  documentStoreDir: string;
  documentStoreGitUrl?: string | null;
  documentStoreGitBranch?: string | null;
}): Promise<PreparedPromptWorktree> => {
  await ensureGitRepository(repoRoot);
  await fs.mkdir(worktreeRoot, { recursive: true });

  const baseRef = await resolveBaseRef(repoRoot);
  const normalizedDocumentStoreGitUrl = documentStoreGitUrl?.trim() || "";
  const normalizedDocumentStoreGitBranch = documentStoreGitBranch?.trim() || "main";
  const outerAutomationRemoteSync = !normalizedDocumentStoreGitUrl;
  const remoteConfigured = outerAutomationRemoteSync
    ? await ensureAutomationBranch({
        repoRoot,
        automationBranch,
        remoteName
      })
    : false;
  const worktreePath = path.join(worktreeRoot, promptId);
  const promptBranch = sanitizePromptBranchName(promptId);
  const worktreeSeedRef = outerAutomationRemoteSync ? automationBranch : baseRef;

  if (existsSync(worktreePath)) {
    throw new Error(`Prompt worktree path already exists: ${worktreePath}`);
  }

  if (await branchExists(repoRoot, promptBranch)) {
    throw new Error(`Prompt branch already exists: ${promptBranch}`);
  }

  await runGit(repoRoot, ["worktree", "add", "-b", promptBranch, worktreePath, worktreeSeedRef]);

  let documentStoreSeedMode: PreparedPromptWorktree["documentStoreSeedMode"] = "branch";
  let documentStoreSeedPaths: string[] = [];
  const documentStoreRoot = path.join(worktreePath, documentStoreDir);

  if (normalizedDocumentStoreGitUrl) {
    documentStoreSeedPaths = await cloneDocumentStoreRepo({
      worktreePath,
      documentStoreDir,
      documentStoreGitUrl: normalizedDocumentStoreGitUrl,
      documentStoreGitBranch: normalizedDocumentStoreGitBranch
    });
    documentStoreSeedMode = "clone";
  } else if (!existsSync(documentStoreRoot)) {
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
    documentStoreCloneRepoUrl: normalizedDocumentStoreGitUrl || null,
    documentStoreCloneBranch: normalizedDocumentStoreGitUrl
      ? normalizedDocumentStoreGitBranch
      : null,
    controllerSyncedPaths: controllerSync.syncedPaths,
    controllerRemovedPaths: controllerSync.removedPaths,
    outerAutomationRemoteSync
  };
};

export const finalizePromptWorktree = async (
  prepared: PreparedPromptWorktree
): Promise<FinalizedPromptWorktree> => {
  const promptCommitSha = (
    await runGit(prepared.repoRoot, ["rev-parse", prepared.promptBranch])
  ).stdout;
  let automationCommitSha = "";
  let automationBranchPromoted = false;

  if (prepared.outerAutomationRemoteSync) {
    await runGit(prepared.repoRoot, ["branch", "-f", prepared.automationBranch, promptCommitSha]);

    if (prepared.remoteConfigured) {
      await runGit(prepared.repoRoot, ["push", prepared.remoteName, prepared.automationBranch]);
    }

    automationCommitSha = (
      await runGit(prepared.repoRoot, ["rev-parse", prepared.automationBranch])
    ).stdout;
    automationBranchPromoted = true;
  } else if (await branchExists(prepared.repoRoot, prepared.automationBranch)) {
    automationCommitSha = (
      await runGit(prepared.repoRoot, ["rev-parse", prepared.automationBranch])
    ).stdout;
  } else {
    automationCommitSha = promptCommitSha;
  }

  await runGit(prepared.repoRoot, ["reset", "--hard", prepared.promptBranch], prepared.worktreePath);

  if (prepared.documentStoreSeedMode === "clone") {
    await removePathIfPresent(path.join(prepared.worktreePath, prepared.documentStoreDir));
    await syncDirectoryFromRef({
      repoRoot: prepared.repoRoot,
      worktreePath: prepared.worktreePath,
      ref: prepared.promptBranch,
      directory: prepared.documentStoreDir
    });
  }

  await runGit(prepared.repoRoot, ["clean", "-ffdx"], prepared.worktreePath);

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
    automationCommitSha,
    worktreeRemoved: !existsSync(prepared.worktreePath),
    promptBranchDeleted: !(await branchExists(prepared.repoRoot, prepared.promptBranch)),
    remotePromptBranchDeleted,
    automationBranchPromoted
  };
};
