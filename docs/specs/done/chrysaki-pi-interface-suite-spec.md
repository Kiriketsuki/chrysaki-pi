# Feature: Chrysaki Pi Interface Suite

## Overview

**User Story**: As a Pi user working in full terminals and tmux panes, I want a beautiful, responsive Chrysaki interface with discoverable commands and practical modal editing so that Pi feels coherent with my desktop while remaining fast and useful at every terminal width.

**Problem**: The current Pi setup uses the default dark theme, stock interactions, and a separately adapted Chrysaki footer. It lacks a coherent visual system, responsive context presentation, a Git-focused rail, a searchable command layer, and guided modal editing; previous synchronous footer work also showed that visual customization can degrade the TUI if rendering boundaries are not strict.

**Out of Scope**: Forking Pi for a native split-pane sidebar; implementing complete Vim compatibility; replacing Lazygit as an interactive Git client; silently modifying user dotfiles; requiring Codex CLI authentication for core UI operation; publishing to npm in the first release; changing the Chrysaki core palette.

---

## Success Condition

> This feature is complete when `pi install git:github.com/Kiriketsuki/chrysaki-pi@vX.Y.Z` provides the approved Chrysaki theme, responsive cached telemetry, width/context-aware overlay rail with mini Git visuals, fuzzy command deck, and guided Practical Vim editor without blocking renders or degrading normal tmux use.

---

## Open Questions

| # | Question | Raised By | Resolved |
|:--|:---------|:----------|:---------|
| 1 | What default terminal width should auto-open the context rail? | Responsive design | [x] 120 columns |
| 2 | Which model/tool/thinking presets ship in the first release? | Workflow design | [x] Focused, Deep Work, and Minimal; preserve the current model while changing thinking/tools/UI policy |
| 3 | Which reserved key should the optional tmux adapter forward to Pi? | Integration | [x] `Ctrl+Space, p` forwards Pi's `Ctrl+Shift+P` deck shortcut |
| 4 | Should the package expose experimental animation controls in v1 or keep all motion minimal? | Visual design | [x] Minimal/off only; no experimental controls in v1 |

---

## Scope

### Must-Have
- Installable package: a public `Kiriketsuki/chrysaki-pi` Git repository with a valid Pi package manifest and pinned `chrysaki-core` dependency.
- Complete theme: map every required Pi theme token to the approved high-contrast Chrysaki Precision language and validate theme loading.
- Consistent geometry: enforce a shared spacing grid, stable columns, sharp/double-bordered Chrysaki components, and deterministic truncation at narrow widths.
- Responsive telemetry: show a compact one-line footer in narrow tmux panes and richer Chrysaki information at wider widths.
- Non-blocking rendering: all `render()` implementations return cached lines/components immediately and perform no filesystem, Git, JSON parsing, or process spawning.
- State architecture: lifecycle events and asynchronous collectors update immutable snapshots, coalesce refreshes, and invalidate only affected views.
- Width-aware context rail: automatically show a right-anchored overlay only above a configurable threshold; allow manual pin, hide, and override.
- Context-aware promotion: prioritize relevant rail modules for plans, changed files, Git activity/risk, tool activity, and high context usage without random reordering.
- Tmux-safe fallback: collapse the rail completely in narrow panes and show only a compact footer indicator when promoted content exists.
- Mini Lazygit visuals: provide a read-only Git module using Chrysaki double borders, zero radius, branch semantics, Unicode `● ┆ ╌` graph lines, file status, and numstat.
- Command deck: provide a sharp Chrysaki fuzzy palette with stable categories, descriptions, active key hints, keyboard navigation, and execution.
- Single command registry: palette entries, commands, shortcuts, help text, and availability conditions derive from one source.
- Practical Vim editor: support Insert, Normal, and Visual modes; sessions start in Insert mode; include practical motions, counts, operators, search, undo, paste, and common text objects.
- Guided learning: show concise contextual hints and make every modal action discoverable through the command deck/help view.
- Working indicator and header treatment: use the approved Chrysaki identity without excessive motion or persistent decorative noise.
- Lifecycle safety: reload, session switch, fork, and shutdown dispose overlays, timers, subscriptions, and child process groups idempotently.
- Optional tmux adapter: document an explicit user-applied binding that forwards a reserved key to Pi while preserving the existing `Ctrl+Space, Space` tmux palette.
- Graceful degradation: missing Git, GitHub, rate-limit, or optional integration data never disables the editor, footer, command deck, or core theme.

