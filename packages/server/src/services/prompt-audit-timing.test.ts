import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPromptTimingToAuditSection,
  buildPromptTimingDetails,
  type PromptPerformanceDetails
} from "./prompt-audit-timing";

test("buildPromptTimingDetails computes queue and processing durations", () => {
  const details = buildPromptTimingDetails({
    createdAt: "2026-03-18T03:00:00.000Z",
    startedAt: "2026-03-18T03:02:30.000Z",
    finalizedAt: "2026-03-18T03:05:00.000Z"
  });

  assert.equal(details.queueWaitMs, 150_000);
  assert.equal(details.processingMs, 150_000);
});

test("appendPromptTimingToAuditSection appends timing markdown and timing json", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "schizm-audit-timing-"));
  const auditPath = path.join(tempRoot, "audit.md");

  try {
    const performance: PromptPerformanceDetails = {
      totalRuntimeMs: 210_000,
      dockerOperationsMs: 12_000,
      gitOperationsMs: 8_500,
      gitOperationCount: 4,
      agentWorkMs: 140_000,
      canvasRearrangeMs: 1_500,
      saveStatsToAuditMs: 300,
      gitCommitMs: 2_000,
      gitPushMs: 3_200,
      exitContainerMs: 450,
      steps: {
        runtimeSetupMs: 12_000,
        preflightCanvasValidationMs: 80,
        outputReadMs: 45,
        postflightCanvasValidationMs: 90,
        auditSyncMs: 500,
        finalizationMs: 650
      }
    };

    await writeFile(
      auditPath,
      `# Audit

<!-- PROMPT-AUDIT-START:test-prompt -->
## Prompt Round

- Date: 2026-03-18T03:05:00.000Z
- Prompt ID: test-prompt
- Input Prompt: hello world

\`\`\`json
{
  "promptId": "test-prompt",
  "added": [],
  "modified": [
    "obsidian-repository/audit.md"
  ],
  "deleted": [],
  "moved": [],
  "canvas": [],
  "contextualRelevance": [],
  "hypotheses": {},
  "rationales": {}
}
\`\`\`
<!-- PROMPT-AUDIT-END:test-prompt -->
`,
      "utf8"
    );

    const result = await appendPromptTimingToAuditSection({
      auditPath,
      promptId: "test-prompt",
      createdAt: "2026-03-18T03:00:00.000Z",
      startedAt: "2026-03-18T03:02:00.000Z",
      finalizedAt: "2026-03-18T03:05:30.000Z",
      performance
    });

    assert.equal(result.timing.queueWaitMs, 120_000);
    assert.equal(result.timing.processingMs, 210_000);

    const updatedAudit = await readFile(auditPath, "utf8");
    assert.match(updatedAudit, /### Timing/);
    assert.match(updatedAudit, /- Time In Queue: 2m \(120000 ms\)/);
    assert.match(updatedAudit, /- Processing Time: 3m 30s \(210000 ms\)/);
    assert.match(updatedAudit, /### Profiling/);
    assert.match(updatedAudit, /- Docker Operations: 12s \(12000 ms\)/);
    assert.match(updatedAudit, /- Git Operations: 9s \(8500 ms\) across 4 commands/);
    assert.match(updatedAudit, /- Canvas Re-arranging: 2s \(1500 ms\)/);
    assert.match(updatedAudit, /"timing": \{/);
    assert.match(updatedAudit, /"queueWaitMs": 120000/);
    assert.match(updatedAudit, /"processingMs": 210000/);
    assert.match(updatedAudit, /"performance": \{/);
    assert.match(updatedAudit, /"gitOperationCount": 4/);
    assert.match(updatedAudit, /"canvasRearrangeMs": 1500/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
