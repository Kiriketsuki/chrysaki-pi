# Feature: Interactive Tmux Worker Orchestration

## Overview

**User Story**: As a Pi user running custom multi-agent workflows, I want delegated Pi, Claude, and Codex workers to run as real interactive sessions inside isolated tmux workers so that I can supervise them without relying on opaque headless model processes.

**Problem**: Custom Pi workflows currently describe or depend on subprocess-style subagents, including Pi print/JSON mode and external Claude or Codex headless commands. Those paths are difficult to supervise, use inconsistent lifecycle and isolation rules, and do not provide a durable, provider-neutral result protocol.

**Out of Scope**: Building a persistent broker daemon; replacing tmux; scraping pane output as a successful result channel; changing direct user-issued shell commands; migrating non-Pi native orchestration except for conditional compatibility language in shared skills; allowing unrestricted host access for auto-approved workers; treating non-agent telemetry helpers such as the Codex rate-limit app server as delegated model workflows.

---

## Success Condition

> This feature is complete when every custom Pi workflow delegates model work through sandboxed interactive tmux workers, defaults to Pi with configured Claude/Codex fallbacks, returns authoritative mailbox results, supports supervision and cleanup, and CI proves that no delegated workflow invokes a model CLI through print, JSON, RPC, `exec`, or an equivalent headless mode.

---

## Open Questions

| # | Question | Raised By | Resolved |
|:--|:---------|:----------|:---------|
| 1 | Should workers be detached, visible, or hybrid? | Supervision | [x] Detached by default with reveal/attach controls |
| 2 | What is the authoritative result channel? | Reliability | [x] File mailbox only; pane capture is diagnostic |
| 3 | How long should completed sessions remain? | Lifecycle | [x] Configurable grace period before cleanup |
| 4 | How are CLIs selected? | Routing | [x] Capability-aware routing, defaulting to Pi with configured fallbacks |
| 5 | How are writable tasks isolated? | Safety | [x] Git worktree per write worker; shared read-only checkout for read workers |
| 6 | Who chooses concurrency? | Workflow control | [x] Main thread invocation overrides workflow and global defaults |
| 7 | How are interactive prompts handled? | Automation | [x] Provider adapters automatically answer recognized prompts |
| 8 | Where may auto-approved workers write? | Security | [x] Only inside the isolated workspace and mailbox |
| 9 | What is the migration scope? | Rollout | [x] All custom Pi workflows that delegate model work |

---

## Scope

### Must-Have
- Shared worker broker: provide one reusable runtime for dispatch, routing, tmux transport, mailbox monitoring, recovery, retention, and cleanup.
- Interactive-only enforcement: prohibit `pi -p`, Pi JSON/RPC delegation, `claude -p`, `codex exec`, `codex review`, and equivalent non-interactive model execution in broker argv and model-issued workflow commands.
- Hybrid supervision: launch workers in detached tmux sessions and allow users or the parent Pi session to reveal, attach, inspect, message, cancel, and clean them.
- Mailbox contract: create per-job `request.json`, `prompt.md`, `status.json`, `result.md`, `pane.log`, and `metadata.json`; only a valid atomically replaced terminal `status.json` plus `result.md` constitutes success.
- Capability-aware routing: default to interactive Pi, then use configured Claude or Codex fallbacks when capabilities, executable availability, authentication, and sandbox support permit.
- No post-start fallback: never launch a second provider after a worker has begun task execution.
- Provider adapters: isolate interactive argv, readiness recognition, prompt delivery, known-prompt automation, interrupt handling, and diagnostics for Pi, Claude, and Codex.
- Safe prompt delivery: use private tmux buffers and `paste-buffer`, never shell interpolation or per-character `send-keys`, for delegated prompt content.
- Filesystem isolation: mount read jobs against a read-only checkout and write jobs against dedicated Git worktrees; fail closed if the required confinement cannot be established.
- Bounded auto-approval: permit automatic approval only inside the confined workspace and mailbox, with narrowly exposed authentication/configuration state.
- Explicit job state: persist and validate `queued`, `starting`, `ready`, `running`, `blocked`, `completed`, `failed`, `timed_out`, and `cancelled` transitions.
- Pi-native completion: load a worker-only Pi extension that records the final response and terminal state on `agent_settled` without using Pi print, JSON, or RPC modes.
- External CLI completion contract: instruct Claude and Codex workers to write the same mailbox result; a missing result times out rather than falling back to pane scraping.
- Parent-facing tools: expose `worker_run`, `worker_spawn`, `worker_wait`, `worker_status`, `worker_send`, `worker_reveal`, and `worker_cancel` with bounded model-visible output.
- User commands: expose `/workers` and `/worker reveal|status|cancel|cleanup` controls.
- Invocation-owned concurrency: accept explicit concurrency on workflow calls, falling back to workflow and global defaults only when omitted.
- Grace-period cleanup: retain completed/failed sessions for a configurable period, archive diagnostics, and then remove tmux sessions, clean job files according to retention policy, and remove safe temporary worktrees.
- Crash recovery: reconstruct jobs from disk after `/reload`, session replacement, or Pi restart; reconcile live tmux sessions and schedule overdue cleanup.
- Dirty-worktree safety: never remove a dirty completed worktree automatically; report it as retained for manual integration or cleanup.
- Complete workflow migration: inventory all custom Pi skills, prompts, and extensions that delegate model work and migrate their Pi path to `worker_*` tools while preserving chain, wave, council, race, and supervisor semantics.
- Shared-skill compatibility: use conditional instructions so symlinked skills use tmux workers under Pi without breaking native Claude Code orchestration.
- Fail-closed degradation: missing tmux, Bubblewrap, Git worktree support, authentication, or a valid adapter must produce a clear failure without launching an unconfined or headless worker.

