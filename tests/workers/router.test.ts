import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkerPolicy, validateWorkerConfig } from "../../extensions/workers/config.ts";
import { validateWorkerRequest } from "../../extensions/workers/jobs.ts";
import { bindAdapterSelection, WorkerRouter, WorkerRoutingError } from "../../extensions/workers/router.ts";
import { createWorkerId, WORKER_SCHEMA_VERSION, type AdapterProbeResult, type WorkerAdapter, type WorkerAdapterId, type WorkerJob } from "../../extensions/workers/types.ts";

async function executable(directory: string, name: string) { const path = join(directory, name); await writeFile(path, "#!/bin/sh\nexit 0\n"); await chmod(path, 0o755); return path; }

function adapter(id: WorkerAdapterId, executablePath: string, result: Partial<AdapterProbeResult> = {}, onProbe?: () => void): WorkerAdapter {
  return {
    id, executable: executablePath,
    async probe() { onProbe?.(); return { available: true, authenticated: true, sandboxSupported: true, capabilities: ["code"], ...result }; },
    buildInteractiveArgv() { return [executablePath]; }, buildPrompt(context) { return context.task; }, recognizeScreen() { return { state: "ready" }; }, answerPrompt() { return undefined; }, async interrupt() {},
  };
}

const confinement = (usable = true) => ({ async preflight() { return { available: usable, usable, version: usable ? "test" : undefined, reason: usable ? undefined : "disabled" }; } });
const request = (extra: Record<string, unknown> = {}) => validateWorkerRequest({ task: "work", access: "read", cwd: "/repo", capabilities: ["code"], ...extra });

async function fixture() {
  const bin = await mkdtemp(join(tmpdir(), "chrysaki-router-bin-"));
  return { bin, pi: await executable(bin, "pi"), claude: await executable(bin, "claude"), codex: await executable(bin, "codex") };
}

test("router falls back only during pre-start probing and records deterministic attempts", async () => {
  const files = await fixture(); const config = validateWorkerConfig({ routingOrder: ["pi", "claude", "codex"] });
  const router = new WorkerRouter({ config, sandbox: confinement(), adapters: [
    adapter("pi", files.pi, { available: false, reason: "startup probe failed" }),
    adapter("claude", files.claude), adapter("codex", files.codex),
  ] });
  const selection = await router.route(request(), resolveWorkerPolicy(config));
  assert.equal(selection.adapterId, "claude"); assert.equal(selection.executablePath, files.claude);
  assert.deepEqual(selection.attempts.map(({ adapterId, eligible }) => [adapterId, eligible]), [["pi", false], ["claude", true]]);
  assert.equal(Object.isFrozen(selection), true); assert.equal(Object.isFrozen(selection.attempts), true);
});

test("fallback can be disabled by either invocation policy or request", async () => {
  const files = await fixture(); const config = validateWorkerConfig({ routingOrder: ["pi", "claude"] });
  const router = new WorkerRouter({ config, sandbox: confinement(), adapters: [adapter("pi", files.pi, { authenticated: false, reason: "login required" }), adapter("claude", files.claude)] });
  await assert.rejects(() => router.route(request({ allowFallback: false }), resolveWorkerPolicy(config)), (error: any) => error instanceof WorkerRoutingError && error.attempts.length === 1 && /login required/.test(error.message));
  await assert.rejects(() => router.route(request(), resolveWorkerPolicy(config, undefined, { allowFallback: false })), (error: any) => error.attempts.length === 1);
});

test("routing checks executable, authentication, sandbox support, and capabilities", async () => {
  const files = await fixture(); const config = validateWorkerConfig({ routingOrder: ["pi", "claude", "codex"] });
  const router = new WorkerRouter({ config, sandbox: confinement(), adapters: [
    adapter("pi", join(files.bin, "missing")), adapter("claude", files.claude, { sandboxSupported: false }), adapter("codex", files.codex, { capabilities: ["review"] }),
  ] });
  await assert.rejects(() => router.route(request(), resolveWorkerPolicy(config)), (error: any) => {
    assert.match(error.message, /executable not found/); assert.match(error.message, /sandbox/); assert.match(error.message, /missing capabilities/); return true;
  });
});

test("routing fails closed before provider probes when confinement is unavailable", async () => {
  const files = await fixture(); const config = validateWorkerConfig({}); let probes = 0;
  const router = new WorkerRouter({ config, sandbox: confinement(false), adapters: [adapter("pi", files.pi, {}, () => probes++)] });
  await assert.rejects(() => router.route(request(), resolveWorkerPolicy(config)), /confinement unavailable/);
  assert.equal(probes, 0);
});

test("adapter selection binds once before running and cannot fall back afterwards", async () => {
  const files = await fixture(); const config = validateWorkerConfig({ routingOrder: ["pi", "claude"] }); const workerRequest = request(); const id = createWorkerId();
  const job: WorkerJob = { schemaVersion: WORKER_SCHEMA_VERSION, id, request: workerRequest, state: "starting", createdAt: "2026-03-19T10:00:00.000Z", updatedAt: "2026-03-19T10:00:00.000Z", mailboxPath: `/jobs/${id}`, ownerId: "owner" };
  const router = new WorkerRouter({ config, sandbox: confinement(), adapters: [adapter("pi", files.pi), adapter("claude", files.claude)] });
  const routed = await router.routeForJob(job, resolveWorkerPolicy(config)); assert.equal(routed.job.selectedAdapter, "pi");
  assert.throws(() => bindAdapterSelection(routed.job, "claude"), /immutable/);
  await assert.rejects(() => router.routeForJob(routed.job, resolveWorkerPolicy(config)), /already selected/);
  assert.throws(() => bindAdapterSelection({ ...job, state: "running" }, "pi"), /before running/);
});

test("aborted routing stops before selection", async () => {
  const files = await fixture(); const config = validateWorkerConfig({}); const controller = new AbortController(); controller.abort();
  const router = new WorkerRouter({ config, sandbox: confinement(), adapters: [adapter("pi", files.pi)] });
  await assert.rejects(() => router.route(request(), resolveWorkerPolicy(config), controller.signal), { name: "AbortError" });
});
