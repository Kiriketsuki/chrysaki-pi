// Opt-in live-provider smoke test. Invoke the registered worker tools, not a
// separate/headless model runner. Each run uses private, isolated job storage.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadWorkerConfig, validateWorkerConfig } from "../extensions/workers/config.ts";
import { createChrysakiWorkerRuntime } from "../extensions/workers/runtime.ts";
import { registerWorkerTools } from "../extensions/workers/tools.ts";
import type { WorkerAdapterId } from "../extensions/workers/types.ts";

const provider = process.argv[2] as WorkerAdapterId;
assert.ok(["pi", "claude", "codex"].includes(provider), "Usage: tsx scripts/worker-smoke.ts pi|claude|codex [model] [cwd]");
const model = process.argv[3] === "-" ? undefined : process.argv[3];
const cwd = resolve(process.argv[4] ?? process.cwd());
const directory = await mkdtemp(join(tmpdir(), "chrysaki-live-smoke-"));
await chmod(directory, 0o700);
const config = await loadWorkerConfig();
const runtime = await createChrysakiWorkerRuntime({
  agentDirectory: directory,
  config: validateWorkerConfig({ ...config, retentionMs: 600_000, ...(model ? { adapters: { ...config.adapters, [provider]: { ...config.adapters[provider], model } } } : {}) }),
});
const tools = new Map<string, any>();
registerWorkerTools({ registerTool(tool: any) { tools.set(tool.name, tool); } }, () => runtime.broker);
const sessionId = `smoke-${randomUUID()}`;
const parentModel = process.env.PI_PROVIDER && process.env.PI_MODEL ? { provider: process.env.PI_PROVIDER, id: process.env.PI_MODEL } : undefined;
const ctx = { cwd, model: parentModel, sessionManager: { getSessionId: () => sessionId } };
const nonce = `smoke-${randomUUID()}`;
const tasks = ["A", "B"].map((part) => `This is an end-to-end worker smoke test. Use the read tool to read /workspace/package.json. Reply with exactly '${nonce}-${part}: ' followed by the package name. Do not write or edit repository files. Do not run any model CLI.`);
const input = { tasks, access: "read", preferredCli: provider, allowFallback: false, concurrency: 2, timeoutMs: 90_000, retentionMs: 600_000, workflow: "live-smoke" };
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Live smoke deadline")), 125_000);
console.log(`Artifacts: ${directory}`);
runtime.broker.subscribeUpdates((update) => console.log(`${update.jobId} ${update.state}: ${update.progress ?? ""}`));
try {
  await runtime.start();
  await tools.get("worker_preflight").execute("smoke-preflight", input, controller.signal, undefined, ctx);
  const result = await tools.get("worker_run").execute("smoke-run", input, controller.signal, undefined, ctx);
  console.log(result.content[0].text);
  const jobs = await runtime.broker.status();
  await writeFile(join(directory, "report.json"), JSON.stringify({ provider, model, parentModel, nonce, jobs }, null, 2), { mode: 0o600 });
  assert.equal(jobs.length, 2);
  const packageName = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).name;
  for (const entry of jobs) {
    assert.equal(entry.status.state, "completed", entry.status.failure?.message ?? "worker did not complete");
    assert.equal(entry.result?.trim(), `${nonce}-${["A", "B"][entry.job.childIndex!]}: ${packageName}`);
    assert.equal(entry.job.selectedAdapter, provider);
    console.log(`Verified result.md + completed status: ${entry.job.id}`);
  }
  console.log("PASS: two real, concurrent workers read the workspace and completed through the mailbox.");
} finally {
  clearTimeout(timer);
  const jobs = await runtime.broker.status();
  await runtime.broker.cancel(jobs.filter((entry) => !["completed", "failed", "timed_out", "cancelled"].includes(entry.status.state)).map((entry) => entry.job.id), "Live smoke cleanup");
  try {
    const cleanup = await runtime.broker.cleanup(jobs.map((entry) => entry.job.id));
    await writeFile(join(directory, "cleanup.json"), JSON.stringify(cleanup, null, 2), { mode: 0o600 });
    assert.ok(cleanup.every((entry) => entry.cleaned && entry.processTerminated === true), "Smoke test leaked a worker session or workspace; inspect cleanup.json");
    console.log(`Verified cleanup: ${cleanup.length} workers terminated and private workspaces removed.`);
  } finally { runtime.dispose(); }
}