### Should-Have
- Compact Chrysaki tool rendering for worker lifecycle, CLI choice, elapsed time, workspace, retention, and completion state.
- Configurable routing order, provider models, interactive arguments, recognized prompts, timeouts, retention, and per-workflow defaults in `~/.pi/agent/chrysaki-workers.json`.
- Outside-tmux reveal behavior that prints an exact safe attach command when an automatic split cannot be created.
- Follow-up prompts through `worker_send` using the same private tmux-buffer transport.
- Full diagnostic pane logs retained when startup, blocking, timeout, or cancellation occurs.
- Workflow migration manifest recording every scanned workflow, whether it delegates, and how it was migrated or excluded.
- Startup preflight command that reports tmux, sandbox, Git, CLI, and authentication readiness without launching a worker.

### Nice-to-Have
- A later daemon-backed broker using the same job and adapter interfaces for cross-process cleanup timers.
- Optional read-only worker overview overlay beyond the normal tool and command rendering.
- Additional interactive CLI adapters registered through a stable adapter interface.
- Workflow-level cost or token telemetry when an interactive CLI exposes it without pane scraping.

### Approved Hardening Upgrade
- Admission control: atomically enforce configurable per-session, per-run, and concurrently executing worker limits before creating any job in a batch. Rejected batches create no mailboxes, workspaces, or tmux sessions.
- Stable ownership: assign every dispatch a durable run ID, exact parent Pi session ID, and stable zero-based child index; preserve these identities across recovery and expose them in status details.
- Launch contracts: persist a canonical task digest and the resolved adapter, model, access, capabilities, workspace, sandbox, timeout, retention, routing attempts, and policy sources for every launched worker.
- Side-effect-free preflight: expose broker preflight plus `/worker doctor` without creating a job, workspace, mailbox, or tmux session.
- Capability ceilings: resolve inherited and configured adapter, access, capability, nesting-depth, and limit ceilings monotonically. Descendants may tighten ceilings but cannot widen them.
- Lifecycle proof: distinguish execution capacity from retained supervisory sessions. Authoritative terminal mailbox state releases execution capacity; destructive cleanup additionally requires verified tmux ownership and process termination.
- Completion batching: coalesce near-simultaneous terminal notifications while failures and blocked workers remain immediate.
- Recovery integrity: reconstruct admission usage, ownership, launch contracts, and retained process state from durable records after reload or restart.
- This upgrade remains native to Chrysaki Workers and does not add `pi-subagents` as a dependency.

---

## Technical Plan

