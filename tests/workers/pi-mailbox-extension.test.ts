import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeMailbox, readWorkerStatus, workerMailboxPaths, writeWorkerStatus } from "../../extensions/workers/mailbox.ts";
import { extractFinalAssistant, installPiMailboxExtension } from "../../extensions/workers/pi-mailbox-extension.ts";
import { createWorkerId, WORKER_SCHEMA_VERSION, type WorkerStatusFile } from "../../extensions/workers/types.ts";

async function mailbox() {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-pi-mailbox-")); const jobId = createWorkerId(); const paths = workerMailboxPaths(root, jobId);
  await initializeMailbox(paths, { task: "work", access: "read", cwd: "/repo" });
  const running: WorkerStatusFile = { schemaVersion: WORKER_SCHEMA_VERSION, jobId, state: "running", createdAt: "2026-03-19T10:00:00.000Z", updatedAt: "2026-03-19T10:01:00.000Z", startedAt: "2026-03-19T10:01:00.000Z" };
  await writeWorkerStatus(paths, running); return { root, jobId, paths, running };
}

function extensionHarness(environment: Record<string, string>) {
  const handlers = new Map<string, Function[]>(); const pi: any = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  installPiMailboxExtension(pi, environment); return { handlers, pi };
}

function context(message?: any): any {
  return { sessionManager: { getBranch: () => message ? [{ type: "message", message }] : [] } };
}

test("Pi mailbox extension has no package-local runtime dependencies inside the sandbox", async () => {
  const source = await readFile(new URL("../../extensions/workers/pi-mailbox-extension.ts", import.meta.url), "utf8");
  const runtimeImports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(runtimeImports.every((specifier) => specifier.startsWith("node:")), `unexpected sandbox runtime import: ${runtimeImports.join(", ")}`);
});

test("Pi worker completion writes result first and atomically publishes completed status", async () => {
  const item = await mailbox(); const harness = extensionHarness({ CHRYSAKI_WORKER_JOB_ID: item.jobId, CHRYSAKI_MAILBOX: item.paths.directory, CHRYSAKI_CONFINED: "1" });
  const trust = await harness.handlers.get("project_trust")![0]({ cwd: "/workspace/project" }, {}); assert.deepEqual(trust, { trusted: "yes", remember: false });
  const assistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Detailed result" }, { type: "text", text: "Second block" }] };
  await harness.handlers.get("agent_settled")![0]({}, context(assistant));
  assert.equal(await readFile(item.paths.result, "utf8"), "Detailed result\nSecond block");
  const status = await readWorkerStatus(item.paths, { previous: item.running }); assert.equal(status.state, "completed"); assert.equal(status.resultPath, "result.md"); assert.ok(status.completedAt);
  assert.equal((await readdir(item.paths.directory)).some((name) => name.endsWith(".tmp")), false);
  // Duplicate settled events cannot rewrite a terminal mailbox.
  await harness.handlers.get("agent_settled")![0]({}, context({ ...assistant, content: [{ type: "text", text: "replacement" }] }));
  assert.equal(await readFile(item.paths.result, "utf8"), "Detailed result\nSecond block");
});

test("Pi worker completion records strict failure when no complete assistant response exists", async () => {
  const item = await mailbox(); const harness = extensionHarness({ CHRYSAKI_WORKER_JOB_ID: item.jobId, CHRYSAKI_MAILBOX: item.paths.directory, CHRYSAKI_CONFINED: "1" });
  await harness.handlers.get("agent_settled")![0]({}, context({ role: "assistant", stopReason: "length", errorMessage: "token limit", content: [{ type: "text", text: "partial" }] }));
  const status = await readWorkerStatus(item.paths, { previous: item.running }); assert.equal(status.state, "failed"); assert.equal(status.failure?.code, "pi_worker_completion_failed"); assert.match(status.failure?.message ?? "", /token limit/);
  await assert.rejects(() => readFile(item.paths.result, "utf8"), { code: "ENOENT" });
});

test("Pi mailbox helper refuses unconfined trust and mismatched mailbox identity", async () => {
  const item = await mailbox(); const harness = extensionHarness({ CHRYSAKI_WORKER_JOB_ID: item.jobId, CHRYSAKI_MAILBOX: item.paths.directory, CHRYSAKI_CONFINED: "0" });
  assert.deepEqual(await harness.handlers.get("project_trust")![0]({ cwd: "/workspace" }, {}), { trusted: "undecided" });
  assert.throws(() => extensionHarness({ CHRYSAKI_WORKER_JOB_ID: createWorkerId(), CHRYSAKI_MAILBOX: item.paths.directory, CHRYSAKI_CONFINED: "1" }), /does not match/);
  assert.throws(() => extensionHarness({ CHRYSAKI_WORKER_JOB_ID: item.jobId, CHRYSAKI_MAILBOX: "relative" }), /absolute/);
});

test("assistant extraction selects the newest assistant text only", () => {
  const ctx: any = { sessionManager: { getBranch: () => [
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "new" }] } },
  ] } };
  assert.deepEqual(extractFinalAssistant(ctx), { text: "new", stopReason: "stop" });
});
