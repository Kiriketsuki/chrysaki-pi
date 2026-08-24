#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";

const path = process.env.FAKE_TMUX_STATE;
if (!path) { console.error("FAKE_TMUX_STATE is required"); process.exit(2); }
let state;
try { state = JSON.parse(await readFile(path, "utf8")); }
catch { state = { sessions: {}, buffers: {}, calls: [], nextPane: 1 }; }
const args = process.argv.slice(2); const command = args[0];
let input = "";
for await (const chunk of process.stdin) input += chunk;
state.calls.push({ args, input });
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const sessionFromTarget = (target = "") => target.replace(/^=/, "").split(":")[0];
const fail = state.failCommand === command;
let code = fail ? 9 : 0; let stdout = ""; let stderr = fail ? `forced ${command} failure` : "";

if (!fail && command === "new-session") {
  const name = valueAfter("-s"); const marker = args.indexOf("--");
  if (state.sessions[name]) { code = 1; stderr = "duplicate session"; }
  else state.sessions[name] = { cwd: valueAfter("-c"), argv: args.slice(marker + 1), options: {}, pastes: [], screen: "fake worker screen\n" };
} else if (!fail && command === "set-option") {
  const session = state.sessions[sessionFromTarget(valueAfter("-t"))];
  if (!session) { code = 1; stderr = "can't find session"; }
  else session.options[args.at(-2)] = args.at(-1);
} else if (!fail && command === "load-buffer") {
  state.buffers[valueAfter("-b")] = input;
} else if (!fail && command === "paste-buffer") {
  const name = valueAfter("-b"); const session = state.sessions[sessionFromTarget(valueAfter("-t"))];
  if (!session || !(name in state.buffers)) { code = 1; stderr = "missing session or buffer"; }
  else { session.pastes.push(state.buffers[name]); if (args.includes("-d")) delete state.buffers[name]; }
} else if (!fail && command === "delete-buffer") {
  delete state.buffers[valueAfter("-b")];
} else if (!fail && command === "capture-pane") {
  const session = state.sessions[sessionFromTarget(valueAfter("-t"))];
  if (!session) { code = 1; stderr = "can't find session"; } else stdout = session.screen;
} else if (!fail && command === "send-keys") {
  const session = state.sessions[sessionFromTarget(valueAfter("-t"))];
  if (!session) { code = 1; stderr = "can't find session"; } else session.interrupted = args.at(-1) === "C-c";
} else if (!fail && command === "has-session") {
  if (!state.sessions[sessionFromTarget(valueAfter("-t"))]) { code = 1; stderr = "can't find session"; }
} else if (!fail && command === "kill-session") {
  const name = sessionFromTarget(valueAfter("-t"));
  if (!state.sessions[name]) { code = 1; stderr = "can't find session"; } else delete state.sessions[name];
} else if (!fail && command === "split-window") {
  stdout = `%${state.nextPane++}\n`;
} else if (!fail) { code = 2; stderr = `unsupported fake tmux command: ${command}`; }

const temporary = `${path}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(state, null, 2)); await rename(temporary, path);
if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(`${stderr}\n`); process.exit(code);
