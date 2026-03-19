# React Retro LCD Ownership Matrix

This document defines what belongs to Schizm and what belongs to `react-retro-lcd`.

Its job is to stop test ownership from drifting. If a behavior is generic LCD/terminal mechanics, it should live in the package. If a behavior depends on Schizm's queue, prompt lifecycle, Obsidian workflow, or repo language, it should stay in Schizm.

Relevant current files:

- Schizm app integration:
  - [idea-canvas.tsx](/Users/josh/play/schizm/packages/web/src/components/canvas/idea-canvas.tsx)
  - [prompt-terminal.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.ts)
  - [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts)
  - [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts)
- Extracted package:
  - [RetroLcd.tsx](/Users/josh/play/schizm/references/react-retro-display/src/react/RetroLcd.tsx)
  - [screen-buffer.ts](/Users/josh/play/schizm/references/react-retro-display/src/core/terminal/screen-buffer.ts)
  - [prompt-session.ts](/Users/josh/play/schizm/references/react-retro-display/src/core/terminal/prompt-session.ts)
  - [RetroLcd.test.tsx](/Users/josh/play/schizm/references/react-retro-display/src/react/RetroLcd.test.tsx)

## Rule Of Thumb

Move to `react-retro-lcd` when the behavior can be described without mentioning:

- prompts
- Codex
- GraphQL
- prompt history
- Obsidian
- audit
- git branches
- runner state

Keep in Schizm when the behavior depends on app-specific meaning, sequencing, or copy.

## Ownership Matrix

| Concern | Owner | Why |
| --- | --- | --- |
| Measuring rows and columns from the rendered screen | `react-retro-lcd` | Pure display geometry |
| Wrapping text at LCD column boundaries | `react-retro-lcd` | Terminal/display behavior |
| Scrolling older rows off-screen when the buffer fills | `react-retro-lcd` | Screen model behavior |
| ANSI/control character parsing | `react-retro-lcd` | Generic terminal compatibility |
| Rendering solid vs hollow cursor | `react-retro-lcd` | Generic cursor behavior |
| Applying screen hue consistently to bezel, text, cursor, and dim text | `react-retro-lcd` | Package-level theming |
| Prompt-session protocol (`>`, `OK`, `ERROR`) in generic prompt mode | `react-retro-lcd` | Public prompt API contract |
| Focus handling for editable screen input | `react-retro-lcd` | Generic interaction behavior |
| Enter submits and Shift+Enter inserts newline in editable value mode | `react-retro-lcd` | Generic editing contract |
| Placeholder rendering as dimmed LCD text | `react-retro-lcd` | Generic display behavior |
| Screen text staying within LCD bounds | `react-retro-lcd` | Core layout guarantee |
| Placeholder question rotation and timing | Schizm | App-authored idle experience |
| Prompt submission mutation | Schizm | GraphQL/application logic |
| WebSocket/subscription updates | Schizm | Application transport |
| Mapping prompt statuses to terminal lines | Schizm | App-specific copy and semantics |
| Working-dot cadence tied to runner state | Schizm | App-specific status protocol |
| Transition from prompt screen to prompt history | Schizm | App navigation/state flow |
| Failure and git summary wording | Schizm | Domain-specific reporting |
| Filtering/selecting prompt history | Schizm | App UI logic |

## Current Test Inventory

### Keep In Schizm

These are app-specific and should remain owned by Schizm:

| Test / Behavior | Current Location | Reason |
| --- | --- | --- |
| `buildPromptTerminalEntries` deduplicates statuses and appends failure detail | [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts) | Codex/git/audit wording is app-specific |
| Git branch/SHA summary formatting | [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts) | Schizm-specific metadata contract |
| Working entry generation from prompt status | [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts) | Bound to Schizm prompt statuses |
| Character-by-character terminal entry sequencing | [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts) | App presentation logic |
| Placeholder question loop with the current question set | [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts) | Schizm owns the question content and idle behavior |
| Submission -> terminal -> history transition | [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts) | App workflow, not generic LCD behavior |
| Lifecycle copy like `# running codex cli` | [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts) | App-owned domain text |

### Move To `react-retro-lcd`

These should be package-owned because they test generic LCD mechanics:

| Behavior | Better Package Home |
| --- | --- |
| Long text wraps cleanly inside the screen without overflow | browser-level LCD tests in `react-retro-lcd` |
| Terminal scrollback causes older rows to leave the visible viewport | browser-level LCD tests in `react-retro-lcd` |
| Solid cursor renders in editable input state | [RetroLcd.test.tsx](/Users/josh/play/schizm/references/react-retro-display/src/react/RetroLcd.test.tsx) plus browser test |
| Hollow cursor renders in terminal state | [RetroLcd.test.tsx](/Users/josh/play/schizm/references/react-retro-display/src/react/RetroLcd.test.tsx) plus browser test |
| ANSI faint styling dims text consistently | package renderer tests |
| User-colored text remains bright while faint system text remains dim | package renderer tests |
| Placeholder text renders dimmed, not fully bright | package renderer tests |

### Adapt And Split

These are currently tested in Schizm, but their assertions can be split into a generic package part and an app-specific part:

| Current Schizm Assertion | Keep In Schizm | Adapt For LCD |
| --- | --- | --- |
| Terminal response starts after submit | yes | generic prompt/terminal mode can test that submitted text remains in buffer |
| User text keeps its bright color after submit | no | package can test that bright cells stay bright after faint ANSI lines are appended |
| System response uses the same dim color as placeholder | no | package can test placeholder dim color equals ANSI faint color |
| Text never exceeds the LCD viewport | no | package browser test |
| Long content wraps instead of spilling horizontally | no | package browser test |
| Cursor changes from solid during user editing to hollow during system typing | partly | package can test cursor mode changes when host/controller changes mode; Schizm can keep only its flow-specific sequence test |

## Tests To Add In `react-retro-lcd`

These are the highest-value tests to add next because they are generic and directly replace Schizm-owned LCD assertions.

### 1. Browser Test: Viewport Safety

Purpose:

- prove rendered glyphs never exceed the visible LCD face
- prove long unbroken content wraps inside the screen

Suggested test:

1. mount `RetroLcd` in `terminal` mode at a constrained width
2. write a very long unbroken token
3. collect `Range.getClientRects()` for visible lines
4. assert all visible rects stay within the LCD viewport bounds
5. assert there is more than one rendered row

This is the most direct package replacement for Schizm's current overflow/wrap e2e.

### 2. Browser Test: Dim Placeholder Color Matches Faint ANSI Text

Purpose:

- guarantee color consistency between idle placeholder mode and faint system text

Suggested test:

1. render `mode="value"` with empty value and placeholder
2. sample the visible placeholder line color
3. rerender or mount `mode="terminal"` with ANSI faint text
4. sample a faint cell color
5. assert they match

This replaces the useful generic part of Schizm's current placeholder-vs-system-color assertion.

### 3. Browser Test: Cursor Shape Contract

Purpose:

- verify visual cursor contract in a browser, not just via attributes

Suggested test:

1. render editable `value` mode with `cursorMode="solid"`
2. assert cursor has filled background and no hollow border style
3. render `terminal` mode with `cursorMode="hollow"`
4. assert cursor background is transparent and border is visible

### 4. React Test: Submitted Text Remains In Buffer

Purpose:

- verify the package does not discard the input line when a prompt session responds

Suggested test:

1. render `mode="prompt"`
2. type a command and submit
3. assert the submitted prompt line is still present
4. assert response lines appear after it
5. assert the next prompt line appears only after the response block

### 5. React Test: Buffer Scroll Window

Purpose:

- verify that once enough lines are written, the visible snapshot window drops older lines

Suggested test:

1. create controller with small `rows`
2. write enough `writeln` calls to exceed the screen height
3. assert earlier lines are in scrollback and not in visible lines
4. assert latest lines remain visible

### 6. React Test: ANSI Faint Does Not Affect Neighboring Bright Text

Purpose:

- verify style boundaries in the buffer renderer

Suggested test:

1. write bright text
2. write ANSI faint text
3. write reset and another bright token
4. assert faint classes only apply to the intended cells
5. assert bright cells remain un-dimmed

## Tests That Should Stay In Schizm But Be Narrowed

Schizm should keep only the app-level assertions after package extraction.

Recommended Schizm e2e scope:

- prompt placeholder sequence uses Schizm's question list
- Enter queues a prompt through the mutation layer
- lifecycle updates are translated into the expected app-specific lines
- working dots appear while statuses are in the Schizm working set
- prompt screen transitions to history after overflow and terminal completion

Recommended Schizm tests should stop asserting:

- raw LCD border/cursor styling details
- generic wrap/bounds behavior
- generic ANSI dim rendering behavior

Those belong in the package now.

## Concrete Migration Candidates

### Candidate A: Split `keeps terminal text inside the lcd bounds and wraps long prompt content`

Current home:

- [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts)

Recommended split:

- keep in Schizm:
  - submit prompt
  - terminal surface appears
- move to package:
  - visible text rects remain within viewport
  - long content wraps across multiple rows

### Candidate B: Split `keeps terminal text stable while the live teletype response starts`

Current home:

- [prompt-terminal.spec.ts](/Users/josh/play/schizm/e2e/prompt-terminal.spec.ts)

Recommended split:

- keep in Schizm:
  - terminal receives the right lifecycle lines
  - history transition occurs
- move/adapt to package:
  - user text remains bright
  - system/faint text remains dim
  - terminal body itself does not run app-level glitch animations
  - hollow cursor appears in terminal mode

### Candidate C: Split `buildPromptTerminalBuffer keeps user text plain and dims system lines with ansi`

Current home:

- [prompt-terminal.test.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.test.ts)

Recommended split:

- keep in Schizm:
  - it emits faint ANSI wrappers around system lines
- move to package:
  - ANSI faint wrappers actually render as dim cells

## Recommended Next Sequence

1. Add package-owned browser tests for:
   - wrap-within-bounds
   - placeholder-dim-equals-faint-text
   - solid/hollow cursor rendering
2. Trim Schizm e2e so it focuses on app flow, not package rendering internals.
3. Keep `prompt-terminal.test.ts` in Schizm for text-generation semantics only.
4. Use this matrix as the review check whenever a new LCD-related assertion is added.

## Short Version

If a test would still make sense in a blank demo app using `react-retro-lcd`, it probably belongs in the package.

If a test mentions prompt queue state, Codex, git, audit, history view, or Obsidian semantics, it belongs in Schizm.
