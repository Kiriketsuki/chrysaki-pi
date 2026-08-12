import assert from "node:assert/strict";
import test from "node:test";
import { GitCollector } from "../../extensions/collectors/git.ts";
import { ManualClock } from "../../extensions/runtime/clock.ts";
import type { ProcessRunner, ProcessResult } from "../../extensions/runtime/process.ts";

const ok = (stdout = ""): ProcessResult => ({ stdout, stderr: "", code: 0, killed: false, truncated: false });

test("GitCollector builds a bounded immutable snapshot", async () => {
  const run: ProcessRunner = async (_command, args) => {
    const key = args.join(" ");
    if (key.includes("--show-toplevel")) return ok("/repo\n");
    if (key.includes("--abbrev-ref")) return ok("main\n");
    if (key.includes("--short HEAD")) return ok("abc123\n");
    if (key.includes("--porcelain")) return ok(" M src/a.ts\0?? new.txt\0");
    if (key.includes("--numstat")) return ok("3\t1\tsrc/a.ts\n");
    if (key.includes("log")) return ok("abc123\tHEAD -> main\tFeature\n");
    if (key.includes("rev-list")) return ok("2\t4\n");
    return ok();
  };
  const collector = new GitCollector(run);
  collector.start({ cwd: "/repo" });
  const snapshot = await collector.refresh("test");
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.ahead, 4);
  assert.deepEqual(snapshot.files[0], { path: "src/a.ts", indexStatus: " ", worktreeStatus: "M", added: 3, deleted: 1 });
  assert.equal(Object.isFrozen(snapshot), true);
  collector.dispose(); collector.dispose();
});

test("GitCollector backs off failures and preserves the last snapshot", async () => {
  const clock = new ManualClock(); let calls = 0;
  const run: ProcessRunner = async () => { calls++; throw new Error("git absent"); };
  const collector = new GitCollector(run, clock); collector.start({ cwd: "/tmp" });
  const first = await collector.refresh("one"); const second = await collector.refresh("two");
  assert.equal(first.available, false); assert.equal(second, first); assert.equal(calls, 1);
  clock.advance(1_000); await collector.refresh("three"); assert.equal(calls, 2);
});
