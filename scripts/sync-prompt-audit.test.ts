import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuditPayload,
  extractAuditSection,
  extractJsonBlock
} from "./sync-prompt-audit";

test("sync prompt audit preserves contextual relevance and hypothesis state", () => {
  const promptId = "prompt-123";
  const auditSource = `# Audit

<!-- PROMPT-AUDIT-START:${promptId} -->
## Prompt Round

- Date: 2026-03-16T03:12:45Z
- Prompt ID: ${promptId}
- Input Prompt: Example prompt

### Files Added
- \`obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md\`: tracked as a tentative bridge

### Files Modified
- \`obsidian-repository/main.canvas\`: linked the hypothesis to both notes

### Files Deleted
- None.

### Files Moved or Renamed
- None.

### Canvas Updates
- \`obsidian-repository/main.canvas\`: added a tentative hypothesis node

### Contextual Relevance
- \`obsidian-repository/fragments/repeated-clock-time.md\`: may relate to the later frequency illusion concept

### Hypotheses
- \`obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md\`: created as a tentative explanation link

### Timing
- Queued At: 2026-03-16T03:10:00Z
- Started At: 2026-03-16T03:11:00Z
- Finalized At: 2026-03-16T03:12:45Z
- Time In Queue: 1m (60000 ms)
- Processing Time: 1m 45s (105000 ms)

### Git
- Branch: codex/mindmap
- Commit: deadbeef

\`\`\`json
{
  "promptId": "${promptId}",
  "branch": "codex/mindmap",
  "sha": "deadbeef",
  "decision": {
    "mode": "create"
  },
  "added": [
    "obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md"
  ],
  "modified": [
    "obsidian-repository/main.canvas"
  ],
  "deleted": [],
  "moved": [],
  "canvas": [
    "obsidian-repository/main.canvas"
  ],
  "contextualRelevance": [
    {
      "path": "obsidian-repository/fragments/repeated-clock-time.md",
      "relationship": "may be an instance later explained by the frequency illusion concept",
      "disposition": "related_but_unproven"
    }
  ],
  "timing": {
    "queuedAt": "2026-03-16T03:10:00Z",
    "startedAt": "2026-03-16T03:11:00Z",
    "finalizedAt": "2026-03-16T03:12:45Z",
    "queueWaitMs": 60000,
    "processingMs": 105000
  },
  "performance": {
    "totalRuntimeMs": 105000,
    "dockerOperationsMs": 5000,
    "gitOperationsMs": 1800,
    "gitOperationCount": 3,
    "agentWorkMs": 80000,
    "canvasRearrangeMs": 1200,
    "saveStatsToAuditMs": 200,
    "gitCommitMs": null,
    "gitPushMs": null,
    "exitContainerMs": null,
    "steps": {
      "runtimeSetupMs": 5000,
      "preflightCanvasValidationMs": 40,
      "outputReadMs": 20,
      "postflightCanvasValidationMs": 70,
      "auditSyncMs": null,
      "finalizationMs": null
    }
  },
  "hypotheses": {
    "created": [
      "obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md"
    ],
    "updated": [],
    "strengthened": [],
    "weakened": [],
    "disproved": [],
    "resolved": []
  },
  "rationales": {
    "obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md": "Preserved a plausible but unproven relationship without asserting it as fact."
  }
}
\`\`\`
<!-- PROMPT-AUDIT-END:${promptId} -->
`;

  const { rawSection } = extractAuditSection(auditSource, promptId);
  const parsedJson = extractJsonBlock(rawSection);
  const payload = buildAuditPayload({
    promptId,
    rawSection,
    parsedJson,
    git: {
      available: true,
      branch: "codex/mindmap",
      sha: "feedface",
      error: null
    }
  });

  assert.equal(payload.recordedAt, "2026-03-16T03:12:45Z");
  assert.equal(payload.branch, "codex/mindmap");
  assert.equal(payload.sha, "feedface");
  assert.deepEqual(payload.contextualRelevance, [
    {
      path: "obsidian-repository/fragments/repeated-clock-time.md",
      relationship:
        "may be an instance later explained by the frequency illusion concept",
      disposition: "related_but_unproven"
    }
  ]);
  assert.deepEqual(payload.hypotheses, {
    created: [
      "obsidian-repository/hypotheses/repeated-clock-time-may-relate-to-frequency-illusion.md"
    ],
    updated: [],
    strengthened: [],
    weakened: [],
    disproved: [],
    resolved: []
  });
  assert.deepEqual(payload.timing, {
    queuedAt: "2026-03-16T03:10:00Z",
    startedAt: "2026-03-16T03:11:00Z",
    finalizedAt: "2026-03-16T03:12:45Z",
    queueWaitMs: 60000,
    processingMs: 105000
  });
  assert.deepEqual(payload.performance, {
    totalRuntimeMs: 105000,
    dockerOperationsMs: 5000,
    gitOperationsMs: 1800,
    gitOperationCount: 3,
    agentWorkMs: 80000,
    canvasRearrangeMs: 1200,
    saveStatsToAuditMs: 200,
    gitCommitMs: null,
    gitPushMs: null,
    exitContainerMs: null,
    steps: {
      runtimeSetupMs: 5000,
      preflightCanvasValidationMs: 40,
      outputReadMs: 20,
      postflightCanvasValidationMs: 70,
      auditSyncMs: null,
      finalizationMs: null
    }
  });
});
