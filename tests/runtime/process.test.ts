import assert from "node:assert/strict";
import test from "node:test";
import { BoundedProcessRunner } from "../../extensions/runtime/process.ts";

test("bounded process runner caps output", async () => {
  const runner = new BoundedProcessRunner();
  const result = await runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBytes: 100, timeoutMs: 2_000 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 100);
  runner.dispose();
});

test("bounded process runner terminates timed-out process groups", async () => {
  const runner = new BoundedProcessRunner();
  const result = await runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 });
  assert.equal(result.killed, true);
  assert.equal(runner.activeCount, 0);
  runner.dispose(); runner.dispose();
});
