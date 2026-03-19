# React Retro LCD Extraction Plan

This plan describes how to extract Schizm's current CRT/LCD prompt display into a reusable package named `react-retro-lcd`.

The intent is to turn the existing prompt surface from:

- [idea-canvas.tsx](/Users/josh/play/schizm/packages/web/src/components/canvas/idea-canvas.tsx)
- [prompt-terminal.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.ts)
- [prompt-zen.constants.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-zen.constants.ts)
- [globals.css](/Users/josh/play/schizm/packages/web/app/globals.css)

into a package that can be dropped into any React app with a stable API, faithful screen behavior, and a strong test suite.

## Goals

`react-retro-lcd` should:

- be easy to integrate into any React application
- expose a standard interface instead of Schizm-specific prompt logic
- support two main display modes:
  - value mode
  - terminal / TTY / ANSI mode
- determine its own row/column capacity in both modes
- emulate LCD behavior as faithfully as practical:
  - wrapping
  - cursor behavior
  - scroll behavior
  - prompt/response flow
- support solid and hollow rectangle cursor styles
- support a configurable screen color that affects the full rendered surface
- provide prompt/reply mode with command acceptance and rejection behavior
- include a robust test suite, including control-character and ANSI behavior tests

## Extraction Target

There is already a linked repo at [references/react-retro-display](/Users/josh/play/schizm/references/react-retro-display).

Recommended path:

1. use that repo as the extraction target
2. rename the package itself to `react-retro-lcd`
3. if desired later, rename the repo directory to match

For planning purposes, this document assumes:

- repository home: `/Users/josh/play/react-retro-display`
- package name: `react-retro-lcd`

## Current Logic To Extract

The current implementation is split across several responsibilities:

### 1. Visual Screen Shell

Current location:
- [globals.css](/Users/josh/play/schizm/packages/web/app/globals.css)

This contains:

- screen bezel
- phosphor color styling
- scanline overlays
- cursor visuals
- terminal line styling
- CRT glow and glitch behavior

### 2. Terminal Content Protocol

Current location:
- [prompt-terminal.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.ts)

This contains:

- typed terminal entry model
- status-line generation
- working-line behavior
- transition sequencing

This is currently Schizm-specific and needs to become app-neutral.

### 3. Typing / Timing Configuration

Current location:
- [prompt-zen.constants.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-zen.constants.ts)

This contains:

- placeholder typing timings
- terminal typing timings
- completion delays

### 4. Prompt Screen Integration

Current location:
- [idea-canvas.tsx](/Users/josh/play/schizm/packages/web/src/components/canvas/idea-canvas.tsx)

This contains:

- value-mode input behavior
- terminal-mode rendering
- cursor measurement
- prompt submission transitions
- prompt lifecycle wiring

## Recommended Package Shape

Build `react-retro-lcd` around a domain-neutral core and a React wrapper.

Recommended internal structure:

```text
src/
  core/
    geometry/
      measure-grid.ts
      wrap.ts
    terminal/
      screen-buffer.ts
      ansi-parser.ts
      control-chars.ts
      prompt-session.ts
      types.ts
    theme/
      palette.ts
  react/
    RetroLcd.tsx
    useRetroLcdGeometry.ts
    useRetroLcdController.ts
  styles/
    retro-lcd.css
  index.ts
```

## Public API

The package should expose a single primary component plus an imperative controller API.

## Component API

Recommended top-level component:

```ts
type RetroLcdProps =
  | ValueModeProps
  | TerminalModeProps
  | PromptModeProps;
```

### Shared Props

```ts
type RetroLcdSharedProps = {
  color?: string;
  cursorMode?: "solid" | "hollow";
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  onGeometryChange?: (geometry: {
    rows: number;
    cols: number;
    cellWidth: number;
    cellHeight: number;
    innerWidth: number;
    innerHeight: number;
  }) => void;
};
```

### Value Mode

Use when the screen should display the content of a value prop.

```ts
type ValueModeProps = RetroLcdSharedProps & {
  mode: "value";
  value: string;
  editable?: boolean;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
};
```

### Terminal / TTY Mode

Use when the screen behaves like a stream-oriented terminal.

```ts
type TerminalModeProps = RetroLcdSharedProps & {
  mode: "terminal";
  value?: string;
  controller?: RetroLcdController;
  initialBuffer?: string;
};
```

### Prompt / Reply Mode

Use when the screen should behave like a command prompt.

