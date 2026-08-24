import assert from "node:assert/strict";
import test from "node:test";
import { registerWorkerTools } from "../../extensions/workers/tools.ts";
import { WORKER_SCHEMA_VERSION, type WorkerJob, type WorkerStatusFile } from "../../extensions/workers/types.ts";

const id = "wrk_12345678-1234-4123-8123-123456789abc";
const createdAt = "2025-01-01T00:00:00.000Z";
function result(text = "authoritative result") {
  const request = { task: "task", capabilities: [], access: "read" as const, allowFallback: true, cwd: "/repo", metadata: {} };
  const job: WorkerJob = { schemaVersion: WORKER_SCHEMA_VERSION, id, request, state: "completed", createdAt, updatedAt: createdAt, completedAt: createdAt, selectedAdapter: "pi", tmuxSession: `chrysaki-${id}`, mailboxPath: `/jobs/${id}`, ownerId: "owner", cleanupDeadline: "2025-01-01T00:15:00.000Z" };
  const status: WorkerStatusFile = { schemaVersion: WORKER_SCHEMA_VERSION, jobId: id, state: "completed", createdAt, updatedAt: createdAt, completedAt: createdAt, resultPath: "result.md" };
  return { job, status, result: text, resultPath: `/jobs/${id}/result.md`, resultTruncated: text.length > 50_000 };
}

function harness(text?: string) {
  const tools = new Map<string, any>(); const calls: any[] = []; const entry = result(text);
  const broker: any = {
    async run(input: any, options: any) { calls.push(["run", input, options]); return { ownerId: "owner", concurrency: input.concurrency ?? 2, jobs: [entry] }; },
    async spawn(input: any, options: any) { calls.push(["spawn", input, options]); return { ownerId: "owner", concurrency: 1, jobs: [entry] }; },
    async wait(input: any) { calls.push(["wait", input]); return [entry]; }, async status() { return [entry]; },
    async send(jobId: string, prompt: string) { calls.push(["send", jobId, prompt]); },
    async reveal() { return { mode: "attach-command", argv: ["tmux"], command: "'tmux' 'attach-session' '-t' 'safe'" }; },
    async cancel(jobIds: string[], reason?: string) { calls.push(["cancel", jobIds, reason]); return [entry]; },
  };
  registerWorkerTools({ registerTool(definition: any) { tools.set(definition.name, definition); } } as any, () => broker);
  return { tools, calls, broker, entry };
}

const theme: any = { fg: (_role: string, value: string) => value, bold: (value: string) => value };

test("registers the complete worker tool contract with StringEnum-compatible schemas", () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()].sort(), ["worker_cancel", "worker_reveal", "worker_run", "worker_send", "worker_spawn", "worker_status", "worker_wait"]);
  const dispatch = tools.get("worker_run").parameters;
  assert.deepEqual(dispatch.properties.access.enum, ["read", "write"]);
  assert.deepEqual(dispatch.properties.preferredCli.enum, ["pi", "claude", "codex"]);
  assert.equal(JSON.stringify(dispatch).includes("anyOf"), false);
});

test("worker_run forwards invocation ownership, cwd, cancellation, and compact persisted details", async () => {
  const { tools, calls } = harness(); const controller = new AbortController(); const updates: any[] = [];
  const output = await tools.get("worker_run").execute("call", { task: "delegate", access: "write", concurrency: 3 }, controller.signal, (update: any) => updates.push(update), { cwd: "/repo" });
  assert.equal(calls[0][0], "run"); assert.equal(calls[0][1].cwd, "/repo"); assert.equal(calls[0][1].concurrency, 3); assert.equal(calls[0][2].signal, controller.signal);
  assert.equal(output.details.summaries[0].id, id); assert.equal(Object.hasOwn(output.details.summaries[0], "result"), false); assert.equal(updates.length, 1);
});

test("model-visible aggregate output remains within Pi byte and line bounds", async () => {
  const huge = Array.from({ length: 3_000 }, () => "x".repeat(100)).join("\n"); const { tools } = harness(huge);
  const output = await tools.get("worker_run").execute("call", { task: "large", access: "read" }, undefined, undefined, { cwd: "/repo" }); const text = output.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 50 * 1024); assert.ok(text.split("\n").length <= 2_000); assert.match(text, /truncated/);
});

test("compact call and result renderers are pure and support expansion", async () => {
  const { tools } = harness(); const tool = tools.get("worker_run");
  const call = tool.renderCall({ tasks: ["a", "b"], access: "read", preferredCli: "pi" }, theme, { lastComponent: undefined });
  assert.match(call.render(120).join("\n"), /Chrysaki Workers.*run ×2 · pi/);
  const output = await tool.execute("call", { task: "render", access: "read" }, undefined, undefined, { cwd: "/repo" });
  const rendered = tool.renderResult(output, { expanded: true, isPartial: false }, theme, { lastComponent: undefined });
  assert.match(rendered.render(160).join("\n"), new RegExp(`${id}.*completed.*pi`));
});

test("worker_wait count and reveal/cancel tools map to broker operations", async () => {
  const { tools, calls } = harness();
  await tools.get("worker_wait").execute("call", { jobIds: [id], count: 1, timeoutMs: 10 }, undefined);
  const reveal = await tools.get("worker_reveal").execute("call", { jobId: id });
  await tools.get("worker_cancel").execute("call", { jobIds: [id], reason: "stop" });
  assert.equal(calls[0][1].completion, 1); assert.match(reveal.content[0].text, /attach-session/); assert.deepEqual(calls.at(-1), ["cancel", [id], "stop"]);
  await assert.rejects(() => tools.get("worker_wait").execute("call", { jobIds: [id], completion: "all", count: 1 }, undefined), /not both/);
});