**Affected Components**:
- `extensions/index.ts` for worker tool/command registration, lifecycle hooks, enforcement, and Chrysaki integration.
- `extensions/workers/broker.ts` for provider-neutral dispatch and orchestration.
- `extensions/workers/jobs.ts` for job records, state transitions, persistence, reconciliation, and retention.
- `extensions/workers/mailbox.ts` for atomic mailbox reads/writes, validation, watching, and output truncation.
- `extensions/workers/router.ts` for capability and availability routing with pre-start-only fallback.
- `extensions/workers/tmux.ts` for detached sessions, private paste buffers, capture diagnostics, reveal, interrupt, and termination.
- `extensions/workers/sandbox.ts` for Bubblewrap confinement, read-only checkouts, writable worktrees, and narrow config/auth exposure.
- `extensions/workers/workspaces.ts` for Git worktree creation, ownership, dirty-state checks, and safe cleanup.
- `extensions/workers/adapters/` for Pi, Claude, and Codex interactive adapters.
- `extensions/workers/pi-mailbox-extension.ts` for worker-only `agent_settled` completion output.
- `extensions/workers/tools.ts` and `extensions/workers/render.ts` for Pi tool contracts and TUI presentation.
- `extensions/workers/config.ts` for validated global and workflow-level settings, admission limits, completion batching, and root capability ceilings.
- `extensions/workers/admission.ts` for atomic session/run/execution-capacity claims and durable reconstruction.
- `extensions/workers/contracts.ts` for canonical launch-contract construction, task digests, and side-effect-free preflight DTOs.
- `extensions/workers/capability-ceiling.ts` for monotonic inherited policy intersection and child propagation.
- `extensions/workers/completion-batcher.ts` for bounded terminal-notification grouping.
- `extensions/workers/enforcement.ts` for final argv validation and model-issued Bash headless-command blocking.
- `scripts/` for deterministic fake tmux/CLI fixtures and workflow migration scanning.
- `adapters/tmux/` and `README.md` for setup, supervision, sandbox prerequisites, recovery, and rollback documentation.
- Shared custom skill/prompt sources discovered under Pi resource paths for conditional migration to `worker_*` dispatch.
- `tests/workers/` and package smoke tests for runtime, integration, lifecycle, and migration coverage.

**Data Model Changes**:
- `WorkerRequest`: task, role, capabilities, access mode, preferred CLI, fallback permission, cwd, concurrency, timeout, retention, workflow ID, and metadata.
- `WorkerJob`: immutable identity plus mutable validated state, timestamps, selected adapter, tmux session, workspace, mailbox, ownership, error, and cleanup deadline.
- `WorkerStatusFile`: schema version, job ID, state, progress summary, timestamps, result path, and structured failure details.
- `WorkerAdapter`: `probe`, `buildInteractiveArgv`, `recognizeScreen`, `answerPrompt`, `interrupt`, and optional completion-helper capabilities.
- `WorkerConfig`: routing order, defaults, per-workflow overrides, adapter settings, recognized responses, sandbox policy, retention policy, output limits, admission limits, completion batching, and root capability ceiling.
- `WorkerIdentity`: durable run ID, exact parent session ID, stable child index, parent run ID, and nesting depth.
- `WorkerCapabilityCeiling`: allowed adapters, maximum access, allowed capabilities, maximum depth, and inherited admission bounds.
- `WorkerLaunchContract`: canonical task digest plus resolved routing, model, access, capabilities, workspace, sandbox, timing, and policy-source facts.
- `WorkspaceLease`: read/write mode, source checkout, worktree/copy path, owning job, dirty state, and cleanup eligibility.
- State persists under `~/.pi/agent/workers/jobs/<job-id>/`; in-memory maps are rebuildable caches only.

