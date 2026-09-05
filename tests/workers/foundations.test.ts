import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWorkerConfig, resolveWorkerPolicy, saveWorkerConfig, validateInvocationOverrides, validateWorkerConfig } from "../../extensions/workers/config.ts";
import { assertWorkerStateTransition, canTransitionWorkerState, validateWorkerRequest, validateWorkerStatus, validateWorkspaceLease, WorkerValidationError } from "../../extensions/workers/jobs.ts";
import { initializeMailbox, MAILBOX_FILES, readAuthoritativeResult, readWorkerStatus, workerMailboxPaths, writeCompletedResult, writeWorkerStatus } from "../../extensions/workers/mailbox.ts";
import { createWorkerId, WORKER_SCHEMA_VERSION, type WorkerStatusFile } from "../../extensions/workers/types.ts";

const now = "2026-03-19T10:00:00.000Z";
const later = "2026-03-19T10:01:00.000Z";

function status(jobId: string, state: WorkerStatusFile["state"], extra: Partial<WorkerStatusFile> = {}): WorkerStatusFile {
  return { schemaVersion: WORKER_SCHEMA_VERSION, jobId, state, createdAt: now, updatedAt: state === "queued" ? now : later, ...extra };
}

test("worker requests are strict and receive safe defaults", () => {
  const request = validateWorkerRequest({ task: "Inspect the repository", access: "read", cwd: "/repo" });
  assert.deepEqual(request.capabilities, []);
  assert.equal(request.allowFallback, true);
  assert.deepEqual(request.metadata, {});
  assert.throws(() => validateWorkerRequest({ task: "x", access: "read", cwd: "relative" }), WorkerValidationError);
  assert.throws(() => validateWorkerRequest({ task: "x", access: "admin", cwd: "/repo" }), WorkerValidationError);
  assert.throws(() => validateWorkerRequest({ task: "x", access: "read", cwd: "/repo", surprise: true }), WorkerValidationError);
});

test("worker state transitions reject terminal resurrection and invalid skips", () => {
  assert.equal(canTransitionWorkerState("queued", "starting"), true);
  assert.equal(canTransitionWorkerState("blocked", "running"), true);
  assert.equal(canTransitionWorkerState("completed", "running"), false);
  assert.throws(() => assertWorkerStateTransition("queued", "completed"), /Invalid worker state transition/);
  assert.throws(() => assertWorkerStateTransition("failed", "starting"), /Invalid worker state transition/);
});

test("status validation enforces identity, transition, timestamps, and terminal details", () => {
  const jobId = createWorkerId(); const queued = status(jobId, "queued");
  assert.equal(validateWorkerStatus(queued, { expectedJobId: jobId }).state, "queued");
  assert.throws(() => validateWorkerStatus(status(createWorkerId(), "running"), { expectedJobId: jobId }), /mismatch/);
  assert.throws(() => validateWorkerStatus(status(jobId, "completed", { completedAt: later, resultPath: "result.md" }), { expectedJobId: jobId, previous: queued }), /transition/);
  assert.throws(() => validateWorkerStatus(status(jobId, "completed", { completedAt: later }), { expectedJobId: jobId }), /resultPath/);
  assert.throws(() => validateWorkerStatus(status(jobId, "failed"), { expectedJobId: jobId }), /failure details/);
});

test("workspace contracts retain dirty work and constrain lease kinds", () => {
  const common = { sourcePath: "/repo", workspacePath: "/work", owningJobId: createWorkerId(), dirty: false, cleanupEligible: true, createdAt: now };
  assert.equal(validateWorkspaceLease({ ...common, mode: "read", kind: "readonly-bind" }).mode, "read");
  assert.throws(() => validateWorkspaceLease({ ...common, mode: "read", kind: "git-worktree", baseRevision: "a".repeat(40) }), /readonly-bind/);
  assert.throws(() => validateWorkspaceLease({ ...common, mode: "write", kind: "git-worktree", baseRevision: "a".repeat(40), dirty: true }), /Dirty workspaces/);
});

test("mailboxes use fixed contained paths and private atomic files", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-mailbox-")); const jobId = createWorkerId();
  const paths = workerMailboxPaths(root, jobId);
  await initializeMailbox(paths, { task: "Line one\n'$(unsafe)'", access: "read", cwd: "/repo" }, { owner: "test" });
  assert.equal(await readFile(paths.prompt, "utf8"), "Line one\n'$(unsafe)'");
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.prompt)).mode & 0o777, 0o600);
  assert.throws(() => workerMailboxPaths(root, "../escape"), WorkerValidationError);
  assert.equal(JSON.parse(await readFile(paths.request, "utf8")).allowFallback, true);
});

test("mailbox completion is authoritative and model output is bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-result-")); const jobId = createWorkerId(); const paths = workerMailboxPaths(root, jobId);
  await initializeMailbox(paths, { task: "work", access: "write", cwd: "/repo" });
  const running = status(jobId, "running", { startedAt: later });
  await writeWorkerStatus(paths, running);
  await assert.rejects(() => readAuthoritativeResult(paths), /authoritative/);
  const completed = status(jobId, "completed", { startedAt: later, completedAt: later, resultPath: MAILBOX_FILES.result });
  await writeCompletedResult(paths, "alpha\nbeta\ngamma", completed, running);
  assert.equal((await readWorkerStatus(paths)).state, "completed");
  const bounded = await readAuthoritativeResult(paths, 1024, 2);
  assert.equal(bounded.text, "alpha\nbeta"); assert.equal(bounded.truncated, true);
  assert.equal(await readFile(bounded.fullPath, "utf8"), "alpha\nbeta\ngamma");
});

test("configuration is strict, immutable, and persisted privately", async () => {
  const config = validateWorkerConfig({ concurrency: 4, adapters: { pi: { model: "test-model", interactiveArgs: ["--safe"] } }, workflows: { council: { concurrency: 3 } } });
  assert.equal(config.routingOrder[0], "pi"); assert.equal(config.adapters.pi.model, "test-model");
  assert.equal(config.sandbox.requireBubblewrap, true);
  assert.throws(() => validateWorkerConfig({ concurrency: 0 }), WorkerValidationError);
  assert.throws(() => validateWorkerConfig({ adapters: { pi: { headless: true } } }), WorkerValidationError);
  assert.throws(() => validateInvocationOverrides({ concurrency: 2, unknown: true }), WorkerValidationError);
  const root = await mkdtemp(join(tmpdir(), "chrysaki-config-")); const path = join(root, "workers.json");
  await saveWorkerConfig(config, path);
  assert.equal((await loadWorkerConfig(path)).concurrency, 4);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("invocation overrides workflow and global policy deterministically", () => {
  const config = validateWorkerConfig({ concurrency: 1, timeoutMs: 10_000, allowFallback: false, routingOrder: ["pi", "claude"], workflows: { race: { concurrency: 3, timeoutMs: 20_000, allowFallback: true, routingOrder: ["claude", "pi"] } } });
  const resolved = resolveWorkerPolicy(config, "race", { concurrency: 5, preferredCli: "codex" });
  assert.equal(resolved.concurrency, 5); assert.equal(resolved.source.concurrency, "invocation");
  assert.equal(resolved.timeoutMs, 20_000); assert.equal(resolved.source.timeoutMs, "workflow");
  assert.deepEqual(resolved.routingOrder, ["codex", "claude", "pi"]);
  assert.equal(resolved.allowFallback, true);
  const global = resolveWorkerPolicy(config, "missing");
  assert.equal(global.concurrency, 1); assert.equal(global.allowFallback, false); assert.equal(global.source.routingOrder, "global");
});
