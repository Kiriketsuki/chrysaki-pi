import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeWorkerAdapter } from "../../extensions/workers/adapters/claude.ts";
import { CodexWorkerAdapter } from "../../extensions/workers/adapters/codex.ts";
import { PiWorkerAdapter, piMailboxExtensionPath } from "../../extensions/workers/adapters/pi.ts";
import { findHeadlessModelArgv } from "../../extensions/workers/enforcement.ts";
import { validateWorkerRequest } from "../../extensions/workers/jobs.ts";
import { createWorkerId, WORKER_SCHEMA_VERSION, type AdapterLaunchContext, type WorkerAdapter, type WorkerJob } from "../../extensions/workers/types.ts";

const screens = new URL("./fixtures/screens/", import.meta.url);
async function screen(provider: string, state: string): Promise<string> { return readFile(new URL(`${provider}-${state}.txt`, screens), "utf8"); }

function launchContext(adapter: "pi" | "claude" | "codex", interactiveArgs: readonly string[] = []): AdapterLaunchContext {
  const id = createWorkerId(); const request = validateWorkerRequest({ task: "Implement safely", access: "write", cwd: "/repo" });
  const job: WorkerJob = { schemaVersion: WORKER_SCHEMA_VERSION, id, request, state: "starting", createdAt: "2026-03-19T10:00:00.000Z", updatedAt: "2026-03-19T10:00:00.000Z", selectedAdapter: adapter, mailboxPath: `/jobs/${id}`, ownerId: "owner" };
  return { confinementActive: true, executablePath: adapter, job, workspacePath: "/workspace", mailboxPath: "/mailbox", homePath: "/home/worker", model: "test-model", interactiveArgs };
}

async function authHome(provider: "pi" | "claude" | "codex") {
  const home = await mkdtemp(join(tmpdir(), `chrysaki-${provider}-auth-`));
  const path = provider === "pi" ? join(home, ".pi", "agent", "auth.json") : provider === "claude" ? join(home, ".claude", ".credentials.json") : join(home, ".codex", "auth.json");
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify({ token: "test-token" }), { mode: 0o600 }); return { home, path };
}