**API Contracts**:
- `worker_run({ task?, tasks?, access, capabilities?, preferredCli?, concurrency?, timeoutMs?, retentionMs?, workflow? })` starts one or more jobs, enforces the requested concurrency, waits for terminal mailbox states, and returns bounded results plus job metadata.
- `worker_spawn(...)` accepts the same dispatch shape and returns job IDs after successful interactive startup.
- `worker_wait({ jobIds, completion?, timeoutMs? })` waits for all, any, or a requested count of authoritative terminal states.
- `worker_status({ jobIds?, states? })` returns persisted job state without scraping worker output.
- `worker_send({ jobId, prompt })` sends a follow-up through a private tmux paste buffer.
- `worker_reveal({ jobId })` opens a supervisory split when already in tmux or returns a safe attach command otherwise.
- `worker_cancel({ jobIds, reason? })` interrupts workers, records cancellation, and enters grace retention.
- `worker_preflight({ task?, tasks?, access, capabilities?, preferredCli?, concurrency?, timeoutMs?, retentionMs?, workflow? })` resolves admission, ceiling, confinement, routing, and launch-contract facts without side effects.
- `/worker doctor` reports configuration, admission, tmux, sandbox, Git, adapter, authentication, and recovery readiness without launching a worker.
- Adapter launch contract accepts argv arrays only; shell command strings are forbidden.
- Final launch validation rejects non-interactive model modes regardless of adapter configuration.
- Mailbox writers create temporary files, fsync where practical, and rename into place; readers reject schema, job-ID, or transition mismatches.
- Model-visible results use Pi's standard 50 KB/2000-line bounds while full artifacts remain in the mailbox.

**Dependencies**:
- Existing Pi extension APIs, parallel custom tool execution, lifecycle events, custom rendering, and `agent_settled` for the Pi worker helper.
- tmux 3.x for detached sessions, buffers, pane capture, session attachment, and control commands.
- Bubblewrap on Linux for the common filesystem confinement boundary.
- Git for write-worker worktrees; copied non-Git workspaces remain explicitly opt-in.
- Installed/authenticated interactive `pi`, `claude`, and/or `codex` CLIs; Pi is the default route.
- Node.js filesystem/process APIs using argv-safe spawning and abort-aware bounded waits.

**Risks**:
| Risk | Likelihood | Mitigation |
|:-----|:-----------|:-----------|
| Interactive TUI output changes break readiness or prompt recognition | High | Keep recognition adapter-scoped, fixture-tested, conservative, and fail to `blocked` rather than guessing |
| Claude or Codex completes visibly but omits mailbox output | Medium | Treat mailbox as authoritative, provide explicit completion instructions, time out with diagnostics, and never silently scrape a result |
| Auto-approval escapes the intended workspace | High | Require Bubblewrap confinement, mount source read-only, expose only job/worktree paths as writable, and fail closed |
| Authentication state needs writable files outside the sandbox | Medium | Copy or selectively bind only documented provider state into an ephemeral worker home and test each adapter |
| Concurrent workers exceed machine or provider capacity | Medium | Invocation-owned bounded scheduler with validated workflow/global defaults and cancellation propagation |
| Fallback duplicates side effects | High | Permit fallback only before readiness/task delivery; selected adapter becomes immutable once running |
| Dirty worktree cleanup loses changes | High | Detect dirtiness, retain the lease and tmux metadata, and require explicit cleanup/integration |
| Pi exits while workers run | Medium | Persist every transition, let tmux continue, reconcile on startup, and schedule overdue cleanup |
| Shared skill migration breaks Claude Code | Medium | Use runtime-conditional dispatch language and regression-scan both Pi and non-Pi paths |
| Workflow scan flags benign telemetry or documentation | Medium | Use an explicit exclusions manifest with reviewed reasons; block only delegated model execution patterns |
| Private prompts leak through tmux buffers or logs | Low | Use uniquely named buffers, delete immediately after paste, restrict mailbox permissions, and redact diagnostics where possible |

---

## Acceptance Scenarios

