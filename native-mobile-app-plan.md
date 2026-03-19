# Native Mobile App Plan

## Goal

Create iOS and Android native apps that integrate with the existing Schizm API platform.

The first release should stay intentionally narrow:

- match the prompt-entry experience of the current web app as closely as practical
- let a user submit a prompt to the existing GraphQL API
- show the live lifecycle of that prompt from the existing runner/status model

The primary parity target is the centered retro LCD prompt box from the web app, not the full desktop prompt-history workspace.

## Product Objective

The v1 mobile milestone is not “port the website.”

It is:

- a strong native prompt composer
- the same retro green input identity
- clear immediate feedback after submission
- enough recent history and status visibility to make the app feel trustworthy

If we hit that well, we can expand the mobile surface later without overcommitting to the full desktop information density.

## Recommendation

Use a shared React Native codebase with Expo for v1.

Why:

- fastest path to shipping both iOS and Android together
- easiest reuse of existing TypeScript, GraphQL, and prompt-state concepts
- lower product risk than building separate Swift and Kotlin apps immediately
- still delivers real native apps, native keyboard handling, native packaging, and native distribution

If stricter platform-specific UI work is needed later, the API layer, prompt state model, and LCD behavior model from this plan still transfer cleanly.

## Current State In Schizm

### Existing Strengths

The current project already has most of the backend pieces mobile needs:

- GraphQL API for prompt creation and retrieval
- GraphQL subscription for live workspace updates
- prompt lifecycle/status model already defined on the server
- existing retro LCD prompt composer behavior on the web
- existing prompt history and detail model on the web

### Relevant Current Files

The most useful implementation references are:

- [idea-canvas.tsx](/Users/josh/play/schizm/packages/web/src/components/canvas/idea-canvas.tsx)
- [prompt-terminal.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-terminal.ts)
- [prompt-zen.constants.ts](/Users/josh/play/schizm/packages/web/src/components/canvas/prompt-zen.constants.ts)
- [graphql.ts](/Users/josh/play/schizm/packages/web/src/lib/graphql.ts)
- [apollo.tsx](/Users/josh/play/schizm/packages/web/src/lib/apollo.tsx)
- [schema.ts](/Users/josh/play/schizm/packages/server/src/graphql/schema.ts)

### Constraint To Call Out Early

The API appears to be effectively unauthenticated right now.

That is acceptable for an internal prototype or local development app, but it should be treated as a release blocker for any public mobile distribution.

## Scope For v1

### In Scope

- app shell and navigation
- a mobile-native retro prompt composer
- prompt submission
- live prompt status updates
- compact recent prompt list
- current prompt detail/status summary
- connection and error handling

### Out Of Scope For v1

- full connection-field / canvas editing
- full desktop prompt-history parity
- theme system parity
- offline-first queueing
- push notifications
- account/profile features unless auth becomes mandatory
- store-account operational setup details

## Core Product Decision

Do not try to force a literal DOM/CSS port of the web prompt screen into mobile.

The goal is behavioral and visual parity, not implementation parity.

That means:

- preserve the retro LCD mood
- preserve the centered “single purpose input surface” feel
- preserve cursor/placeholder/status semantics
- adapt the rendering to native mobile primitives

## Technical Recommendation

### App Stack

Use:

- Expo React Native
- TypeScript
- Apollo Client
- GraphQL over HTTPS
- `graphql-ws` over WSS
- secure local storage for environment selection and future auth state

### Renderer Strategy

Do not directly reuse the current web LCD renderer.

The published LCD package is web-leaning and built around DOM/CSS assumptions. For mobile, split the work into:

1. shared behavior core
2. React Native renderer

For the first implementation, use:

- regular React Native `View`, `Text`, and `TextInput`
- a layered visual shell to recreate the LCD panel look

Only consider `@shopify/react-native-skia` later if the first native prototype fails to carry the right visual identity.

### Why Start With Standard RN Components

- lower implementation cost
- easier text input and keyboard behavior
- easier accessibility and platform compatibility
- simpler E2E automation
- easier to keep prompt submission stable while the look is refined

## Architecture Direction

### Proposed Monorepo Shape

Add:

- `apps/mobile`
  - Expo React Native app
- `packages/api-client`
  - shared GraphQL documents
  - shared prompt types
  - shared prompt mapping helpers
  - shared transport/runtime config helpers
- `packages/mobile-retro-lcd-core`
  - shared placeholder rotation logic
  - cursor mode logic
  - prompt compose state behavior
  - terminal/status line formatting helpers that are platform-neutral
- `packages/mobile-design-tokens`
  - shared colors
  - spacing
  - type scale
  - LCD constants

### Important Boundary

The mobile app should share:

- API contracts
- prompt state model
- status interpretation
- prompt formatting rules where practical

The mobile app should not share:

- web DOM rendering
- web CSS
- desktop-specific layout assumptions

## Mobile API Integration Plan

### Existing GraphQL Capabilities To Reuse

- `runtimeConfig`
- `prompts(limit)`
- `createPrompt(input)`
- `retryPrompt(id)`
- `cancelPrompt(id)`
- `promptWorkspace(limit)` subscription

### Mobile-Specific Client Requirements

- configurable API base URL for dev/staging/prod
- no same-origin assumptions anywhere in the client
- resilient WebSocket reconnect behavior
- explicit connection state for the UI
- mobile-safe handling of HTTPS/WSS certificate and network failures

## Prompt Composer Parity Requirements

The mobile prompt composer should preserve these web characteristics:

