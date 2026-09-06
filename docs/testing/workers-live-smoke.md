# Live worker verification — 2026-09-06

## Scope and result

Release target: **v1.2.12**. Verified its worker reliability patch on top of
`v1.2.11` (`59775f0`). The older tag does not contain these fixes. The installed
checkout was left unchanged during verification.

**The final lifecycle run passed for Pi, Claude, and Codex: 21 real jobs.**
Each adapter ran five completed tasks, one deliberate cancellation, and one
deliberate timeout. All 21 jobs had matching cleanup proof. `npm run check`
passed with **159 tests and zero skips**, including real Bubblewrap and tmux
regressions.

Both smoke scripts invoke registered worker tools in a fresh runtime. They use
real interactive tmux sessions, Bubblewrap, credentials, provider requests,
tools, and authoritative mailbox results. They do not mock model responses,
launch headless model CLIs, or manufacture successful worker statuses.

## What was fixed

- Mount the resolved `/etc/resolv.conf` target read-only. On this host it points
  into `/run/systemd/resolve`; the rest of host `/run` stays hidden.
- Pi inherits `ctx.model` from the invoking session unless `adapters.pi.model`
  is explicitly configured. Preflight and the persisted launch contract report
  the same effective model. Claude/Codex do not inherit Pi provider identifiers.
- Set window-local `remain-on-exit` before launching the CLI. Immediate exits
  retain their exit code and diagnostics rather than disappearing during startup.
- Inspect the current screen, not historical trust prompts, and require two
  ready observations. Recognize modern Claude/Codex editors and Codex loading.
- Deliver multiline prompts as a bracketed paste followed by a separate Enter.
- Seed minimal ephemeral Claude/Codex onboarding configuration. Do not copy host
  project settings or hooks. Disable Claude remote control at startup.
- Use the mandatory outer Bubblewrap sandbox for Codex. Its nested sandbox
  attempted to create `/workspace/.agents` on a read-only bind and blocked tools.
  The internal bypass remains guarded by active outer confinement.
- Give external adapters a dependency-free completion helper. It writes the
  result before publishing schema-valid status, rather than relying on the
  model to invent JSON timestamps.
- On cancellation/timeout, capture diagnostics and terminate the owned sandbox.
  Codex's interrupt keys alone left its running shell command alive. Cancelled
  panes are closed; their mailbox and captured log remain until grace cleanup.
- Settle background monitor rejections during runtime disposal. A live reload
  exposed an unhandled `process runner disposed` error.
- Check headless flags against the known provider even when executable symlinks
  resolve to `cli.js` or a version-number binary.

## Reproduce

Run from a development checkout with dependencies and authenticated CLIs:

```bash
# Two concurrent package-reading workers per invocation.
npx tsx scripts/worker-smoke.ts pi
npx tsx scripts/worker-smoke.ts claude
npx tsx scripts/worker-smoke.ts codex

# Isolated synthetic Git repository; seven jobs per adapter.
npx tsx scripts/worker-lifecycle-smoke.ts pi
npx tsx scripts/worker-lifecycle-smoke.ts claude
npx tsx scripts/worker-lifecycle-smoke.ts codex
```

The runners use `PI_PROVIDER`/`PI_MODEL` to represent the parent context passed
to the registered tools. Final Pi runs inherited `openai-codex/gpt-6-astra`;
Claude and Codex used their CLI defaults. No global model setting was changed.
An optional model argument overrides only the test runtime. The read-only smoke
also accepts a repository path; use `-` to leave the model unpinned:

```bash
npx tsx scripts/worker-smoke.ts pi - /path/to/repository
```

## Final lifecycle evidence

Reports are local, private artifacts rather than committed credentials/logs:

- Pi: `/tmp/chrysaki-lifecycle-smoke-syDZvQ/report.json`
- Claude: `/tmp/chrysaki-lifecycle-smoke-aCJo4E/report.json`
- Codex: `/tmp/chrysaki-lifecycle-smoke-UJ5hDb/report.json`

Each directory also contains `cleanup.json` and archived `result.md`,
`status.json`, metadata, and diagnostic panes under `workers/archive/<jobId>/`.

Each final report verifies:

1. **Read confinement:** attempted source and Git-config writes fail; a private
   host file outside the mounts is inaccessible. Source contents stay unchanged.
2. **Concurrent writes:** two workers write different contents to the same
   filename in separate worktrees. Neither changes the source checkout.
3. **Dirty retention:** normal cleanup stops both write workers but retains their
   changes. Only the synthetic output files are removed afterward, then normal
   cleanup removes the now-clean worktrees.
4. **Active follow-up:** `worker_send` changes the answer while a shell command
   is running. The final mailbox contains the updated nonce. Sending to the
   completed job is rejected rather than resurrecting terminal state.
5. **Cancellation:** cancel a running shell before its delayed write; wait beyond
   that write's scheduled time and verify it never occurred.
6. **Recovery:** dispose and replace the parent runtime while a worker sleeps;
   recover its eventual completion. Reveal returns a safe attach command without
   opening a split during the test.
7. **Timeout:** a long task reaches its deadline, returns `timed_out`, and stops.

These checks are grouped into six report entries because concurrent writes and
dirty retention share one entry. All seven jobs per adapter are cleaned up.

Separate two-worker completion evidence:

- Pi: `/tmp/chrysaki-live-smoke-JbWc9J/report.json`
- Claude: `/tmp/chrysaki-live-smoke-EQ97Ve/report.json`
- Codex: `/tmp/chrysaki-live-smoke-mwUDXK/report.json`

The lifecycle Claude run also verifies the newer completion helper, introduced
after its initial two-worker smoke. Earlier Pi read tests passed in both this
repository and `trKip-planner`; no repository files were written by those tests.

## Failures retained as evidence

- Missing resolver target: `/tmp/chrysaki-live-smoke-TyuNxC/report.json`.
- Unintended Anthropic selection and extra-usage rejection:
  `/tmp/chrysaki-live-smoke-5reVHg/report.json`.
- Codex nested-sandbox tool failure:
  `/tmp/chrysaki-live-smoke-NLYhJN/workers/archive/`.
- Codex model-authored invalid status:
  `/tmp/chrysaki-live-smoke-W4Jonu/workers/archive/`.
- Codex cancellation that allowed a delayed write:
  `/tmp/chrysaki-lifecycle-smoke-9x8ruw/`.
- Reload crash: `/tmp/chrysaki-lifecycle-smoke-ZW5CkB/`. Its six surviving test
  jobs were subsequently recovered and cleaned; see `recovered-cleanup.json`.

## Limits

Tested on this Linux host with tmux/Bubblewrap, Pi 0.85, Claude Code 2.1.263,
and Codex 0.153.4. This does not certify other CLI releases, operating systems,
all models, provider outages, or sustained high-volume workloads. Real split
reveal and fallback selection remain fixture-tested, not live-tested here.

Preflight checks local routing and confinement, not remote billing or provider
availability. It must not be presented as proof of successful completion.

The global tmux `remain-on-exit` setting remains `off`. No host authentication
files, worker settings, or installed package checkout were modified. The
parent session's already-loaded tools still use the older installed package.
Install v1.2.12 and restart Pi to use the fixes; verification through those
installed tools is separate from these fresh-runtime checks.
