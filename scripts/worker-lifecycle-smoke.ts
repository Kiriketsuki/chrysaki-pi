// Opt-in real interactive worker tests. No model CLI is launched outside the
// registered worker tools; all Git/filesystem fixtures are private to this run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadWorkerConfig, validateWorkerConfig } from "../extensions/workers/config.ts";
import { createChrysakiWorkerRuntime } from "../extensions/workers/runtime.ts";
import { registerWorkerTools } from "../extensions/workers/tools.ts";
import { isTerminalWorkerState, type WorkerAdapterId } from "../extensions/workers/types.ts";

const provider = process.argv[2] as WorkerAdapterId;
assert.ok(["pi", "claude", "codex"].includes(provider), "Usage: tsx scripts/worker-lifecycle-smoke.ts pi|claude|codex [model]");
const model = process.argv[3];
const directory = await mkdtemp(join(tmpdir(), "chrysaki-lifecycle-smoke-"));
await chmod(directory, 0o700);
const cwd = join(directory, "source"); await mkdir(cwd);
const nonce = randomUUID();
const hostSecret = join(directory, "host-only.txt");
await writeFile(hostSecret, nonce, { mode: 0o600 });
await writeFile(join(cwd, "guard.txt"), "original\n");
const exec = promisify(execFile);
await exec("git", ["-C", cwd, "init", "-q"]);
await exec("git", ["-C", cwd, "add", "guard.txt"]);
await exec("git", ["-C", cwd, "-c", "user.name=Worker Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
const initialGitConfig = await readFile(join(cwd, ".git", "config"), "utf8");
const loaded = await loadWorkerConfig();
const config = validateWorkerConfig({ ...loaded, retentionMs: 600_000, ...(model ? { adapters: { ...loaded.adapters, [provider]: { ...loaded.adapters[provider], model } } } : {}) });
let runtime = await createChrysakiWorkerRuntime({ agentDirectory: directory, config });
const tools = new Map<string, any>();
registerWorkerTools({ registerTool(tool: any) { tools.set(tool.name, tool); } }, () => runtime.broker);
const parentModel = process.env.PI_PROVIDER && process.env.PI_MODEL ? { provider: process.env.PI_PROVIDER, id: process.env.PI_MODEL } : undefined;
const ctx = { cwd, model: parentModel, sessionManager: { getSessionId: () => `lifecycle-${nonce}` } };
const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("Lifecycle smoke deadline")), 300_000);
const reports: Array<{ name: string; [key: string]: unknown }> = [];
const input = { preferredCli: provider, allowFallback: false, timeoutMs: 90_000, retentionMs: 600_000, workflow: "live-lifecycle" };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const exists = async (path: string) => access(path).then(() => true, () => false);
let call = 0;
const invoke = (name: string, params: object) => tools.get(name).execute(`lifecycle-${++call}`, params, controller.signal, undefined, ctx);
const record = async (name: string, details: object) => {
  reports.push({ name, ...details });
  await writeFile(join(directory, "report.json"), JSON.stringify({ provider, model, parentModel, nonce, reports }, null, 2), { mode: 0o600 });
  console.log(`PASS ${name}`);
};
const watch = () => runtime.broker.subscribeUpdates((update) => console.log(`${update.jobId} ${update.state}: ${update.progress ?? ""}`));
async function spawn(task: string, extra: object = {}) {
  const result = await invoke("worker_spawn", { ...input, task, access: "read", ...extra });
  const [id] = result.details.summaries.map((entry: any) => entry.id);
  const [entry] = await runtime.broker.status([id]);
  assert.equal(entry.status.state, "running", entry.status.failure?.message);
  return entry;
}
async function marker(entry: Awaited<ReturnType<typeof spawn>>) {
  const deadline = Date.now() + 45_000;
  while (!(await exists(join(entry.job.mailboxPath, "started")))) {
    controller.signal.throwIfAborted();
    const [current] = await runtime.broker.status([entry.job.id]);
    assert.equal(isTerminalWorkerState(current.status.state), false, `Worker ended before reaching its marker: ${current.status.failure?.message}`);
    assert.ok(Date.now() < deadline, "Worker did not run the marker command");
    await sleep(100);
  }
}
async function finish(id: string, expected?: string) {
  await invoke("worker_wait", { jobIds: [id], completion: "all", timeoutMs: 90_000 });
  const [entry] = await runtime.broker.status([id]);
  assert.equal(entry.status.state, "completed", entry.status.failure?.message);
  if (expected) assert.equal(entry.result?.trim(), expected);
  return entry;
}
console.log(`Artifacts: ${directory}`); watch();
try {
  await runtime.start();
  const read = await spawn(`Confinement test. Use bash to attempt to append to /workspace/guard.txt and /workspace/.git/config. Both must fail because the workspace is read-only. Also try reading ${hostSecret}; it must be inaccessible. If all three checks pass, reply exactly READ-ISOLATED-${nonce}. Otherwise report failure. Do not invoke any model CLI.`);
  const readResult = await finish(read.job.id, `READ-ISOLATED-${nonce}`);
  assert.equal(await readFile(join(cwd, "guard.txt"), "utf8"), "original\n");
  assert.equal(await readFile(join(cwd, ".git", "config"), "utf8"), initialGitConfig);
  await record("read-and-host-isolation", { job: readResult });

  const write = await invoke("worker_run", { ...input, access: "write", concurrency: 2, tasks: ["A", "B"].map((part) => `Write exactly '${nonce}-${part}' to /workspace/output.txt using a file or bash tool. Do not commit or modify any other repository file. Reply exactly WROTE-${part}. Do not invoke a model CLI.`) });
  const writes = await runtime.broker.status(write.details.summaries.map((entry: any) => entry.id));
  assert.equal(new Set(writes.map((entry) => entry.job.workspace!.workspacePath)).size, 2);
  assert.equal(await exists(join(cwd, "output.txt")), false);
  for (const entry of writes) {
    assert.equal(entry.status.state, "completed", entry.status.failure?.message);
    assert.equal((await readFile(join(entry.job.workspace!.workspacePath, "output.txt"), "utf8")).trim(), `${nonce}-${["A", "B"][entry.job.childIndex!]}`);
  }
  const retained = await runtime.broker.cleanup(writes.map((entry) => entry.job.id));
  assert.ok(retained.every((entry) => entry.retained && entry.dirty && entry.processTerminated));
  await record("parallel-write-isolation-and-dirty-retention", { jobs: writes, cleanup: retained });

  const follow = await spawn(`First run this bash command exactly: touch /mailbox/started; sleep 10. After it returns, reply exactly ORIGINAL-${nonce}. Do not invoke a model CLI.`);
  await marker(follow);
  await invoke("worker_send", { jobId: follow.job.id, prompt: `Updated task: your final answer must be exactly FOLLOWUP-${nonce}, replacing the earlier requested answer. Keep any required mailbox completion contract.` });
  const followed = await finish(follow.job.id, `FOLLOWUP-${nonce}`);
  await record("active-followup", { job: followed });
  await assert.rejects(() => invoke("worker_send", { jobId: follow.job.id, prompt: "Must not resurrect a terminal job" }), /terminal|completed/);

  const cancelled = await spawn(`Run this bash command exactly: touch /mailbox/started; sleep 6; printf unexpected > /mailbox/should-not-exist. Then reply CANCEL-TEST-${nonce}. Do not invoke a model CLI.`);
  await marker(cancelled);
  await invoke("worker_cancel", { jobIds: [cancelled.job.id], reason: "Live cancellation verification" });
  await sleep(7_000);
  const [cancelResult] = await runtime.broker.status([cancelled.job.id]);
  assert.equal(cancelResult.status.state, "cancelled");
  assert.equal(await exists(join(cancelled.job.mailboxPath, "should-not-exist")), false, "Cancelled worker continued its command");
  await record("cancellation-stops-running-command", { job: cancelResult });

  const recovering = await spawn(`Run this bash command exactly: touch /mailbox/started; sleep 8. Then reply exactly RECOVERED-${nonce}. Do not invoke a model CLI.`);
  await marker(recovering);
  const reveal = await runtime.broker.reveal(recovering.job.id, "");
  assert.equal(reveal.mode, "attach-command");
  runtime.dispose();
  runtime = await createChrysakiWorkerRuntime({ agentDirectory: directory, config }); watch();
  await runtime.start();
  const recovered = await finish(recovering.job.id, `RECOVERED-${nonce}`);
  await record("runtime-replacement-and-safe-reveal", { job: recovered, reveal });

  await invoke("worker_run", { ...input, task: "Run bash sleep 60, then reply done. Do not invoke a model CLI.", access: "read", timeoutMs: 5_000 });
  const timeout = (await runtime.broker.status()).find((entry) => entry.job.request.task.startsWith("Run bash sleep 60"))!;
  assert.equal(timeout.status.state, "timed_out");
  await record("real-task-timeout", { job: timeout });
  console.log(`PASS: ${provider} lifecycle verified through real worker tools.`);
} finally {
  clearTimeout(timer);
  try {
    const jobs = await runtime.broker.status();
    await runtime.broker.cancel(jobs.filter((entry) => !isTerminalWorkerState(entry.status.state)).map((entry) => entry.job.id), "Lifecycle smoke cleanup");
    const firstCleanup = await runtime.broker.cleanup(jobs.map((entry) => entry.job.id));
    // Remove only the synthetic output fixture after recording dirty retention.
    // Unknown changes remain retained; never force-clean a user's checkout.
    for (const entry of jobs.filter((entry) => entry.job.workspace?.kind === "git-worktree")) {
      assert.equal(entry.job.workspace!.sourcePath, cwd);
      assert.ok(entry.job.workspace!.workspacePath.startsWith(`${directory}/workers/workspaces/`));
      await unlink(join(entry.job.workspace!.workspacePath, "output.txt")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    const cleanup = [...firstCleanup.filter((entry) => entry.cleaned), ...await runtime.broker.cleanup()];
    await writeFile(join(directory, "cleanup.json"), JSON.stringify(cleanup, null, 2), { mode: 0o600 });
    assert.ok(cleanup.every((entry) => entry.cleaned && entry.processTerminated));
    assert.equal((await exec("git", ["-C", cwd, "status", "--porcelain"])).stdout, "");
    console.log("Verified cleanup and unchanged source fixture.");
  } finally { runtime.dispose(); }
}
