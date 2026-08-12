import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../../extensions/runtime/clock.ts";
import { DisposalRegistry } from "../../extensions/runtime/disposal.ts";
import { RefreshScheduler } from "../../extensions/runtime/scheduler.ts";
import { StateStore } from "../../extensions/runtime/store.ts";

test("StateStore publishes only selector changes", () => {
  const store = new StateStore({ count: 0, label: "a" });
  const changes: Array<[number, number]> = [];
  const unsubscribe = store.subscribe((state) => state.count, (value, previous) => changes.push([value, previous]));
  store.update({ label: "b" });
  store.update({ count: 1 });
  store.update({ count: 1 });
  assert.deepEqual(changes, [[1, 0]]);
  unsubscribe();
  assert.equal(store.subscriptionCount, 0);
});

test("RefreshScheduler coalesces reasons with a deterministic clock", async () => {
  const clock = new ManualClock();
  const calls: readonly string[][] = [] as string[][];
  const scheduler = new RefreshScheduler((reasons) => { (calls as string[][]).push([...reasons]); }, 50, clock);
  scheduler.request("git"); scheduler.request("turn");
  assert.equal(clock.pending, 1);
  clock.advance(49); assert.equal(calls.length, 0);
  clock.advance(1); await Promise.resolve();
  assert.deepEqual(calls, [["git", "turn"]]);
  scheduler.dispose();
});

test("DisposalRegistry disposes in reverse order and only once", async () => {
  const events: number[] = [];
  const registry = new DisposalRegistry();
  registry.add(() => { events.push(1); }); registry.add({ dispose: () => { events.push(2); } });
  await registry.dispose(); await registry.dispose();
  assert.deepEqual(events, [2, 1]);
  assert.equal(registry.isDisposed, true);
});
