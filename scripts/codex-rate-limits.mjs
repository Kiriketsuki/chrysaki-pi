#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
const lines = createInterface({ input: child.stdout });
let finished = false;
const timeout = setTimeout(() => finish(undefined, 1), 12_000);

function finish(value, code = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (value) process.stdout.write(JSON.stringify(value));
  child.kill("SIGKILL");
  process.exitCode = code;
}
function request(id, method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
lines.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) { request(2, "account/rateLimits/read", null); return; }
  if (message.id !== 2) return;
  if (message.error || !message.result) { finish(undefined, 1); return; }
  const limits = message.result.rateLimitsByLimitId?.codex ?? message.result.rateLimits;
  const result = {};
  for (const window of [limits?.primary, limits?.secondary].filter(Boolean)) {
    const minutes = window.windowDurationMins ?? 0;
    const key = minutes >= 10_000 ? "sevenDay" : minutes >= 250 && minutes <= 350 ? "fiveHour" : undefined;
    if (key) result[key] = { usedPercent: window.usedPercent ?? 0, resetsAt: window.resetsAt };
  }
  finish(result);
});
child.on("error", () => finish(undefined, 1));
child.on("exit", (code) => { if (!finished && code !== 0) finish(undefined, 1); });
request(1, "initialize", { clientInfo: { name: "chrysaki-pi", version: "1.2.0" }, capabilities: null });