```gherkin
Feature: Interactive Tmux Worker Orchestration
  As a Pi user running custom multi-agent workflows
  I want delegated model work to run in supervised isolated tmux sessions
  So that workflows remain interactive, inspectable, safe, and provider-neutral

  Background:
    Given the Chrysaki worker extension is active in interactive Pi
    And tmux and Bubblewrap pass preflight
    And at least one interactive model CLI is authenticated

  Rule: Delegation is interactive-only

    Scenario Outline: Reject prohibited headless invocation
      Given a broker adapter or model-issued Bash call constructs <command>
      When final launch enforcement validates the invocation
      Then the invocation is blocked before process creation
      And the result directs the workflow to use worker_run

      Examples:
        | command |
        | pi -p "task" |
        | pi --mode json "task" |
        | pi --mode rpc |
        | claude --print "task" |
        | codex exec "task" |
        | codex review |

    Scenario: Launch an interactive Pi worker by default
      Given no CLI preference is supplied
      And Pi passes capability, authentication, and sandbox preflight
      When worker_run dispatches a task
      Then a detached tmux session starts an interactive Pi TUI without print, JSON, or RPC mode
      And the task is pasted through a private tmux buffer

  Rule: Routing is deterministic and side-effect safe

    Scenario: Fall back before task execution
      Given Pi fails startup preflight
      And Claude is the next configured eligible adapter
      When the broker routes the task
      Then it starts one interactive Claude worker
      And records Claude as the immutable selected adapter

    Scenario: Do not fall back after delivery
      Given a worker has reached running and received its task
      When the worker later fails
      Then the job becomes failed
      And no fallback worker is launched

  Rule: Mailbox files are authoritative

    Scenario: Complete through an atomic mailbox result
      Given an interactive worker is running
      When it atomically writes a valid result.md and completed status.json
      Then worker_wait returns the bounded result to the parent model
      And preserves the full result on disk

    Scenario: Ignore a partial or invalid status file
      Given an interactive worker is running
      When the mailbox contains a malformed, mismatched, or non-atomic status update
      Then the broker does not report success
      And it continues bounded waiting or reports a validation failure

    Scenario: Refuse pane output as success
      Given the pane visibly contains a final answer
      But no valid terminal mailbox state exists
      When the job deadline expires
      Then the job becomes timed_out
      And pane capture is retained only as diagnostics

  Rule: Workspaces constrain automatic approval

    Scenario: Run a read worker
      Given a workflow requests read access
      When the sandbox starts the worker
      Then the source checkout is mounted read-only
      And only the worker mailbox and ephemeral runtime state are writable

    Scenario: Run a write worker
      Given the current directory is a Git repository
      And a workflow requests write access
      When the sandbox starts the worker
      Then the broker creates a dedicated Git worktree
      And only that worktree, mailbox, and ephemeral runtime state are writable

    Scenario: Confinement is unavailable
      Given the requested worker cannot be confined
      When dispatch evaluates the job
      Then the job fails before CLI launch
      And automatic approval is never enabled outside confinement

    Scenario: Preserve dirty worker changes
      Given a completed write worker has a dirty worktree
      When its grace period expires
      Then the tmux session may be retired
      But the worktree is retained and reported for manual action

  Rule: The main thread controls concurrency

    Scenario: Override workflow defaults
      Given a workflow default concurrency of 2
      And worker_run requests concurrency 5 for five tasks
      When the batch runs
      Then up to five eligible workers may run concurrently
      And the explicit invocation value is recorded in metadata

    Scenario: Use defaults when omitted
      Given worker_run omits concurrency
      When the broker resolves scheduling policy
      Then it uses the workflow default before the global default
      And validates the selected value against safety bounds

  Rule: Workers are supervised through tmux

    Scenario: Reveal a detached worker inside tmux
      Given a running detached worker
      And the parent Pi process is inside tmux
      When the user runs /worker reveal with its job ID
      Then a temporary split attaches to the worker session
      And closing the supervisory pane does not terminate the worker

    Scenario: Reveal a worker outside tmux
      Given a retained worker
      And the parent Pi process is not inside tmux
      When worker_reveal is requested
      Then it returns an exact safe attach command
      And does not disturb the worker session

    Scenario: Send a follow-up
      Given a worker remains interactive
      When worker_send receives a follow-up prompt
      Then it delivers the text through a private tmux paste buffer
      And deletes the buffer after delivery

  Rule: Lifecycle state survives interruption

    Scenario: Cancel from the parent tool call
      Given worker_run owns active workers
      When the parent tool call is aborted
      Then each owned worker is interrupted
      And each job records cancelled before entering grace retention

    Scenario: Recover after Pi exits
      Given a tmux worker continues after the parent Pi process exits
      When Pi starts again with the worker extension
      Then persisted job state and live tmux ownership are reconciled
      And completed results and overdue cleanup are discovered

    Scenario: Clean after the grace period
      Given a terminal job has no dirty workspace
      When its configurable retention deadline passes
      Then its tmux session is killed
      And disposable mailbox and workspace resources are removed according to retention policy

  Rule: Every custom Pi workflow uses the broker

    Scenario: Validate the migration manifest
      Given all discovered custom Pi skills, prompts, and extensions have been inventoried
      When the workflow migration test runs
      Then every delegating workflow uses worker tools on its Pi path
      And every exclusion has a reviewed non-delegation reason

    Scenario: Preserve shared skill behavior outside Pi
      Given a migrated skill is shared with Claude Code
      When it runs outside Pi without worker tools
      Then it follows its native orchestration instructions
      And does not reference unavailable Pi worker tools as mandatory
```

