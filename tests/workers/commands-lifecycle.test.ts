import assert from "node:assert/strict";
import test from "node:test";
import chrysakiPi from "../../extensions/index.ts";
import { WORKER_SCHEMA_VERSION } from "../../extensions/workers/types.ts";

const id = "wrk_12345678-1234-4123-8123-123456789abc";
const timestamp = "2025-01-01T00:00:00.000Z";
const entry: any = {
  job: { schemaVersion: WORKER_SCHEMA_VERSION, id, request: { task: "task", capabilities: [], access: "read", allowFallback: true, cwd: process.cwd(), metadata: {} }, state: "running", createdAt: timestamp, updatedAt: timestamp, selectedAdapter: "pi", tmuxSession: `chrysaki-${id}`, mailboxPath: `/jobs/${id}`, ownerId: "owner" },
  status: { schemaVersion: WORKER_SCHEMA_VERSION, jobId: id, state: "running", createdAt: timestamp, updatedAt: timestamp, progress: "Task delivered" },
};

test("worker commands own one recoverable runtime and shutdown idempotently", async () => {
  const events = new Map<string, Function[]>(); const commands = new Map<string, any>(); const notifications: string[] = []; const actions: string[] = []; let starts = 0; let disposals = 0;
  const broker: any = {
    async doctor() { actions.push("doctor"); return { ok: true, tmux: { available: true, version: "tmux test" }, sandbox: { usable: true, version: "bwrap test" }, admission: { active: 1 } }; },
    async status(ids?: string[]) { actions.push(`status:${ids?.join(",") ?? "all"}`); return [entry]; },
    async reveal() { actions.push("reveal"); return { mode: "attach-command", command: "'tmux' 'attach-session' '-t' 'safe'", argv: [] }; },
    async cancel() { actions.push("cancel"); return [{ ...entry, status: { ...entry.status, state: "cancelled" } }]; },
    async cleanup(ids?: string[]) { actions.push(`cleanup:${ids?.join(",") ?? "all"}`); return [{ jobId: id, cleaned: false, retained: true, dirty: true, reason: "dirty worktree" }]; },
  };
  const runtime: any = { broker, async start() { starts++; return { recovered: 1, active: 1, terminal: 0, invalid: [], cleanup: [] }; }, dispose() { disposals++; } };
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); }, registerCommand(name: string, definition: any) { commands.set(name, definition); }, registerTool() {}, registerShortcut() {},
    setThinkingLevel() {}, getAllTools: () => [], setActiveTools() {},
  };
  await chrysakiPi(pi, { createWorkerRuntime: async () => runtime });
  const ui: any = { theme: { fg: (_role: string, text: string) => text }, notify(message: string) { notifications.push(message); }, setFooter() {}, setHeader() {}, setEditorComponent() {}, setWorkingIndicator() {} };
  const ctx: any = { mode: "json", cwd: process.cwd(), ui, model: { provider: "test", id: "test", contextWindow: 1_000 }, thinkingLevel: "medium", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => [] }, getContextUsage: () => ({ tokens: 0 }) };
  for (const handler of events.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
  await commands.get("workers").handler("", ctx);
  await commands.get("worker").handler("doctor", ctx);
  await commands.get("worker").handler(`status ${id}`, ctx);
  await commands.get("worker").handler(`reveal ${id}`, ctx);
  await commands.get("worker").handler(`cancel ${id} requested`, ctx);
  await commands.get("worker").handler(`cleanup ${id}`, ctx);
  assert.equal(starts, 1); assert.deepEqual(actions, ["status:all", "doctor", `status:${id}`, "reveal", "cancel", `cleanup:${id}`]);
  assert.ok(notifications.some((message) => message.includes("dirty worktree"))); assert.ok(notifications.some((message) => message.includes("attach-session")));
  for (const handler of events.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
  for (const handler of events.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
  assert.equal(disposals, 1);
});
