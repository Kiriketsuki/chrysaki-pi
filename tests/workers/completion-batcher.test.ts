import assert from "node:assert/strict";
import test from "node:test";
import { WorkerCompletionBatcher } from "../../extensions/workers/completion-batcher.ts";

const notice = (jobId: string, state: "completed" | "failed" | "blocked") => ({ jobId, state, elapsedMs: 10 });
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("successful completions are deduplicated and batched within bounded time", async () => {
  const deliveries: any[] = []; const batcher = new WorkerCompletionBatcher({ enabled: true, debounceMs: 10, maxWaitMs: 50 }, (items) => { deliveries.push(items); });
  batcher.push(notice("one", "completed")); batcher.push(notice("two", "completed")); batcher.push(notice("two", "completed")); await delay(25);
  assert.equal(deliveries.length, 1); assert.deepEqual(deliveries[0].map((item: any) => item.jobId), ["one", "two"]); await batcher.dispose();
});

test("blocked and failed workers bypass batching after flushing successes", async () => {
  const deliveries: any[] = []; const batcher = new WorkerCompletionBatcher({ enabled: true, debounceMs: 100, maxWaitMs: 200 }, (items) => { deliveries.push(items); });
  batcher.push(notice("success", "completed")); batcher.push(notice("blocked", "blocked")); await delay(10); batcher.push(notice("failed", "failed")); await delay(10);
  assert.deepEqual(deliveries.map((items) => items.map((item: any) => item.state)), [["completed"], ["blocked"], ["failed"]]); await batcher.dispose();
});