### Should-Have
- Preset registry for named model, thinking, tools, and UI-density combinations.
- Interactive package settings for rail threshold, auto-promotion, motion, Git module visibility, and editor mode defaults.
- Responsive Git module states: compact summary, file list, and commit graph selected according to available height.
- Command deck categories for View, Git, Model, Session, Preset, Editor, and Help.
- Theme-aware custom tool and message rendering for common Pi operations.
- HTML export colors aligned with the Chrysaki surface hierarchy.
- Performance instrumentation available behind a debug command without appearing in normal renders.

### Nice-to-Have
- Experimental native-sidebar adapter when Pi exposes a stable reserved-layout API.
- Package gallery image/video metadata.
- Additional Vim text objects, registers, macros, and advanced commands after the practical subset stabilizes.
- Animated jewel transitions where Pi lifecycle and render timing make them deterministic and inexpensive.
- Optional direct handoff to full Lazygit from the Git rail.

---

## Technical Plan

**Affected Components**:
- `package.json` with Pi manifest, peer dependencies, pinned core dependency, and package metadata.
- `themes/chrysaki.json` generated or validated from `chrysaki-core` tokens.
- `extensions/runtime/` for lifecycle coordination, state, scheduling, disposal, and settings.
- `extensions/collectors/` for session, model, context, Git, and optional usage data.
- `extensions/views/` for header, footer, overlay rail, Git module, command deck, help, and working indicator.
- `extensions/editor/` for modal state, motions, operators, visual selection, search, and hints.
- `extensions/commands/` for the command/preset registry and shortcut routing.
- `prompts/` for selected workflow templates where a prompt is preferable to an extension command.
- `adapters/tmux/` for opt-in tmux forwarding configuration and installation documentation.
- Tests covering token mapping, layout width, deterministic rendering, event scheduling, editor behavior, palette filtering, and cleanup.

**Data Model Changes**:
- `UiSnapshot`: model, thinking level, context usage, session identity, Git summary, active processes, promoted module, and timestamps.
- `RailState`: visibility mode (`auto`, `pinned`, `hidden`), width threshold, active module order, and compact-count indicators.
- `GitSnapshot`: repository state, branch, commit hash, ahead/behind, file statuses, numstat, and bounded commit graph entries.
- `EditorState`: mode, pending operator, count, register, selection, search query, and hint state.
- `CommandDefinition`: id, label, category, description, key hint, availability predicate, and handler.
- `PresetDefinition`: model matcher, thinking level, active tools, density, rail policy, and optional working indicator.
- Runtime state remains in memory unless a setting must persist; session-specific data is reconstructed from Pi lifecycle/session APIs.

**API Contracts**:
- Pi package manifest exposes extension, theme, and prompt resource paths.
- `StateStore.subscribe(selector, listener)` publishes immutable, selector-scoped updates.
- Collectors expose `start(context)`, `refresh(reason)`, and idempotent `dispose()` boundaries.
- Views expose Pi TUI `render(width)`, `invalidate()`, and optional `dispose()` without asynchronous render work.
- Sidebar adapter exposes `show`, `hide`, `pin`, `promote`, and `dispose`; v1 implements this with Pi's overlay API.
- Command registry is the canonical source for palette, shortcuts, and help rendering.

**Dependencies**:
- Pi extension and TUI peer packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `typebox` where required.
- Pinned Git release of `@kiriketsuki/chrysaki-core` until npm publication is approved.
- Git executable for optional repository telemetry; GitHub CLI and Codex CLI data remain optional.
- Truecolor terminal recommended; the theme must remain legible through Pi's 256-color fallback.
- Pi overlay API is experimental; all overlay behavior remains isolated behind the sidebar adapter.

**Risks**:
| Risk | Likelihood | Mitigation |
|:-----|:-----------|:-----------|
| Persistent overlay obscures transcript content | Medium | Auto-open only on wide terminals, cap width, allow instant hide/pin override, and collapse in tmux panes |
| Overlay API changes in a future Pi release | Medium | Isolate all calls behind a small sidebar adapter with contract tests |
| Modal editor intercepts abort or application shortcuts | High | Extend `CustomEditor`, delegate unhandled/control keys to `super`, and test every built-in application binding |
| Vim subset behaves inconsistently with user expectations | Medium | Document the supported subset, provide command discovery, and fail safely by delegating unsupported controls |
| Git collection reintroduces TUI freezes or orphan processes | High | Asynchronous bounded collectors, coalescing, timeouts, output caps, process-group cleanup, and cached renders only |
| Command deck and rail compete for keyboard focus | Medium | Explicit overlay focus ownership, stack policy, and restoration tests |
| High-contrast mapping departs from canonical Chrysaki values | Medium | Treat brighter UI roles as named adapter mappings; never mutate core tokens inside the Pi package |
| Optional data providers fail or authenticate separately | High | Preserve last successful snapshots, back off failures, and treat optional telemetry as non-blocking |
| Package install modifies user environment unexpectedly | Low | Never mutate dotfiles automatically; provide explicit opt-in adapter instructions and rollback steps |