```ts
type PromptModeProps = RetroLcdSharedProps & {
  mode: "prompt";
  promptChar?: string;
  acceptanceText?: string;
  rejectionText?: string;
  onCommand?: (command: string) =>
    | { accepted: true; response?: string | string[] }
    | { accepted: false; response?: string | string[] }
    | Promise<
        | { accepted: true; response?: string | string[] }
        | { accepted: false; response?: string | string[] }
      >;
};
```

## Standard Controller Interface

To make the terminal mode easy to integrate into any application, expose a controller object with a stable protocol:

```ts
type RetroLcdController = {
  write: (data: string) => void;
  writeln: (line: string) => void;
  clear: () => void;
  reset: () => void;
  moveCursorTo: (row: number, col: number) => void;
  setCursorVisible: (visible: boolean) => void;
  setCursorMode: (mode: "solid" | "hollow") => void;
  getSnapshot: () => RetroLcdSnapshot;
};
```

This should be the standard protocol for programmatic replies from the host application.

## Screen Model

The package should not be implemented as a freeform text area with cosmetic overlays only.

Instead, it should have a real screen model:

- derived row count
- derived column count
- a logical text buffer
- cursor position
- wrap logic
- scroll region behavior
- render output generated from the buffer

That model should be the source of truth for terminal and prompt mode.

## Geometry / Row-Col Calculation

Both value mode and terminal mode should determine rows and columns from:

- measured content box width
- measured content box height
- font metrics
- line height
- letter spacing
- padding

Recommended behavior:

- use `ResizeObserver`
- measure a monospace cell using a hidden probe
- derive `cols = floor(innerWidth / cellWidth)`
- derive `rows = floor(innerHeight / cellHeight)`
- emit geometry through `onGeometryChange`

This geometry should be used for wrapping and scrolling behavior.

## Wrapping and Scrolling Rules

The package should emulate terminal-style wrapping rules, not normal browser paragraph layout.

Recommended rules:

- treat text as a screen buffer
- wrap at the current column width
- support explicit `\n`
- support `\r`
- support backspace
- scroll upward when new content exceeds visible rows
- preserve a configurable scrollback buffer internally

For value mode:

- wrapping should still be computed by the screen model
- cursor placement should reflect actual row/column position

## ANSI / Control Character Plan

The request says the component should implement the same ANSI protocol as a regular monitor.

That is a large surface area, so the safest plan is to implement it in staged compatibility levels.

### Phase A: Essential Control Characters

Support first:

- `\\n` line feed
- `\\r` carriage return
- `\\b` backspace
- `\\t` tab
- `\\f` form feed if needed
- bell `\\a` as a no-op or event callback

### Phase B: Core CSI Sequences

Support next:

- cursor up / down / forward / back
- cursor position
- erase line
- erase display
- save cursor
- restore cursor

### Phase C: SGR Rendering

Because this is a monochrome LCD package, not all ANSI styles should map literally.

Recommended approach:

- support reset
- bold / faint as brightness variants
- inverse
- conceal if useful
- blink only if it can be implemented cleanly
- color escapes should be normalized into monochrome brightness / ignored with deterministic behavior

### Phase D: Optional Advanced Features

Only after the basics are stable:

- scroll regions
- alternate screen buffer
- DEC private modes

## Prompt / Reply Mode

Prompt mode should be built on top of terminal mode, not as a separate fake surface.

Recommended behavior:

- render prompt character `>` at the start of the active input line
- allow user text after the prompt
- on submit, pass the command to `onCommand`
- if accepted:
  - print acceptance response, default `OK`
- if rejected:
  - print rejection response, default `ERROR`
- allow the callback to return additional response lines
- move to a fresh prompt line after response completes

Example acceptance flow:

```text
> help
OK
available commands: status, clear
> 
```

## Color and Theme Model

The package should expose a color prop that changes the full screen hue coherently.

Recommended palette model:

- `color` is the base phosphor color
- derive:
  - ink
  - dim ink
  - border glow
  - shadow glow
  - scanline tint
  - cursor color

Recommended named presets in addition to arbitrary CSS colors:

- green
- amber
- blue
- white-phosphor

## Separation Of Concerns

To keep the package reusable, do not carry Schizm-specific concepts into it.

Things that should remain outside the package:

- prompt lifecycle status mapping
- git/codex wording
- hypothesis/audit logic
- application-specific terminal entry IDs

Things that should move into the package:

