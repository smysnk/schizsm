import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPromptTimingToAuditSection,
  buildPromptTimingDetails
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
      finalizedAt: "2026-03-18T03:05:30.000Z"
    });

    assert.equal(result.timing.queueWaitMs, 120_000);
    assert.equal(result.timing.processingMs, 210_000);

    const updatedAudit = await readFile(auditPath, "utf8");
    assert.match(updatedAudit, /### Timing/);
    assert.match(updatedAudit, /- Time In Queue: 2m \(120000 ms\)/);
    assert.match(updatedAudit, /- Processing Time: 3m 30s \(210000 ms\)/);
    assert.match(updatedAudit, /"timing": \{/);
    assert.match(updatedAudit, /"queueWaitMs": 120000/);
    assert.match(updatedAudit, /"processingMs": 210000/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
