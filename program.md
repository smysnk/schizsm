# schizm prompt agent

This repo runs inside an app-managed prompt-processing loop. The app owns prompt persistence, queue selection, lifecycle status, audit synchronization back into Postgres, and the eventual server-side invocation of Codex CLI. You own the repository judgment: how markdown is reorganized, how the Obsidian canvas is updated, and how the rationale for each change is recorded.

## Purpose

Turn this repository into a living, Obsidian-oriented mind map.

Each run starts from a user-submitted prompt stored in the `prompts` table. Your job is to interpret that prompt against the current markdown and canvas corpus, update the repository so the idea is captured in the most coherent place, keep the central canvas aligned with the revised knowledge graph, append a strict audit entry, and finish by committing and pushing the resulting changes.

The goal is not only to store ideas, but to connect them, restructure them, and keep the repository readable as the concept graph grows over time.

## Scope

Read these files for context:

- `README.md` for repo structure and local runtime behavior
- `prompt-agent-implementation-plan.md` for the implementation intent and lifecycle model
- `obsidian-repository/audit.md` for prior rounds and audit formatting expectations
- the current markdown corpus inside `obsidian-repository/`
- the canonical canvas at `obsidian-repository/main.canvas` and any other Obsidian canvas files inside `obsidian-repository/`

Files you may update:

- markdown files inside `obsidian-repository/`
- Obsidian canvas files inside `obsidian-repository/`
- `obsidian-repository/audit.md`
- newly created markdown files or folders inside `obsidian-repository/`
- newly created canvas files inside `obsidian-repository/` if justified by the prompt

Files you should treat as read-only unless the human explicitly asks otherwise:

- every path outside `obsidian-repository/`
- `program.md`
- `prompt-agent-implementation-plan.md`
- application source under `packages/`
- scripts under `scripts/`
- dependency files such as `package.json`, `yarn.lock`, or TypeScript config files

The coding agent is only allowed to add, modify, move, rename, or delete files within `obsidian-repository/`.

Also treat any file or directory matched by `.gitignore` as out of scope for scanning or modification unless the human explicitly asks otherwise, even if it exists on disk.

## Canonical Artifacts

The core artifacts for each prompt-processing run are:

- the user prompt content supplied by the app
- `obsidian-repository/audit.md`
- the canonical canvas at `obsidian-repository/main.canvas`
- every markdown file inside `obsidian-repository/` that is semantically relevant to the prompt

If `obsidian-repository/main.canvas` does not exist yet, create it as part of the first run that needs it.

## Operating Contract

The app or runner invokes you for one prompt at a time.

Your responsibilities during a run are:

1. Read the submitted prompt carefully.
2. Scan the existing markdown corpus and canvas files inside `obsidian-repository/` for relevant related content, while ignoring anything matched by `.gitignore`.
3. Decide how the new idea should be integrated.
4. Update markdown files and canvas files inside `obsidian-repository/` accordingly.
5. Append one strict audit section to `obsidian-repository/audit.md`.
6. Commit the resulting changes.
7. Push the commit to the configured remote branch.
8. Return a structured final response that matches `schemas/codex-run-output.schema.json`.

Do not stop after analysis. Finish the repository updates, audit entry, commit, push, and structured final response unless you are blocked by a real execution failure.

## Decision Modes

For every prompt, make an explicit decision about which of these modes best applies:

1. `create`
   Use this when the prompt introduces an idea that is distinct enough to deserve a new markdown document.

2. `integrate`
   Use this when the prompt materially changes an existing topic and should be merged into an existing document, including removing or rewriting content that is invalidated.

3. `append`
   Use this when the prompt belongs to an existing topic and should be appended, expanded, or rearranged within an existing document without a full conceptual rewrite.

Your final response must name one primary decision mode, even if the run includes secondary cleanup or restructuring work.

## Markdown Operations

You are allowed to:

- create markdown files
- modify markdown files
- delete markdown files
- rename markdown files
- move markdown files
- merge overlapping markdown files
- split a markdown file into multiple files if that improves clarity
- remove obsolete content when it is contradicted by stronger or newer ideas

You should prefer changes that improve:

- conceptual clarity
- discoverability
- internal consistency
- navigability inside Obsidian

You should avoid churn that does not materially improve organization.

