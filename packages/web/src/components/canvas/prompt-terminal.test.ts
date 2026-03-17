import assert from "node:assert/strict";
import test from "node:test";
import type { PromptRecord, PromptStatus } from "../../lib/graphql";
import {
  buildPromptTerminalBuffer,
  buildPromptTerminalEntries,
  buildPromptTerminalWorkingEntry,
  getNextTypedTerminalEntries
} from "./prompt-terminal";

const createPromptRecord = (
  overrides: Partial<PromptRecord> & { status?: PromptStatus } = {}
): PromptRecord => ({
  id: "prompt-123",
  content: "I keep noticing that certain thoughts return at night.",
  status: "queued",
  metadata: {},
  audit: {},
  startedAt: null,
  finishedAt: null,
  errorMessage: null,
  createdAt: "2026-03-15T00:00:00.000Z",
  updatedAt: "2026-03-15T00:00:00.000Z",
  ...overrides
});

test("buildPromptTerminalEntries deduplicates lifecycle statuses and appends failure detail", () => {
  const prompt = createPromptRecord({
    status: "failed",
    errorMessage: "Worktree cleanup failed.",
    metadata: {
      runner: {
        statusTransitions: [
          { status: "queued", at: "2026-03-15T00:00:01.000Z" },
          { status: "scanning", at: "2026-03-15T00:00:02.000Z" },
          { status: "writing", at: "2026-03-15T00:00:03.000Z" },
          { status: "writing", at: "2026-03-15T00:00:04.000Z" }
        ]
      },
      failure: {
        stage: "committing",
        message: "Worktree cleanup failed."
      }
    }
  });

  const entries = buildPromptTerminalEntries(prompt);

  assert.deepEqual(
    entries.map((entry) => entry.text),
    [
      "OK",
      "",
      "# queued for isolated git + codex run",
      "# preparing isolated git worktree",
      "# running codex cli",
      "# run failed",
      "# error: Worktree cleanup failed."
    ]
  );
});

test("buildPromptTerminalEntries appends git details for completed prompts", () => {
  const prompt = createPromptRecord({
    status: "completed",
    audit: {
      branch: "codex/mindmap",
      sha: "1234567890abcdef1234567890abcdef12345678"
    },
    metadata: {
      runner: {
        statusTransitions: [
          { status: "queued", at: "2026-03-15T00:00:01.000Z" },
          { status: "scanning", at: "2026-03-15T00:00:02.000Z" },
          { status: "committing", at: "2026-03-15T00:00:03.000Z" }
        ]
      }
    }
  });

  const entries = buildPromptTerminalEntries(prompt);

  assert.equal(entries.at(-1)?.text, "# git: codex/mindmap @ 12345678");
  assert.ok(entries.some((entry) => entry.text === "# run complete"));
});

test("buildPromptTerminalEntries includes runner git context and operations when present", () => {
  const prompt = createPromptRecord({
    status: "scanning",
    metadata: {
      runner: {
        workingRepository: "git@github.com:smysnk/schizm.git",
        workingBranch: "codex/mindmap",
        gitOperations: [
          {
            at: "2026-03-16T23:37:00.000Z",
            repoRoot: "/app/obsidian-repository",
            command: "git fetch origin codex/mindmap"
          },
          {
            at: "2026-03-16T23:37:01.000Z",
            repoRoot: "/app/obsidian-repository",
            command: "git checkout -B codex/mindmap origin/codex/mindmap"
          }
        ],
        statusTransitions: [{ status: "scanning", at: "2026-03-16T23:37:02.000Z" }]
      }
    }
  });

  const entries = buildPromptTerminalEntries(prompt);

  assert.ok(entries.some((entry) => entry.text === "# repo: git@github.com:smysnk/schizm.git"));
  assert.ok(entries.some((entry) => entry.text === "# branch: codex/mindmap"));
  assert.ok(entries.some((entry) => entry.text === "# git op: git fetch origin codex/mindmap"));
  assert.ok(
    entries.some(
      (entry) =>
        entry.text === "# git op: git checkout -B codex/mindmap origin/codex/mindmap"
    )
  );
});

test("buildPromptTerminalWorkingEntry shows an active working line only for in-flight statuses", () => {
  const activePrompt = createPromptRecord({ status: "writing" });
  const completedPrompt = createPromptRecord({ status: "completed" });

  assert.deepEqual(buildPromptTerminalWorkingEntry(activePrompt, 2), {
    id: "working-prompt-123-writing",
    text: "# Working..",
    tone: "system",
    kind: "status"
  });
  assert.equal(buildPromptTerminalWorkingEntry(completedPrompt, 2), null);
});

test("buildPromptTerminalBuffer keeps user text plain, dims system lines with ansi, and emits CRLF", () => {
  const buffer = buildPromptTerminalBuffer("User line\ncontinued", [
    { id: "ack", text: "OK", tone: "system", kind: "ack" },
    { id: "blank", text: "", tone: "system", kind: "blank" },
    { id: "status", text: "# running codex cli", tone: "system", kind: "status" }
  ]);

  assert.equal(
    buffer,
    [
      "User line\r\ncontinued",
      "\u001b[2mOK\u001b[0m",
      "",
      "\u001b[2m# running codex cli\u001b[0m"
    ].join("\r\n")
  );
});

test("getNextTypedTerminalEntries types one character at a time and pauses at line boundaries", () => {
  const targetEntries = buildPromptTerminalEntries(null);

  const firstStep = getNextTypedTerminalEntries([], targetEntries, 40, 180);
  assert.deepEqual(firstStep, {
    entries: [
      {
        id: "ack",
        text: "O",
        tone: "system",
        kind: "ack"
      }
    ],
    delayMs: 40
  });

  const secondStep = getNextTypedTerminalEntries(firstStep?.entries || [], targetEntries, 40, 180);
  assert.deepEqual(secondStep, {
    entries: [
      {
        id: "ack",
        text: "OK",
        tone: "system",
        kind: "ack"
      }
    ],
    delayMs: 180
  });

  const thirdStep = getNextTypedTerminalEntries(secondStep?.entries || [], targetEntries, 40, 180);
  assert.deepEqual(thirdStep, {
    entries: [
      {
        id: "ack",
        text: "OK",
        tone: "system",
        kind: "ack"
      },
      {
        id: "spacer",
        text: "",
        tone: "system",
        kind: "blank"
      }
    ],
    delayMs: 180
  });
});
