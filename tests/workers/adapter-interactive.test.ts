import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeWorkerAdapter } from "../../extensions/workers/adapters/claude.ts";
import { CodexWorkerAdapter } from "../../extensions/workers/adapters/codex.ts";
import { PiWorkerAdapter } from "../../extensions/workers/adapters/pi.ts";
import { initializeMailbox, readAuthoritativeResult, workerMailboxPaths, writeCompletedResult, writeWorkerStatus } from "../../extensions/workers/mailbox.ts";
import { createWorkerId, WORKER_SCHEMA_VERSION, type WorkerAdapter, type WorkerStatusFile } from "../../extensions/workers/types.ts";
import { FakeInteractiveCli } from "./fixtures/fake-interactive-cli.ts";

const fixtureRoot = new URL("./fixtures/screens/", import.meta.url);
async function screens(provider: string) {
  const load = (state: string) => readFile(new URL(`${provider}-${state}.txt`, fixtureRoot), "utf8");
  return { starting: await load("starting"), blocked: await load("blocked"), ready: await load("ready"), running: await load("running") };
}

for (const provider of ["pi", "claude", "codex"] as const) test(`deterministic fake ${provider} CLI exercises confined prompt response, delivery, and interruption`, async () => {
  let cli!: FakeInteractiveCli;
  const adapter: WorkerAdapter = provider === "pi"
    ? new PiWorkerAdapter({ interrupt: async () => cli.interrupt() })
    : provider === "claude" ? new ClaudeWorkerAdapter({ interrupt: async () => cli.interrupt() }) : new CodexWorkerAdapter({ interrupt: async () => cli.interrupt() });
  cli = new FakeInteractiveCli(await screens(provider));
  assert.equal(adapter.recognizeScreen(cli.capture()).state, "starting");
  cli.showPrompt(); const blocked = adapter.recognizeScreen(cli.capture()); assert.equal(blocked.state, "blocked");
  assert.equal(adapter.answerPrompt(blocked, { confinementActive: false }), undefined);
  const response = adapter.answerPrompt(blocked, { confinementActive: true }); assert.equal(response, "y"); cli.submit(response!);
  assert.equal(adapter.recognizeScreen(cli.capture()).state, "ready");
  const prompt = adapter.buildPrompt({ jobId: createWorkerId(), task: "deterministic task", mailboxPath: "/mailbox" }); cli.submit(prompt);
  assert.equal(cli.state, "running"); assert.equal(adapter.recognizeScreen(cli.capture()).state, "running");
  await adapter.interrupt({ jobId: createWorkerId(), tmuxSession: `chrysaki-${createWorkerId()}` }); assert.equal(cli.state, "interrupted");
});

test("fake external interactive CLI completion succeeds only through result.md plus terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-fake-cli-mailbox-")); const jobId = createWorkerId(); const paths = workerMailboxPaths(root, jobId);
  await initializeMailbox(paths, { task: "complete", access: "read", cwd: "/repo" });
  const running: WorkerStatusFile = { schemaVersion: WORKER_SCHEMA_VERSION, jobId, state: "running", createdAt: "2026-03-19T10:00:00.000Z", updatedAt: "2026-03-19T10:01:00.000Z", startedAt: "2026-03-19T10:01:00.000Z" };
  await writeWorkerStatus(paths, running);
  const completedAt = "2026-03-19T10:02:00.000Z";
  await writeCompletedResult(paths, "authoritative fake CLI result", { ...running, state: "completed", updatedAt: completedAt, completedAt, resultPath: "result.md" }, running);
  const result = await readAuthoritativeResult(paths); assert.equal(result.text, "authoritative fake CLI result"); assert.equal(result.truncated, false);
});