---

## Task Breakdown

| ID | Task | Priority | Dependencies | Status |
|:---|:-----|:---------|:-------------|:-------|
| T1 | Define worker request, job, status, adapter, configuration, and workspace contracts | High | None | done |
| T1.1 | Add strict schemas, state-transition validation, IDs, paths, permissions, and atomic mailbox helpers | High | T1 | done |
| T1.2 | Add validated global, workflow, and invocation override resolution | High | T1 | done |
| T2 | Implement argv-safe tmux transport for detached launch, private paste buffers, capture diagnostics, reveal, interrupt, and kill | High | T1 | done |
| T2.1 | Add deterministic fake tmux fixtures and transport tests | High | T2 | done |
| T3 | Implement Bubblewrap sandbox profiles and ephemeral worker-home handling | High | T1 | done |
| T3.1 | Implement read-only checkout leases and write-capable Git worktree leases | High | T3 | done |
| T3.2 | Add dirty-state detection, ownership records, copied non-Git opt-in, and safe cleanup | High | T3.1 | done |
| T4 | Implement capability-aware router, executable/auth preflight, pre-start fallback, and immutable adapter selection | High | T1.2, T3 | done |
| T4.1 | Implement final argv and model-issued Bash enforcement for prohibited headless model modes | High | T4 | done |
| T5 | Implement the interactive Pi adapter and worker-only mailbox completion extension | High | T2, T3, T4 | done |
| T5.1 | Implement the interactive Claude adapter with confined auto-approval and recognized prompt automation | High | T2, T3, T4 | done |
| T5.2 | Implement the interactive Codex adapter with confined auto-approval and recognized prompt automation | High | T2, T3, T4 | done |
| T5.3 | Add adapter startup, readiness, blocked-state, prompt-response, completion, and interruption fixtures | High | T5-T5.2 | done |
| T6 | Implement the broker scheduler for single, parallel, spawn, wait, timeout, cancellation, and bounded updates | High | T1-T5 | done |
| T6.1 | Ensure explicit invocation concurrency overrides workflow and global defaults | High | T6 | done |
| T6.2 | Add no-post-start-fallback and ownership-aware cancellation tests | High | T6 | done |
| T7 | Implement persisted reconciliation, retained-session recovery, grace timers, pane-log archival, and overdue cleanup | High | T1.1, T2, T3.2, T6 | done |
| T7.1 | Add reload, replacement-session, crash-recovery, malformed-mailbox, and dirty-worktree retention tests | High | T7 | done |
| T8 | Register worker_run, worker_spawn, worker_wait, worker_status, worker_send, worker_reveal, and worker_cancel tools | High | T6, T7 | done |
| T8.1 | Add compact Chrysaki call/result rendering with bounded model-visible output | Medium | T8 | done |
| T8.2 | Register /workers and /worker reveal, status, cancel, and cleanup commands | High | T8 | done |
| T9 | Build workflow discovery and migration manifest tooling across Pi skill, prompt, and extension resource paths | High | T4.1 | pending |
| T9.1 | Migrate all single, parallel, chain, wave, council, supervisor, and race workflows to worker tools on their Pi path | High | T8, T9 | pending |
| T9.2 | Add conditional shared-skill language and non-Pi regression checks | High | T9.1 | pending |
| T9.3 | Add CI scanning for prohibited delegated model invocations and reviewed exclusions | High | T9.1 | pending |
| T10 | Add real tmux and Git integration smoke tests for launch, paste, mailbox completion, reveal, follow-up, cancellation, and cleanup | High | T2-T9 | pending |
| T10.1 | Add package install, /reload, session replacement, shutdown, and no-leaked-session lifecycle tests | High | T10 | pending |
| T11 | Document configuration, preflight, routing, supervision, sandbox requirements, retained worktrees, troubleshooting, and rollback | Medium | T8-T10 | pending |
| T12 | Run the full package check and verify the migration manifest covers every custom Pi workflow | High | T1-T11, T13-T16 | pending |
| T13.0 | Fix interactive adapter executable-identity validation for resolved CLI symlinks so real Pi workers can launch without weakening provider checks | High | T5 | done |
| T13 | Add durable stable run/session/child identity and atomic admission control with per-session, per-run, and active-execution limits | High | T1, T6, T13.0 | done |
| T13.1 | Add all-or-nothing batch admission, release semantics, durable recovery, configuration, and budget exhaustion tests | High | T13 | done |
| T14 | Add monotonic capability ceilings for adapters, access, capabilities, nesting depth, and inherited limits | High | T1.2, T13 | done |
| T14.1 | Propagate effective ceilings into confined children and test that descendants can tighten but never widen them | High | T14 | done |
| T15 | Add canonical launch contracts, task digests, persisted routing evidence, side-effect-free broker preflight, `worker_preflight`, and `/worker doctor` | High | T4, T13, T14 | done |
| T15.1 | Add preflight/no-side-effect, deterministic-digest, routing-diagnostic, and legacy-record recovery tests | High | T15 | done |
| T16 | Add lifecycle process proof, exact ownership verification, completion batching, and recovery-safe notification delivery | High | T7, T13, T15 | pending |
| T16.1 | Add tests for capacity release versus retained sessions, failed cleanup proof, grouped success notifications, and immediate failure/blocked notifications | High | T16 | pending |