---

## Acceptance Scenarios

```gherkin
Feature: Chrysaki Pi Interface Suite
  As a Pi user working in full terminals and tmux panes
  I want a responsive Chrysaki interface and guided modal workflow
  So that Pi is beautiful, efficient, and coherent without sacrificing performance

  Background:
    Given chrysaki-pi is installed from a pinned Git release
    And its pinned chrysaki-core token contract is available

  Rule: Installation provides a complete coherent theme

    Scenario: Load the package in Pi
      When Pi discovers package resources
      Then the Chrysaki theme, extensions, and prompts load without errors
      And all required Pi theme tokens are defined

    Scenario: Render through reduced color capability
      Given the terminal does not provide full truecolor fidelity
      When Pi maps colors to its fallback palette
      Then primary text, selected rows, success, warning, and error states remain distinguishable

  Rule: Rendering remains immediate and non-blocking

    Scenario: Repaint a cached view
      Given Git and optional usage collectors are refreshing asynchronously
      When Pi calls render repeatedly at different widths
      Then render performs no I/O or process spawning
      And each returned line fits the requested width

    Scenario: Recover from a timed-out collector
      Given a Git or optional telemetry subprocess exceeds its deadline
      When the timeout fires
      Then the entire child process group is terminated
      And the last successful snapshot or an unobtrusive unavailable state remains visible

  Rule: The interface adapts to terminal width

    Scenario Outline: Choose responsive density
      Given the terminal width is <width>
      When the layout policy evaluates available space
      Then the footer uses <footerMode>
      And the context rail is <railMode>

      Examples:
        | width | footerMode | railMode |
        | narrow tmux pane | compact one-line | hidden |
        | wide terminal | rich responsive | eligible for auto-open |

    Scenario: Preserve manual rail ownership
      Given the rail is manually hidden or pinned
      When context-aware promotion requests a different module
      Then the manual visibility choice remains authoritative
      And only module priority changes when the rail is visible

  Rule: Git context uses mini Lazygit visuals

    Scenario: Promote Git during repository work
      Given Git tools run or repository changes are detected
      When the terminal is wide enough for the rail
      Then the Git module is promoted
      And it shows branch semantics, bounded files, numstat, and Unicode commit graph lines

    Scenario: Hide Git details in a narrow pane
      Given promoted Git information exists
      When the terminal becomes narrower than the rail threshold
      Then the overlay closes
      And the footer shows only compact branch and change counts

    Scenario: Operate outside a Git repository
      Given the current directory is not inside a Git repository
      When Git collection runs
      Then no Git error disrupts the UI
      And Git commands in the command deck are unavailable or clearly disabled

  Rule: Commands are discoverable and keyboard-first

    Scenario: Search and execute a command
      Given the command deck is open
      When the user types a fuzzy query and confirms the selected item
      Then matching commands are filtered without reordering their stable category metadata
      And the selected handler executes once before focus returns to the editor

    Scenario: Close the deck without action
      Given the command deck owns focus
      When the user presses Escape
      Then no command executes
      And previous overlay/editor focus is restored

  Rule: Practical Vim editing is guided and safe

    Scenario: Start a new session
      When the editor is installed
      Then it begins in Insert mode
      And normal Pi application shortcuts continue to work

    Scenario: Use a practical operator and motion
      Given the editor is in Normal mode with the cursor on a word
      When the user enters ciw
      Then the word is replaced according to Vim semantics
      And the editor enters Insert mode

    Scenario: Use visual selection
      Given the editor is in Normal mode
      When the user enters Visual mode and extends the selection with motions
      Then the selected range is visibly indicated
      And a supported operator applies only to that range

    Scenario: Enter an unsupported sequence
      Given the editor receives a Vim command outside the documented subset
      When the sequence cannot be resolved
      Then the input buffer is not corrupted
      And a concise hint identifies the unsupported or incomplete command

  Rule: Lifecycle cleanup is complete

    Scenario Outline: Replace or stop a session runtime
      Given collectors, subscriptions, timers, and overlays are active
      When Pi performs <action>
      Then every resource is disposed idempotently
      And no helper process or stale overlay remains

      Examples:
        | action |
        | reload |
        | new session |
        | resume session |
        | fork session |
        | shutdown |
```

---

## Task Breakdown

