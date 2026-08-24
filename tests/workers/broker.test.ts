import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerBroker } from "../../extensions/workers/broker.ts";
import { validateWorkerConfig } from "../../extensions/workers/config.ts";
import { bindAdapterSelection } from "../../extensions/workers/router.ts";
import { workerMailboxPaths, writeCompletedResult, writeWorkerStatus } from "../../extensions/workers/mailbox.ts";
import { WORKER_SCHEMA_VERSION, type WorkerAdapter, type WorkerJob, type WorkerStatusFile, type WorkspaceLease } from "../../extensions/workers/types.ts";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function harness(options: { readonly fakeClock?: boolean; readonly dirtyCleanup?: boolean; readonly config?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-broker-")); const source = join(root, "source"); const jobs = join(root, "jobs"); const executable = join(root, "runtime", "pi");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(source), mkdir(join(root, "runtime"))]));
  await writeFile(join(root, "runtime", "package.json"), "{}"); await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o755);
  const interrupts: string[] = []; const prompts: Array<{ session: string; text: string }> = []; let routeCalls = 0; let workspaceActive = 0; let maxWorkspaceActive = 0;
  const adapter: WorkerAdapter = {
    id: "pi", executable,
    async probe() { return { available: true, authenticated: true, sandboxSupported: true, capabilities: ["code"] }; },
    buildInteractiveArgv(context) { return [context.executablePath]; }, buildPrompt(context) { return context.task; },
    recognizeScreen() { return { state: "ready" }; }, answerPrompt() { return undefined; },
    async interrupt(context) { interrupts.push(context.jobId); }, completionHelper: "mailbox-instructions",
  };
  const router: any = {
    async routeForJob(job: WorkerJob) {
      routeCalls++;
      return { job: bindAdapterSelection(job, "pi"), selection: { adapterId: "pi", adapter, executablePath: executable, probe: { available: true, authenticated: true, sandboxSupported: true, capabilities: ["code"] }, attempts: [{ adapterId: "pi", eligible: true, executablePath: executable }], selectedAt: new Date().toISOString() } };
    },
  };
  const cleanedWorkspaces: string[] = [];
  const workspaces: any = {
    async create(request: any): Promise<WorkspaceLease> {
      workspaceActive++; maxWorkspaceActive = Math.max(maxWorkspaceActive, workspaceActive); await delay(15); workspaceActive--;
      return { mode: request.mode, sourcePath: source, workspacePath: source, owningJobId: request.jobId, kind: "readonly-bind", dirty: false, cleanupEligible: true, createdAt: new Date().toISOString() };
    },
    async cleanup(jobId: string) {
      if (options.dirtyCleanup) return { removed: false, retained: true, dirty: true, reason: "Workspace contains unintegrated changes" };
      cleanedWorkspaces.push(jobId); return { removed: true, retained: false, dirty: false };
    },
  };
  const sandbox: any = {
    async createProfile(request: any) { return { active: true, jobId: request.jobId, binary: "bwrap", homePath: "/home/worker", guestCwd: "/workspace", mounts: [], baseArgs: [], environment: {}, authPaths: [] }; },
    buildArgv(_profile: any, argv: readonly string[]) { return ["bwrap", "--", ...argv]; },
  };
  const sessions = new Set<string>();
  const tmux: any = {
    async launch(request: any) { const name = `chrysaki-${request.jobId}`; sessions.add(name); return { name, jobId: request.jobId, ownerId: request.ownerId }; },
    async hasSession(name: string) { return sessions.has(name); }, async capturePane() { return "ready"; },
    async paste(session: string, text: string) { prompts.push({ session, text }); }, async interrupt() {},
    async archivePane() { return "diagnostic"; }, async kill(name: string) { return sessions.delete(name); },
    async reveal(name: string, parent?: string) { return { mode: parent ? "split" : "attach-command", argv: ["tmux", "attach-session", "-t", name], command: `'tmux' 'attach-session' '-t' '${name}'` }; },
  };
  const config = validateWorkerConfig({ concurrency: 1, timeoutMs: 2_000, retentionMs: 10_000, workflows: { wave: { concurrency: 1 } }, ...(options.config ?? {}) });
  const updates: any[] = []; let clock = Date.now();
  const brokerOptions = { config, router, workspaces, sandbox, tmux, jobsRoot: jobs, archiveRoot: join(root, "archive"), startupTimeoutMs: 200, pollIntervalMs: 5, onUpdate: (update: any) => updates.push(update),
    ...(options.fakeClock ? { now: () => clock, sleep: async (milliseconds: number, signal?: AbortSignal) => { signal?.throwIfAborted(); clock += Math.max(milliseconds, 1_001); } } : {}),
  };
  const broker = new WorkerBroker(brokerOptions);
  return { broker, restart: () => new WorkerBroker(brokerOptions), config, root, source, jobs, adapter, router, workspaces, sandbox, tmux, prompts, interrupts, updates, sessions, cleanedWorkspaces, advance: (milliseconds: number) => { clock += milliseconds; }, get routeCalls() { return routeCalls; }, get maxWorkspaceActive() { return maxWorkspaceActive; } };
}