---

## Exit Criteria

- [ ] All Must-Have scenarios pass in CI.
- [ ] No regressions occur in the existing Chrysaki editor, footer, rail, command deck, collectors, or lifecycle cleanup.
- [ ] Worker tool, mailbox, adapter, workspace, and configuration contracts match implementation.
- [ ] No custom Pi workflow invokes Pi, Claude, Codex, or another model CLI through print, JSON, RPC, `exec`, review, or an equivalent headless mode.
- [ ] Final adapter argv validation independently enforces the interactive-only policy.
- [ ] Auto-approved workers fail closed unless filesystem confinement is active.
- [ ] Read jobs cannot modify the source checkout, and write jobs cannot modify the parent checkout.
- [ ] Dirty worktrees are retained and never removed by automatic cleanup.
- [ ] Mailbox results are atomic, schema-validated, bounded for model context, and preserved in full on disk.
- [ ] Pane capture is never accepted as a successful result.
- [ ] Explicit invocation concurrency overrides workflow and global defaults, with validated fallback behavior when omitted.
- [ ] Batch admission is all-or-nothing and durable per-session, per-run, and active-execution limits survive recovery.
- [ ] Stable run/session/child identities and canonical launch-contract digests survive reload and legacy-record recovery.
- [ ] Capability ceilings propagate monotonically; no child can widen adapter, access, capability, depth, or admission authority.
- [ ] Preflight and `/worker doctor` create no jobs, mailboxes, workspaces, buffers, or tmux sessions.
- [ ] Execution capacity releases on authoritative terminal state while destructive cleanup requires verified ownership and process termination.
- [ ] Near-simultaneous successful completions are batched, while failures and blocked states notify immediately.
- [ ] Pi, Claude, and Codex interactive adapter fixtures pass readiness, automation, timeout, blocked, and cancellation tests.
- [ ] Real tmux smoke tests pass for detached execution, reveal, follow-up, and cleanup.
- [ ] Reload, session replacement, parent exit, and restart recovery leave no unowned sessions, timers, buffers, or clean worktrees behind.
- [ ] The migration manifest accounts for every discovered custom Pi skill, prompt, and extension, including reviewed exclusions.
- [ ] Shared migrated skills retain valid non-Pi orchestration behavior.
- [ ] Documentation provides installation prerequisites, configuration examples, supervision commands, recovery procedures, and rollback steps.

---

## References

- Pi extension documentation: `/home/kiriketsuki/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi TUI documentation: `/home/kiriketsuki/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Pi subagent example: `/home/kiriketsuki/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`
- Existing package spec: `docs/specs/done/chrysaki-pi-interface-suite-spec.md`
- Existing tmux adapter: `adapters/tmux/`
- Shared custom skills: `~/.pi/agent/skills/` symlinked to their canonical sources

---
*Authored by: Clault Kiper 5.6-sol*
