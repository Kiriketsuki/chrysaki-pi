import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerAdmissionController, WorkerAdmissionError } from "../../extensions/workers/admission.ts";
import { validateWorkerConfig } from "../../extensions/workers/config.ts";
import { createWorkerId, createWorkerRunId } from "../../extensions/workers/types.ts";

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-admission-"));
  const path = join(root, "admission.json");
  const config = validateWorkerConfig({ maxActiveWorkers: 2, maxSpawnsPerRun: 3, maxSpawnsPerSession: 4, ...overrides });
  return { root, path, config, controller: new WorkerAdmissionController(path, config) };
}

const identity = (sessionId: string, runId: string, childIndex: number) => ({ jobId: createWorkerId(), sessionId, runId, childIndex });

test("batch admission is all-or-nothing across active, run, and session limits", async () => {
  const item = await fixture(); const sessionId = "session-a"; const runId = createWorkerRunId();
  const first = [identity(sessionId, runId, 0), identity(sessionId, runId, 1)];
  await item.controller.claimBatch(first); await Promise.all(first.map((entry) => item.controller.commitJob(entry.jobId)));
  await assert.rejects(() => item.controller.claimBatch([identity(sessionId, runId, 2)]), WorkerAdmissionError);
  const snapshot = await item.controller.snapshot(sessionId, runId);
  assert.deepEqual({ active: snapshot.active, run: snapshot.runSpawns, session: snapshot.sessionSpawns }, { active: 2, run: 2, session: 2 });
});

test("terminal release frees execution capacity but preserves cumulative budgets across restart", async () => {
  const item = await fixture(); const sessionId = "session-a"; const runId = createWorkerRunId(); const first = identity(sessionId, runId, 0);
  await item.controller.claimBatch([first]); await item.controller.commitJob(first.jobId); await item.controller.releaseExecution(first.jobId);
  const replacement = new WorkerAdmissionController(item.path, item.config); const second = identity(sessionId, runId, 1);
  await replacement.claimBatch([second]); await replacement.commitJob(second.jobId);
  const snapshot = await replacement.snapshot(sessionId, runId);
  assert.deepEqual({ active: snapshot.active, run: snapshot.runSpawns, session: snapshot.sessionSpawns }, { active: 1, run: 2, session: 2 });
});

test("reconciliation removes crash-interrupted reservations and releases recovered terminal jobs", async () => {
  const item = await fixture(); const sessionId = "session-a"; const runId = createWorkerRunId(); const pending = identity(sessionId, runId, 0); const completed = identity(sessionId, runId, 1);
  await item.controller.claimBatch([pending, completed]); await item.controller.commitJob(completed.jobId);
  await item.controller.reconcile([{ id: completed.jobId, state: "completed" }]);
  const snapshot = await item.controller.snapshot(sessionId, runId);
  assert.deepEqual({ active: snapshot.active, run: snapshot.runSpawns, session: snapshot.sessionSpawns }, { active: 0, run: 1, session: 1 });
});