async function complete(job: WorkerJob, previous: WorkerStatusFile, text: string) {
  const paths = workerMailboxPaths(join(job.mailboxPath, ".."), job.id); const completedAt = new Date(Date.now() + 10).toISOString();
  await writeCompletedResult(paths, text, { schemaVersion: WORKER_SCHEMA_VERSION, jobId: job.id, state: "completed", createdAt: previous.createdAt, updatedAt: completedAt, startedAt: previous.startedAt, completedAt, resultPath: "result.md" }, previous);
}

async function fail(job: WorkerJob, previous: WorkerStatusFile, message: string) {
  const paths = workerMailboxPaths(join(job.mailboxPath, ".."), job.id); const completedAt = new Date(Date.now() + 10).toISOString();
  await writeWorkerStatus(paths, { schemaVersion: WORKER_SCHEMA_VERSION, jobId: job.id, state: "failed", createdAt: previous.createdAt, updatedAt: completedAt, startedAt: previous.startedAt, completedAt, failure: { code: "provider_failed", message, retryable: false } }, previous);
}

test("explicit invocation concurrency overrides workflow/global defaults and scheduler bounds startup", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ tasks: ["one", "two", "three", "four", "five"], access: "read", cwd: item.source, workflow: "wave", concurrency: 3, capabilities: ["code"] }, { ownerId: "wave-owner" });
  assert.equal(spawned.concurrency, 3); assert.equal(item.maxWorkspaceActive, 3); assert.equal(spawned.jobs.length, 5);
  assert.ok(spawned.jobs.every((entry) => entry.status.state === "running" && entry.job.request.concurrency === 3));
  assert.deepEqual(item.prompts.map((entry) => entry.text).sort(), ["five", "four", "one", "three", "two"]);
  await Promise.all(spawned.jobs.map((entry, index) => complete(entry.job, entry.status, `result-${index}`)));
  const waited = await item.broker.wait({ jobIds: spawned.jobs.map((entry) => entry.job.id), completion: "all" });
  assert.deepEqual(waited.map((entry) => entry.result), ["result-0", "result-1", "result-2", "result-3", "result-4"]);
});

test("dispatch persists stable run, parent-session, and child identities", async () => {
  const item = await harness(); const runId = `run_12345678-1234-4123-8123-123456789abc`;
  const spawned = await item.broker.spawn({ tasks: ["one", "two"], access: "read", cwd: item.source }, { ownerId: "tool-call", runId, parentSessionId: "/sessions/parent.jsonl", depth: 2 });
  assert.equal(spawned.runId, runId); assert.equal(spawned.parentSessionId, "/sessions/parent.jsonl");
  assert.deepEqual(spawned.jobs.map((entry) => ({ runId: entry.job.runId, session: entry.job.parentSessionId, index: entry.job.childIndex, depth: entry.job.depth })), [
    { runId, session: "/sessions/parent.jsonl", index: 0, depth: 2 }, { runId, session: "/sessions/parent.jsonl", index: 1, depth: 2 },
  ]);
  await item.broker.cancel(spawned.jobs.map((entry) => entry.job.id), "test cleanup");
});

test("admission rejects an oversized batch before creating mailboxes or sessions", async () => {
  const item = await harness({ config: { maxActiveWorkers: 1 } });
  await assert.rejects(() => item.broker.spawn({ tasks: ["one", "two"], access: "read", cwd: item.source }, { parentSessionId: "session" }), /active limit exceeded/);
  assert.equal((await item.broker.status()).length, 0); assert.equal(item.sessions.size, 0);
});

