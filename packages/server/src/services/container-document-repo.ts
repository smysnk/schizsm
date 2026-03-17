import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const runGit = async (repoRoot: string, args: string[]) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8"
  });

  return stdout.trim();
};

const resolveCommitSha = async (repoRoot: string, sha: string) => {
  const normalized = sha.trim();

  if (!normalized) {
    return "";
  }

  try {
    return await runGit(repoRoot, ["rev-parse", `${normalized}^{commit}`]);
  } catch {
    return normalized;
  }
};

export type ContainerRepoVerificationResult = {
  branch: string;
  remoteName: string;
  baseSha: string | null;
  headSha: string;
  remoteSha: string;
  commitCount: number;
};

export const verifyContainerDocumentRepoPush = async ({
  repoRoot,
  remoteName,
  branch,
  expectedCommitSha,
  expectedBaseSha
}: {
  repoRoot: string;
  remoteName: string;
  branch: string;
  expectedCommitSha?: string | null;
  expectedBaseSha?: string | null;
}): Promise<ContainerRepoVerificationResult> => {
  const headSha = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const workingTreeStatus = await runGit(repoRoot, ["status", "--porcelain"]);
  const normalizedExpectedCommitSha = expectedCommitSha
    ? await resolveCommitSha(repoRoot, expectedCommitSha)
    : "";
  const normalizedExpectedBaseSha = expectedBaseSha
    ? await resolveCommitSha(repoRoot, expectedBaseSha)
    : "";

  if (normalizedExpectedCommitSha && headSha !== normalizedExpectedCommitSha) {
    throw new Error(
      `Container document store HEAD mismatch. Expected ${expectedCommitSha}, received ${headSha}.`
    );
  }

  if (workingTreeStatus) {
    throw new Error(
      `Container document store has uncommitted changes after Codex completed:\n${workingTreeStatus}`
    );
  }

  const commitCount = normalizedExpectedBaseSha
    ? Number.parseInt(
        await runGit(repoRoot, ["rev-list", "--count", `${normalizedExpectedBaseSha}..${headSha}`]),
        10
      )
    : 0;

  if (normalizedExpectedBaseSha && commitCount !== 1) {
    throw new Error(
      `Container document store commit verification failed. Expected exactly 1 commit after ${expectedBaseSha}, found ${commitCount}.`
    );
  }

  const remoteRef = `refs/heads/${branch}`;
  const remoteOutput = await runGit(repoRoot, ["ls-remote", remoteName, remoteRef]);

  if (!remoteOutput) {
    throw new Error(
      `Unable to resolve ${remoteName}/${branch} while verifying the container document store push.`
    );
  }

  const remoteSha = remoteOutput.split(/\s+/)[0] || "";

  if (!remoteSha) {
    throw new Error(
      `Remote ${remoteName}/${branch} did not return a commit SHA during verification.`
    );
  }

  if (remoteSha !== headSha) {
    throw new Error(
      `Container document store push verification failed. HEAD ${headSha} does not match ${remoteName}/${branch} ${remoteSha}.`
    );
  }

  return {
    branch,
    remoteName,
    baseSha: normalizedExpectedBaseSha || null,
    headSha,
    remoteSha,
    commitCount
  };
};