- centered focus
- strong retro green identity
- mono type treatment
- clear cursor behavior
- dim placeholder treatment distinct from active text
- screen-like bezel, glow, and panel framing
- feeling of a dedicated capture surface instead of a generic form field

The mobile version should adapt these for phones:

- visible send action instead of relying on desktop keyboard conventions
- keyboard-safe composition layout
- larger touch targets
- less dense supporting chrome
- smaller but still readable status summaries

## Suggested Screen Model For v1

### 1. Prompt Screen

Primary screen.

Contains:

- centered retro prompt composer
- minimal status row
- recent prompt shortcut or small recent list

### 2. Prompt Detail Screen

Shown after submission or from history.

Contains:

- current prompt content
- current status
- latest stage
- failure details if relevant
- retry/cancel where valid

### 3. Prompt History Screen

Compact, stacked list.

Contains:

- recent prompts
- status chips
- timestamps
- drill-in to prompt detail

Do not try to replicate the desktop two-pane history layout directly.

## Implementation Phases

## Phase 0: Preconditions

Deliver:

- choose Expo React Native officially
- define dev/staging/prod API endpoints
- decide whether the app is internal-only, TestFlight-first, or public
- decide whether auth must exist before the first external beta

Questions to resolve:

- is mobile v1 internal only?
- must prompt history ship in the first beta, or is compose + current prompt enough?
- do we need authenticated users before external testers touch this?

## Phase 1: Scaffold The Mobile App

Deliver:

- `apps/mobile` Expo project in the monorepo
- TypeScript, linting, and basic test setup
- env configuration for API base URL
- Apollo Client setup for HTTP + WebSocket
- navigation shell

Suggested initial screens:

- `PromptScreen`
- `PromptHistoryScreen`
- `SettingsScreen`

Exit criteria:

- app boots on iOS simulator
- app boots on Android emulator
- app can connect to local/dev API configuration

## Phase 2: Extract Shared API Client Layer

Deliver:

- shared GraphQL documents extracted from the web app
- shared prompt types and mapping helpers
- shared workspace subscription handling helpers
- mobile-safe runtime config handling

Benefits:

- web and mobile stop drifting on prompt shape
- easier future codegen
- easier transport hardening

Exit criteria:

- both web and mobile can consume the same prompt document definitions
- prompt records map to one shared TS contract

## Phase 3: Implement The Mobile Retro Prompt Composer

Deliver:

- mobile LCD prompt component
- placeholder text support
- blinking cursor behavior
- active text vs dim placeholder distinction
- layout tuned for phone portrait mode
- send action and submit behavior

Parity target:

- same overall retro mood as web
- same content tone and placeholder copy
- similar cursor semantics
- similar screen-depth treatment

Important simplification:

Do not block v1 on full terminal emulation.

If needed, phase 3 can stop at a strong editable retro input surface with clean submission behavior.

Exit criteria:

- composer visually feels like Schizm
- input is comfortable on phone keyboards
- submission is reliable on both platforms

## Phase 4: Prompt Submission And Live Status

Deliver:

- create prompt mutation from mobile
- live prompt updates via subscription
- current prompt status transitions
- working, failed, completed states
- basic prompt detail summary

This should reuse the existing prompt lifecycle model instead of inventing a mobile-only one.

Exit criteria:

- submit a prompt from mobile
- watch it move through statuses in real time
- see failure/completion without refreshing manually

## Phase 5: Mobile Prompt History

Deliver:

- compact recent prompt list
- selected prompt detail screen or bottom sheet
- retry / cancel actions where appropriate
- compact worker/job/status information only if it remains readable on mobile

Use:

- stacked cards
- drill-in detail screen
- or a summary + detail sheet pattern

Exit criteria:

- recent prompts are understandable on a phone
- failure recovery actions are accessible

## Phase 6: Hardening And Beta

Deliver:

- reconnection UX
- loading/empty/error states
- safe-area handling
- keyboard avoidance
- crash/error telemetry
- internal beta packaging

Exit criteria:

- stable internal TestFlight / Android internal build
- acceptable behavior on poor mobile networks

## Testing Strategy

### Unit Tests

- prompt composer state machine
- placeholder cycling logic
- cursor mode transitions
- prompt status mapping
- GraphQL response mapping

### Integration Tests

- create prompt against mocked GraphQL API
- subscription-driven status updates
- reconnect behavior
- API URL configuration handling

### Device / E2E Tests

- iOS simulator prompt submission flow
- Android emulator prompt submission flow
- keyboard behavior
- safe-area behavior
- prompt-detail transition after submission

## Risks

### 1. No Auth Story Yet

This is the biggest non-UI blocker for any public mobile release.

### 2. Trying To Port Too Much Desktop UI

The fastest way to miss the goal is trying to replicate the full desktop history experience before the prompt surface feels right.

### 3. Over-Investing In Visual Fidelity Too Early

A Skia-heavy renderer too early could slow the project down.

Start with native primitives and prove the interaction first.

### 4. Mobile Realtime Reliability

Subscriptions and reconnect behavior matter more on mobile than desktop, especially when the app backgrounds and resumes.

## Recommended First Implementation Slice

The best first slice is:

1. scaffold `apps/mobile` with Expo
2. extract/share the GraphQL prompt client layer
3. build only the retro prompt composer screen
4. submit a prompt and show live status

That gives fast proof that:

- the API contract works on mobile
- the core visual identity carries over
- the main user interaction feels right

before investing in broader mobile history or richer native UI.