for (const provider of ["pi", "claude", "codex"] as const) test(`${provider} probe requires explicit authentication and exposes only its credential binding`, async () => {
  const Constructor = provider === "pi" ? PiWorkerAdapter : provider === "claude" ? ClaudeWorkerAdapter : CodexWorkerAdapter;
  const missing = new Constructor({ homeDirectory: await mkdtemp(join(tmpdir(), "chrysaki-empty-home-")), environment: {} });
  assert.equal((await missing.probe(validateWorkerRequest({ task: "x", access: "read", cwd: "/repo" }))).authenticated, false);
  const auth = await authHome(provider); const adapter = new Constructor({ homeDirectory: auth.home, environment: {} });
  const probe = await adapter.probe(validateWorkerRequest({ task: "x", access: "read", cwd: "/repo" }));
  assert.equal(probe.authenticated, true); assert.equal(probe.sandboxSupported, true); assert.ok(probe.capabilities.includes("code"));
  assert.equal(adapter.authBindings()[0].hostPath, auth.path); assert.match(adapter.authBindings()[0].guestPath, /^\/home\/worker\//);
});

test("provider API keys can be passed narrowly into the sandbox", async () => {
  const pi = new PiWorkerAdapter({ environment: { ANTHROPIC_API_KEY: " pi-secret ", UNRELATED: "no" }, homeDirectory: "/missing" });
  const claude = new ClaudeWorkerAdapter({ environment: { CLAUDE_CODE_OAUTH_TOKEN: "claude-secret" }, homeDirectory: "/missing" });
  const codex = new CodexWorkerAdapter({ environment: { OPENAI_API_KEY: "codex-secret" }, homeDirectory: "/missing" });
  assert.deepEqual(pi.sandboxEnvironment(), { ANTHROPIC_API_KEY: "pi-secret" });
  assert.deepEqual(claude.sandboxEnvironment(), { CLAUDE_CODE_OAUTH_TOKEN: "claude-secret" });
  assert.deepEqual(codex.sandboxEnvironment(), { OPENAI_API_KEY: "codex-secret" });
  assert.equal((await pi.probe(validateWorkerRequest({ task: "x", access: "read", cwd: "/repo" }))).authenticated, true);
});

test("interactive argv is provider-specific, prompt-free, confined, and independently enforced", () => {
  const adapters = [new PiWorkerAdapter(), new ClaudeWorkerAdapter(), new CodexWorkerAdapter()];
  for (const adapter of adapters) {
    const argv = adapter.buildInteractiveArgv(launchContext(adapter.id));
    assert.equal(argv.some((argument) => argument.includes("Implement safely")), false);
    assert.equal(findHeadlessModelArgv(argv), undefined);
    assert.ok(argv.includes("test-model"));
    assert.throws(() => adapter.buildInteractiveArgv({ ...launchContext(adapter.id), confinementActive: false as true }), /confinement|auto-(?:trust|approval)/i);
  }
  assert.ok(new PiWorkerAdapter().buildInteractiveArgv(launchContext("pi")).includes(piMailboxExtensionPath));
  assert.ok(new ClaudeWorkerAdapter().buildInteractiveArgv(launchContext("claude")).includes("--dangerously-skip-permissions"));
  assert.deepEqual(new CodexWorkerAdapter().buildInteractiveArgv(launchContext("codex")).slice(1, 5), ["--sandbox", "workspace-write", "--ask-for-approval", "never"]);
  assert.throws(() => new ClaudeWorkerAdapter().buildInteractiveArgv(launchContext("claude", ["--print"])), /worker_run/);
  assert.throws(() => new CodexWorkerAdapter().buildInteractiveArgv(launchContext("codex", ["exec"])), /worker_run/);
});

test("external adapters append the authoritative mailbox contract while Pi uses its completion extension", () => {
  const context = { jobId: createWorkerId(), task: "Do the task", mailboxPath: "/mailbox" };
  assert.equal(new PiWorkerAdapter().buildPrompt(context), "Do the task");
  for (const adapter of [new ClaudeWorkerAdapter(), new CodexWorkerAdapter()]) {
    const prompt = adapter.buildPrompt(context); assert.match(prompt, /MANDATORY WORKER COMPLETION CONTRACT/); assert.match(prompt, /result\.tmp/); assert.match(prompt, /status\.tmp/); assert.match(prompt, /atomically rename/); assert.match(prompt, new RegExp(context.jobId));
  }
});

for (const provider of ["pi", "claude", "codex"] as const) test(`${provider} fixture recognition covers startup, ready, running, blocked, and fatal states`, async () => {
  const adapter: WorkerAdapter = provider === "pi" ? new PiWorkerAdapter() : provider === "claude" ? new ClaudeWorkerAdapter() : new CodexWorkerAdapter();
  assert.equal(adapter.recognizeScreen(await screen(provider, "starting")).state, "starting");
  assert.equal(adapter.recognizeScreen(`\u001b[32m${await screen(provider, "ready")}\u001b[0m`).state, "ready");
  assert.equal(adapter.recognizeScreen(await screen(provider, "running")).state, "running");
  const blocked = adapter.recognizeScreen(await screen(provider, "blocked")); assert.equal(blocked.state, "blocked"); assert.ok(blocked.promptId);
  assert.equal(adapter.answerPrompt(blocked, { confinementActive: false }), undefined); assert.equal(adapter.answerPrompt(blocked, { confinementActive: true }), "y");
  const fatal = adapter.recognizeScreen(await screen(provider, "fatal")); assert.equal(fatal.state, "blocked"); assert.equal(fatal.promptId, undefined); assert.equal(adapter.answerPrompt(fatal, { confinementActive: true }), undefined);
  const unknown = adapter.recognizeScreen("Continue with unknown action? [y/n]"); assert.equal(unknown.state, "blocked"); assert.equal(unknown.promptId, undefined); assert.equal(adapter.answerPrompt(unknown, { confinementActive: true }), undefined);
});

test("recognized prompt responses are configurable and interrupts delegate to tmux transport", async () => {
  const calls: string[] = []; const adapter = new ClaudeWorkerAdapter({ recognizedResponses: { "workspace-trust": "custom-response" }, interrupt: async (session) => { calls.push(session); } });
  const blocked = adapter.recognizeScreen(await screen("claude", "blocked")); assert.equal(adapter.answerPrompt(blocked, { confinementActive: true }), "custom-response");
  await adapter.interrupt({ jobId: createWorkerId(), tmuxSession: `chrysaki-${createWorkerId()}` }); assert.equal(calls.length, 1);
  await assert.rejects(() => new ClaudeWorkerAdapter().interrupt({ jobId: createWorkerId(), tmuxSession: `chrysaki-${createWorkerId()}` }), /not configured/);
});