## Canvas Contract

Maintain `obsidian-repository/main.canvas` as the central conceptual map.

When markdown files are created, removed, renamed, moved, or substantially repurposed:

- update `obsidian-repository/main.canvas`
- reflect the current file set and their conceptual relationships
- keep the layout neat and readable
- avoid duplicated or orphaned nodes when possible

When a file is deleted or merged away, remove or retarget the corresponding canvas representation.

When a file is renamed or moved, preserve continuity in the canvas where practical rather than recreating the entire map from scratch.

If a prompt causes a major conceptual reorganization, the canvas should be reorganized to match the new topology rather than merely patched.

## Audit Contract

Append exactly one section to `obsidian-repository/audit.md` for each completed run.

The section must use these boundaries:

- `<!-- PROMPT-AUDIT-START:<prompt-id> -->`
- `<!-- PROMPT-AUDIT-END:<prompt-id> -->`

Inside those boundaries, include:

- a `## Prompt Round` heading
- date/time
- prompt id
- input prompt
- files added
- files modified
- files deleted
- files moved or renamed
- canvas updates
- git branch
- git commit SHA
- rationale for every changed artifact

Also include one fenced `json` block inside the section containing a machine-readable summary for the run.

The audit entry must be append-only. Do not rewrite prior audit sections unless the human explicitly asks for audit repair.

## Strict Audit Section Template

Use this exact shape as the audit skeleton:

````md
<!-- PROMPT-AUDIT-START:<prompt-id> -->
## Prompt Round

- Date: <ISO-8601 timestamp>
- Prompt ID: <prompt-id>
- Input Prompt: <verbatim prompt content>

### Files Added
- `path/to/file.md`: rationale

### Files Modified
- `path/to/file.md`: rationale

### Files Deleted
- `path/to/file.md`: rationale

### Files Moved or Renamed
- `old/path.md` -> `new/path.md`: rationale

### Canvas Updates
- `obsidian-repository/main.canvas`: rationale

### Git
- Branch: <branch-name>
- Commit: <commit-sha>

```json
{
  "promptId": "<prompt-id>",
  "branch": "<branch-name>",
  "sha": "<commit-sha>",
  "decision": {
    "mode": "create"
  },
  "added": [],
  "modified": [],
  "deleted": [],
  "moved": [],
  "canvas": [],
  "rationales": {}
}
```
<!-- PROMPT-AUDIT-END:<prompt-id> -->
````

Empty sections are allowed when no changes of that type occurred, but the section headings must still be present.

## Git Contract

You are required to finish each successful run with git commit and git push.

Expect the automation branch to be managed outside this file, but your run must:

- inspect the working tree
- stage the intended repository changes
- create a commit that clearly references the prompt id
- push the resulting commit to the configured remote branch

Preferred commit message shape:

```text
prompt(<prompt-id>): reorganize knowledge base for submitted idea
```

Do not reset, discard unrelated changes, or rewrite history unless the human explicitly asks for that.

## Structured Final Output

Your final response must match:

- `schemas/codex-run-output.schema.json`

The final response must summarize:

- which decision mode was chosen
- which files changed inside `obsidian-repository/`
- whether `obsidian-repository/audit.md` was updated
- whether `obsidian-repository/main.canvas` was updated
- the final git branch and commit SHA
- whether push succeeded
- any blockers or follow-up notes

Return the structured final output only after repository updates, audit append, commit, and push are complete.

## Quality Bar

A strong run should leave the repository in a state where:

- the new idea is easy to find
- duplicate or contradictory knowledge is reduced rather than amplified
- the main canvas in `obsidian-repository/` reflects the current conceptual relationships
- the audit log makes the rationale legible to a future reader

Prefer a smaller number of coherent changes over a larger number of shallow edits.

## Failure Handling

If you hit a hard blocker:

- preserve any useful file edits already made
- append no audit section unless the run reached a coherent stopping point
- do not create a fake commit or fake push result
- describe the blocker honestly in the structured final output

If push fails after repository edits were made and committed:

- report the failure honestly
- include the local branch and commit SHA in the structured final output
- do not pretend the remote state is current

If no repository change is warranted after scanning the prompt:

- still append an audit section describing the no-op decision
- still produce a commit only if a real file change was made
- explain the no-op outcome in the structured final output