test("scheduler uses workflow concurrency before global concurrency when invocation omits it", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ tasks: ["one", "two", "three"], access: "read", cwd: item.source, workflow: "wave" });
  assert.equal(spawned.concurrency, 1); assert.equal(item.maxWorkspaceActive, 1); assert.ok(spawned.jobs.every((entry) => entry.job.request.concurrency === 1));
  await item.broker.cancel(spawned.jobs.map((entry) => entry.job.id), "test cleanup");
});

test("provider failure after delivery never routes or launches a fallback", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ task: "side effect", access: "read", cwd: item.source, capabilities: ["code"] }); const entry = spawned.jobs[0];
  assert.equal(item.routeCalls, 1); assert.equal(item.prompts.length, 1);
  await fail(entry.job, entry.status, "failed after delivery");
  const [result] = await item.broker.wait({ jobIds: [entry.job.id], completion: "all" });
  assert.equal(result.status.state, "failed"); assert.equal(item.routeCalls, 1); assert.equal(item.prompts.length, 1);
});

test("ownership-aware cancellation interrupts only jobs owned by the caller", async () => {
  const item = await harness();
  const owned = await item.broker.spawn({ tasks: ["a", "b"], access: "read", cwd: item.source }, { ownerId: "owner-a" });
  const other = await item.broker.spawn({ task: "c", access: "read", cwd: item.source }, { ownerId: "owner-b" });
  const cancelled = await item.broker.cancelOwner("owner-a", "parent aborted");
  assert.equal(cancelled.length, 2); assert.ok(cancelled.every((entry) => entry.status.state === "cancelled"));
  assert.deepEqual(new Set(item.interrupts), new Set(owned.jobs.map((entry) => entry.job.id)));
  assert.equal((await item.broker.status([other.jobs[0].job.id]))[0].status.state, "running");
});

test("aborting worker_run cancels every active job created by that invocation", async () => {
  const item = await harness(); const controller = new AbortController();
  const running = item.broker.run({ tasks: ["a", "b", "c"], access: "read", cwd: item.source, concurrency: 2, timeoutMs: 2_000 }, { ownerId: "run-owner", signal: controller.signal });
  while (item.updates.filter((update) => update.state === "running").length < 3) await delay(5);
  controller.abort(); await assert.rejects(() => running, { name: "AbortError" });
  const statuses = await item.broker.status(); const owned = statuses.filter((entry) => entry.job.ownerId === "run-owner");
  assert.equal(owned.length, 3); assert.ok(owned.every((entry) => entry.status.state === "cancelled"));
});

test("task deadlines reject a completed status without result.md and never accept pane output", async () => {
  const item = await harness({ fakeClock: true }); const spawned = await item.broker.spawn({ task: "never writes mailbox", access: "read", cwd: item.source, timeoutMs: 1_000 });
  const entry = spawned.jobs[0]; const paths = workerMailboxPaths(join(entry.job.mailboxPath, ".."), entry.job.id); const completedAt = new Date(Date.now() + 10).toISOString();
  await writeWorkerStatus(paths, { schemaVersion: WORKER_SCHEMA_VERSION, jobId: entry.job.id, state: "completed", createdAt: entry.status.createdAt, updatedAt: completedAt, startedAt: entry.status.startedAt, completedAt, resultPath: "result.md" }, entry.status);
  const [result] = await item.broker.wait({ jobIds: [entry.job.id], completion: "all" });
  assert.equal(result.status.state, "timed_out"); assert.equal(result.status.failure?.code, "worker_timed_out"); assert.equal(result.result, undefined);
  assert.equal(item.routeCalls, 1); assert.equal(item.prompts.length, 1); assert.deepEqual(item.interrupts, [result.job.id]);
});

test("worker_wait supports any and count completion without mutating pending jobs", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ tasks: ["a", "b", "c"], access: "read", cwd: item.source, concurrency: 3 });
  await complete(spawned.jobs[1].job, spawned.jobs[1].status, "second");
  const any = await item.broker.wait({ jobIds: spawned.jobs.map((entry) => entry.job.id), completion: "any" }); assert.equal(any.filter((entry) => entry.status.state === "completed").length, 1);
  await complete(spawned.jobs[2].job, spawned.jobs[2].status, "third");
  const count = await item.broker.wait({ jobIds: spawned.jobs.map((entry) => entry.job.id), completion: 2 }); assert.equal(count.filter((entry) => entry.status.state === "completed").length, 2); assert.equal(count[0].status.state, "running");
  await item.broker.cancel([spawned.jobs[0].job.id], "test cleanup");
});

