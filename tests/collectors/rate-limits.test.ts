import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitCollector } from "../../extensions/collectors/rate-limits.ts";
import { ManualClock } from "../../extensions/runtime/clock.ts";
import type { ProcessRunner } from "../../extensions/runtime/process.ts";

test("rate-limit telemetry is optional, cached, and provider-scoped", async () => {
  const clock = new ManualClock(); let calls = 0;
  const run: ProcessRunner = async () => { calls++; return { stdout: JSON.stringify({ fiveHour: { usedPercent: 25 }, sevenDay: { usedPercent: 40 } }), stderr: "", code: 0, killed: false, truncated: false }; };
  const collector = new RateLimitCollector(run, clock);
  assert.equal((await collector.refresh("anthropic")).available, false);
  const snapshot = await collector.refresh("openai-codex");
  assert.equal(snapshot.fiveHour?.usedPercent, 25); assert.equal(calls, 1);
  await collector.refresh("openai-codex"); assert.equal(calls, 1);
  clock.advance(5 * 60_000); await collector.refresh("openai-codex"); assert.equal(calls, 2);
  collector.dispose(); collector.dispose();
});

test("rate-limit failures preserve the last successful snapshot", async () => {
  const clock = new ManualClock(); let fail = false;
  const run: ProcessRunner = async () => fail
    ? { stdout: "", stderr: "offline", code: 1, killed: false, truncated: false }
    : { stdout: '{"fiveHour":{"usedPercent":10}}', stderr: "", code: 0, killed: false, truncated: false };
  const collector = new RateLimitCollector(run, clock);
  const good = await collector.refresh("openai-codex"); fail = true; clock.advance(5 * 60_000);
  assert.equal(await collector.refresh("openai-codex"), good);
});