| ID | Task | Priority | Dependencies | Status |
|:---|:-----|:---------|:-------------|:-------|
| T1 | Scaffold the standalone Pi package and pin chrysaki-core | High | Core release | done |
| T1.1 | Add package manifest, peer dependencies, resource discovery, and install smoke test | High | T1 | done |
| T2 | Map core tokens to a complete high-contrast Pi theme | High | T1 | done |
| T2.1 | Add theme schema validation, 256-color checks, and HTML export colors | High | T2 | done |
| T3 | Implement runtime coordinator, immutable state store, refresh scheduler, and disposal registry | High | T1 | done |
| T3.1 | Add deterministic clock/process abstractions for tests | High | T3 | done |
| T4 | Implement session/model/context collectors and cached responsive footer | High | T3 | done |
| T4.1 | Port existing Chrysaki telemetry behavior without synchronous render work | High | T4 | done |
| T5 | Implement asynchronous bounded Git collector and `GitSnapshot` | High | T3.1 | done |
| T5.1 | Add timeout, output-cap, backoff, cancellation, and process-group cleanup tests | High | T5 | done |
| T6 | Implement sidebar adapter over Pi's responsive overlay API | High | T3 | done |
| T6.1 | Add auto/pinned/hidden policy, width threshold, promotion ordering, and focus restoration | High | T6 | done |
| T6.2 | Implement context, task, files, and compact indicator modules | High | T6.1 | done |
| T7 | Implement mini Lazygit Git rail from `GitSnapshot` | High | T5, T6.2 | done |
| T7.1 | Add double-border, zero-radius, branch color, file/numstat, and bounded graph rendering | High | T7 | done |
| T8 | Define canonical command registry and palette categories | High | T3 | done |
| T8.1 | Implement fuzzy command deck overlay, filtering, navigation, execution, and focus tests | High | T8 | done |
| T8.2 | Generate key hints and help view from the same registry | High | T8.1 | done |
| T9 | Implement Practical Vim editor state machine starting in Insert mode | High | T3 | done |
| T9.1 | Add motions, counts, operators, undo/paste, search, and common text objects | High | T9 | done |
| T9.2 | Add Visual mode, selection rendering, unsupported-sequence hints, and application-key delegation tests | High | T9.1 | done |
| T10 | Implement Chrysaki header and working indicator treatment | Medium | T2, T3 | done |
| T11 | Add preset registry and initial workflow presets | Medium | T8 | done |
| T12 | Add interactive package settings and persistence | Medium | T6, T8, T9 | done |
| T13 | Add explicit opt-in tmux forwarding adapter and rollback documentation | Medium | T8 | done |
| T14 | Run responsive snapshots, TUI smoke tests, reload/lifecycle tests, and performance benchmarks | High | T2-T13 | done |
| T15 | Add README, screenshots, package metadata, version tag, and Git installation instructions | High | T14 | done |

---

## Exit Criteria

- [x] All Must-Have scenarios pass in CI.
- [ ] No regressions occur in Pi's built-in editing, abort, model, thinking, tool expansion, session, or tree shortcuts.
- [x] Package, state, view, sidebar, and command contracts match implementation.
- [x] Every view line respects the width passed to `render()`.
- [x] No render path performs filesystem, network, Git, JSON parsing, or subprocess work.
- [x] Repeated TUI repaint profiling shows no periodic UI stalls attributable to Chrysaki Pi.
- [x] Reload and all session replacement paths leave no timer, subscription, overlay, or helper process behind.
- [x] Responsive visual snapshots pass for narrow tmux, standard terminal, and wide terminal sizes.
- [ ] The approved Chrysaki Precision visual review passes for theme, footer, rail, Git module, command deck, and editor modes.
- [x] Installation from a pinned Git tag succeeds in a clean Pi configuration and can be removed without altering unrelated user files.
- [x] Optional Git, GitHub, Codex, and tmux integrations fail closed without degrading core Pi operation.

---

## References

- `~/.pi/agent/extensions/chrysaki-statusline.ts`
- `~/.pi/agent/extensions/codex-rate-limits.mjs`
- `~/.claude/statusline/statusline-command.sh`
- `~/dots/chrysaki/PALETTE.md`
- `~/dots/chrysaki/lazygit/config.yml`
- `~/dots/chrysaki/tmux/scripts/palette.sh`
- Pi documentation: `docs/themes.md`, `docs/extensions.md`, `docs/tui.md`, `docs/keybindings.md`, `docs/prompt-templates.md`, and `docs/packages.md`
- Related spec: `~/dots/chrysaki/docs/specs/todo/chrysaki-ecosystem-split-spec.md`

---
*Authored by: OpenAI Codex GPT-5.6-sol*
