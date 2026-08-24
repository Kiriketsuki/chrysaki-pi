import assert from "node:assert/strict";
import test from "node:test";
import chrysakiPi from "../../extensions/index.ts";

const theme: any = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

test("extension registers resources and survives a complete lifecycle", async () => {
  const events = new Map<string, Function[]>(); const commands: string[] = []; const shortcuts: string[] = []; const tools: string[] = []; let workerStarts = 0; let workerDisposals = 0;
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand(name: string) { commands.push(name); }, registerShortcut(name: string) { shortcuts.push(name); }, registerTool(tool: any) { tools.push(tool.name); },
    setThinkingLevel() {}, getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }], setActiveTools() {},
  };
  const workerRuntime: any = { broker: { status: async () => [] }, start: async () => { workerStarts++; return { recovered: 0, active: 0, terminal: 0, invalid: [], cleanup: [] }; }, dispose: () => { workerDisposals++; } };
  await chrysakiPi(pi, { createWorkerRuntime: async () => workerRuntime });
  assert.ok(commands.includes("chrysaki-deck")); assert.ok(commands.includes("chrysaki-git")); assert.ok(commands.includes("workers")); assert.ok(commands.includes("worker"));
  assert.deepEqual(tools.sort(), ["worker_cancel", "worker_reveal", "worker_run", "worker_send", "worker_spawn", "worker_status", "worker_wait"]);
  assert.ok(shortcuts.includes("ctrl+shift+p")); assert.ok(shortcuts.includes("ctrl+shift+k"));
  assert.ok(shortcuts.includes("ctrl+shift+h"));
  const toolCall = events.get("tool_call")?.[0]; assert.ok(toolCall);
  const blocked = await toolCall!({ type: "tool_call", toolCallId: "headless", toolName: "bash", input: { command: "claude --print task" } }, {});
  assert.equal(blocked?.block, true); assert.match(blocked?.reason ?? "", /worker_run/);
  assert.equal(await toolCall!({ type: "tool_call", toolCallId: "interactive", toolName: "bash", input: { command: "claude" } }, {}), undefined);
  let footer: any; let header: any; let editorFactory: any; let workingReset = false;
  const tui: any = { terminal: { rows: 40, columns: 140 }, requestRender() {} };
  const handle: any = { setHidden() {}, hide() {}, unfocus() {}, focus() {}, isFocused: () => false, isHidden: () => false };
  const ui: any = {
    theme,
    setHeader(factory: any) { header = factory ? factory(tui, theme) : undefined; },
    setFooter(factory: any) { footer = factory ? factory(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} }) : undefined; },
    setEditorComponent(factory: any) { editorFactory = factory; },
    setWorkingIndicator(value?: any) { if (value === undefined) workingReset = true; },
    custom(factory: any, options: any) { let finish!: () => void; const promise = new Promise<void>((resolve) => { finish = resolve; }); factory(tui, theme, {}, finish); options?.onHandle?.(handle); return promise; },
    notify() {},
  };
  const ctx: any = { mode: "tui", cwd: process.cwd(), ui, model: { id: "test", provider: "test", contextWindow: 1000 }, thinkingLevel: "medium", sessionManager: { getSessionId: () => "session", getBranch: () => [] }, getContextUsage: () => ({ tokens: 100 }) };
  for (const handler of events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  for (const handler of events.get("resources_discover") ?? []) await handler({ reason: "startup", cwd: ctx.cwd }, ctx);
  assert.ok(footer); assert.ok(header); assert.equal(typeof editorFactory, "function");
  assert.ok(footer.render(80).every((line: string) => line.length <= 80)); assert.ok(header.render(80).length > 0);
  for (const handler of events.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
  assert.equal(footer, undefined); assert.equal(header, undefined); assert.equal(editorFactory, undefined); assert.equal(workingReset, true);
  assert.equal(workerStarts, 1); assert.equal(workerDisposals, 1);
});