test("reconciliation recovers live tmux workers across reload and replacement sessions", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ task: "survive reload", access: "read", cwd: item.source }); const id = spawned.jobs[0].job.id;
  item.broker.dispose(); const replacement = item.restart();
  const recovered = await replacement.reconcile();
  assert.equal(recovered.recovered, 1); assert.equal(recovered.active, 1);
  assert.equal((await replacement.status([id]))[0].status.state, "running");
  assert.equal((await replacement.reveal(id, "")).mode, "attach-command");
  await replacement.cancel([id], "test cleanup"); replacement.dispose();
});

test("recovered live workers continue mailbox monitoring after parent replacement", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ task: "complete after replacement", access: "read", cwd: item.source }); const entry = spawned.jobs[0];
  item.broker.dispose(); const replacement = item.restart(); await replacement.reconcile();
  await complete(entry.job, entry.status, "monitored result"); await delay(30);
  const metadata = JSON.parse(await readFile(workerMailboxPaths(item.jobs, entry.job.id).metadata, "utf8"));
  assert.equal(metadata.job.state, "completed"); assert.equal((await replacement.status([entry.job.id]))[0].result, "monitored result"); replacement.dispose();
});

test("crash recovery discovers an authoritative completion written while parent was absent", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ task: "finish after crash", access: "read", cwd: item.source }); const entry = spawned.jobs[0];
  item.broker.dispose(); await complete(entry.job, entry.status, "recovered result");
  const replacement = item.restart(); const recovered = await replacement.reconcile(); const [result] = await replacement.status([entry.job.id]);
  assert.equal(recovered.terminal, 1); assert.equal(result.status.state, "completed"); assert.equal(result.result, "recovered result"); replacement.dispose();
});

test("reconciliation treats malformed mailbox status as non-authoritative", async () => {
  const item = await harness(); const spawned = await item.broker.spawn({ task: "malformed", access: "read", cwd: item.source }); const entry = spawned.jobs[0];
  await writeFile(workerMailboxPaths(item.jobs, entry.job.id).status, "{partial"); item.broker.dispose();
  const replacement = item.restart(); const recovered = await replacement.reconcile();
  assert.equal(recovered.active, 1); assert.equal((await replacement.status([entry.job.id]))[0].status.state, "running");
  await replacement.cancel([entry.job.id], "validation failure cleanup"); replacement.dispose();
});

test("grace cleanup archives diagnostics and removes only overdue clean resources", async () => {
  const item = await harness({ fakeClock: true }); const spawned = await item.broker.spawn({ task: "retained", access: "read", cwd: item.source, retentionMs: 5_000 }); const entry = spawned.jobs[0];
  await complete(entry.job, entry.status, "done"); await item.broker.status([entry.job.id]);
  assert.deepEqual(await item.broker.cleanup(undefined, { overdueOnly: true }), []);
  item.advance(6_000); const [cleaned] = await item.broker.cleanup(undefined, { overdueOnly: true });
  assert.equal(cleaned.cleaned, true); assert.equal(item.sessions.size, 0); assert.deepEqual(item.cleanedWorkspaces, [entry.job.id]);
  assert.equal(await readFile(join(cleaned.archivePath!, "result.md"), "utf8"), "done");
  await assert.rejects(() => stat(entry.job.mailboxPath), { code: "ENOENT" });
  item.broker.dispose();
});

test("overdue dirty worktrees retire tmux but retain mailbox and workspace ownership", async () => {
  const item = await harness({ fakeClock: true, dirtyCleanup: true }); const spawned = await item.broker.spawn({ task: "dirty", access: "read", cwd: item.source, retentionMs: 0 }); const entry = spawned.jobs[0];
  await complete(entry.job, entry.status, "changes retained"); await item.broker.status([entry.job.id]); item.advance(100);
  const [retained] = await item.broker.cleanup(undefined, { overdueOnly: true });
  assert.equal(retained.retained, true); assert.equal(retained.dirty, true); assert.equal(item.sessions.size, 0);
  assert.equal((await item.broker.status([entry.job.id]))[0].job.workspace?.dirty, true);
  assert.equal(JSON.parse(await readFile(workerMailboxPaths(item.jobs, entry.job.id).metadata, "utf8")).retainedReason, "Workspace contains unintegrated changes");
  item.broker.dispose();
});