- screen geometry
- cursor rendering
- wrapping
- buffer model
- ANSI parser
- prompt mode
- neutral write / clear / reset / submit protocol

## Testing Strategy

The package should ship with a strong test suite from the start.

### Unit Tests

Test:

- row/column calculation
- wrap behavior at exact boundary widths
- explicit newline handling
- carriage return behavior
- backspace behavior
- cursor movement
- buffer scroll-up behavior
- prompt submit flow
- accepted command flow
- rejected command flow
- solid cursor rendering state
- hollow cursor rendering state
- color derivation

### ANSI Parser Tests

For every supported control character or escape sequence, add direct parser tests.

Test format:

- input bytes / string
- initial screen state
- expected final screen state
- expected cursor position

### React Component Tests

Test:

- rendering in value mode
- rendering in terminal mode
- prompt mode input behavior
- geometry updates when resized
- callback invocation behavior
- keyboard handling

### Visual / Browser Tests

Use Playwright for:

- wrapping within bounds
- cursor shape
- screen overflow / scroll behavior
- prompt/reply rendering
- color theme application

### Golden Snapshot Tests

Recommended for terminal compatibility:

- given a stream of writes and control characters
- assert final visible screen lines exactly

This is the most important test style for ANSI behavior.

## Migration Plan

### Phase 1: Package Skeleton

Create the external package repo structure and toolchain.

Deliverables:

- React package scaffold
- TypeScript build
- CSS bundle strategy
- test runner setup

### Phase 2: Core Screen Engine

Implement a framework-independent terminal engine.

Deliverables:

- screen buffer
- wrap logic
- cursor model
- row/column derivation helpers

### Phase 3: React Wrapper

Build the `RetroLcd` component and controller API.

Deliverables:

- value mode
- terminal mode
- cursor modes
- color prop

### Phase 4: Prompt Mode

Build prompt/reply interaction on top of the terminal engine.

Deliverables:

- prompt char support
- submit behavior
- accept / reject callbacks
- response protocol

### Phase 5: ANSI Support

Implement control characters and CSI support in stages.

Deliverables:

- essential control chars
- cursor control
- erase commands
- basic SGR mapping

### Phase 6: Schizm Migration

Replace the current inline LCD implementation in Schizm with `react-retro-lcd`.

Deliverables:

- Schizm uses package component instead of local CRT markup/styling
- `prompt-terminal.ts` reduced to app-specific text generation only
- most screen rendering CSS removed from Schizm and moved into the package

## Recommended Schizm Refactor Boundary

After extraction, Schizm should keep:

- terminal content generation:
  - `queued for isolated git + codex run`
  - `running codex cli`
  - `syncing audit.md back into the prompt row`
- prompt runner wiring
- app-specific acceptance / failure text

Schizm should no longer own:

- custom cursor measurement/rendering
- terminal buffer rendering
- CRT shell styling
- prompt mode editing behavior

## Proposed First Public API Slice

The smallest worthwhile first release is:

1. `mode="value"`
2. `mode="terminal"` with `write`, `writeln`, `clear`, `reset`
3. row/column self-measurement
4. solid/hollow cursor support
5. color prop
6. exact wrap + scroll tests

Then add:

7. prompt mode
8. ANSI support

## Risks

### 1. ANSI Scope Explosion

Full ANSI parity is large.

Mitigation:

- publish explicit compatibility levels
- test each supported escape sequence precisely
- document unsupported sequences clearly

### 2. Browser Layout Drift

Font measurement and wrapping can drift across environments.

Mitigation:

- lock to monospace fonts
- centralize measurement logic
- use browser tests for real layout verification

### 3. Overfitting To Schizm

If extraction keeps too much Schizm vocabulary, the package will not feel reusable.

Mitigation:

- keep content generation external
- keep package focused on display mechanics and interaction protocol

## Suggested Deliverables In Order

1. create the package scaffold in the external repo
2. move the visual shell CSS into the package
3. implement the neutral screen buffer core
4. implement value mode
5. implement terminal mode controller
6. add wrap / cursor / scroll golden tests
7. add prompt mode
8. add ANSI control character support
9. migrate Schizm to the package
10. delete duplicated local LCD rendering logic from Schizm

## Short Recommendation

Build `react-retro-lcd` as a real terminal display engine with a React wrapper, not just a styled text box.

That gives you:

- reusable integration
- correct wrapping and cursor behavior
- testable ANSI support
- a clean migration path for Schizm
- a package that can be reused outside this app without carrying Schizm-specific assumptions
