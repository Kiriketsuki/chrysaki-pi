import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWorkerId } from "../../extensions/workers/types.ts";
import { TmuxTransport, TmuxTransportError, tmuxSessionName } from "../../extensions/workers/tmux.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-tmux.mjs", import.meta.url));

interface FakeState { sessions: Record<string, any>; buffers: Record<string, string>; calls: Array<{ args: string[]; input: string }>; nextPane: number; failCommand?: string; }

async function harness(initial: Partial<FakeState> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chrysaki-fake-tmux-")); const statePath = join(directory, "state.json");
  const state: FakeState = { sessions: {}, buffers: {}, calls: [], nextPane: 1, ...initial };
  await writeFile(statePath, JSON.stringify(state)); await chmod(fixture, 0o755);
  const transport = new TmuxTransport({ binary: fixture, env: { FAKE_TMUX_STATE: statePath } });
  return { directory, statePath, transport, read: async () => JSON.parse(await readFile(statePath, "utf8")) as FakeState };
}

test("detached launch passes worker command as argv without shell interpolation", async () => {
  const fake = await harness(); const jobId = createWorkerId();
  const session = await fake.transport.launch({ jobId, ownerId: "owner-1", cwd: "/tmp", argv: ["pi", "argument with spaces", "$(touch /tmp/never)", "semi;colon"], environment: { WORKER_MAILBOX: "/tmp/mail box" } });
  assert.equal(session.name, tmuxSessionName(jobId));
  const state = await fake.read(); const worker = state.sessions[session.name];
  assert.deepEqual(worker.argv, ["pi", "argument with spaces", "$(touch /tmp/never)", "semi;colon"]);
  assert.equal(worker.cwd, "/tmp");
  assert.equal(worker.options["@chrysaki-job-id"], jobId);
  assert.equal(worker.options["@chrysaki-owner-id"], "owner-1");
  const launch = state.calls[0].args;
  assert.deepEqual(launch.slice(0, 6), ["new-session", "-d", "-s", session.name, "-c", "/tmp"]);
  assert.ok(launch.includes("WORKER_MAILBOX=/tmp/mail box"));
  fake.transport.dispose();
});

test("ownership proof verifies exact tmux metadata before termination", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  assert.equal(await fake.transport.verifyOwnership(session.name, jobId, "owner"), true);
  assert.equal(await fake.transport.verifyOwnership(session.name, jobId, "other"), false);
  assert.equal(await fake.transport.terminateOwned(session.name, jobId, "other"), false); assert.equal(await fake.transport.hasSession(session.name), true);
  assert.equal(await fake.transport.terminateOwned(session.name, jobId, "owner"), true); assert.equal(await fake.transport.hasSession(session.name), false);
});

test("private buffers deliver exact prompt content and are deleted", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  const prompt = "line one\n'quoted' $HOME; echo nope";
  await fake.transport.paste(session.name, prompt);
  const state = await fake.read();
  assert.deepEqual(state.sessions[session.name].pastes, [`${prompt}\n`]);
  assert.deepEqual(state.buffers, {});
  const load = state.calls.find((call) => call.args[0] === "load-buffer")!;
  const paste = state.calls.find((call) => call.args[0] === "paste-buffer")!;
  assert.equal(load.input, `${prompt}\n`); assert.ok(load.args[2].startsWith("chrysaki-paste-"));
  assert.ok(paste.args.includes("-d"));
  assert.equal(state.calls.some((call) => call.args[0] === "send-keys"), false);
  fake.transport.dispose();
});

test("failed paste cleans the private buffer", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  const state = await fake.read(); state.failCommand = "paste-buffer"; await writeFile(fake.statePath, JSON.stringify(state));
  await assert.rejects(() => fake.transport.paste(session.name, "secret"), TmuxTransportError);
  const after = await fake.read(); assert.deepEqual(after.buffers, {});
  assert.ok(after.calls.some((call) => call.args[0] === "delete-buffer"));
  fake.transport.dispose();
});

test("capture archives diagnostics without treating them as a result", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  const state = await fake.read(); state.sessions[session.name].screen = "visible final-looking text\n"; await writeFile(fake.statePath, JSON.stringify(state));
  assert.equal(await fake.transport.capturePane(session.name, 50), "visible final-looking text\n");
  const log = join(fake.directory, "pane.log"); await fake.transport.archivePane(session.name, log);
  assert.equal(await readFile(log, "utf8"), "visible final-looking text\n");
  assert.equal((await fake.read()).calls.filter((call) => call.args[0] === "capture-pane").length, 2);
  fake.transport.dispose();
});

test("reveal returns a safe attach command outside tmux and creates a split inside tmux", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  const outside = await fake.transport.reveal(session.name, "");
  assert.equal(outside.mode, "attach-command"); assert.deepEqual(outside.argv.slice(1), ["attach-session", "-t", session.name]);
  assert.match(outside.command, /attach-session/);
  const inside = await fake.transport.reveal(session.name, "/tmp/tmux-100/default,1,0");
  assert.equal(inside.mode, "split"); assert.equal(inside.paneId, "%1");
  const call = (await fake.read()).calls.at(-1)!;
  assert.deepEqual(call.args.slice(0, 7), ["split-window", "-h", "-P", "-F", "#{pane_id}", "--", "env"]);
  assert.ok(call.args.includes("-u")); assert.ok(call.args.includes("TMUX"));
  assert.ok(call.args.includes("-S")); assert.ok(call.args.includes("/tmp/tmux-100/default"));
  fake.transport.dispose();
});

test("interrupt, existence checks, and idempotent kill use exact targets", async () => {
  const fake = await harness(); const jobId = createWorkerId(); const session = await fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] });
  assert.equal(await fake.transport.hasSession(session.name), true);
  await fake.transport.interrupt(session.name);
  assert.equal((await fake.read()).sessions[session.name].interrupted, true);
  assert.equal(await fake.transport.kill(session.name), true);
  assert.equal(await fake.transport.hasSession(session.name), false);
  assert.equal(await fake.transport.kill(session.name), false);
  await assert.rejects(() => fake.transport.capturePane("other-session"), TmuxTransportError);
  fake.transport.dispose();
});

test("launch cleanup kills a session when ownership tagging fails", async () => {
  const fake = await harness({ failCommand: "set-option" }); const jobId = createWorkerId();
  await assert.rejects(() => fake.transport.launch({ jobId, ownerId: "owner", cwd: "/tmp", argv: ["pi"] }), /set-option failed/);
  assert.deepEqual((await fake.read()).sessions, {});
  fake.transport.dispose();
});
