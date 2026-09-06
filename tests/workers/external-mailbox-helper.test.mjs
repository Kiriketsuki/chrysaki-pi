import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeMailbox } from "../../extensions/workers/external-mailbox-helper.mjs";
import { validateWorkerStatus } from "../../extensions/workers/jobs.ts";

const jobId = "wrk_12345678-1234-4123-8123-123456789abc";
async function fixture() {
  const mailbox = await mkdtemp(join(tmpdir(), "chrysaki-external-mailbox-"));
  const now = new Date().toISOString();
  const status = { schemaVersion: 1, jobId, state: "running", createdAt: now, startedAt: now, updatedAt: now };
  await writeFile(join(mailbox, "status.json"), JSON.stringify(status));
  const resultPath = join(mailbox, "answer.txt");
  await writeFile(resultPath, "A multiline answer\nwith symbols: ' $ ;\n");
  return { mailbox, jobId, resultPath, status };
}

test("external helper publishes a private answer followed by schema-valid terminal status", async () => {
  const item = await fixture();
  const completed = await completeMailbox(item);
  validateWorkerStatus(completed, { expectedJobId: jobId, previous: item.status });
  assert.equal(completed.state, "completed");
  assert.equal(await readFile(join(item.mailbox, "result.md"), "utf8"), await readFile(item.resultPath, "utf8"));
  assert.equal((await stat(join(item.mailbox, "result.md"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(item.mailbox, "status.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(item.mailbox, "status.json"), "utf8")), completed);
});

test("external helper records failures without manufacturing a completed result", async () => {
  const item = await fixture();
  const failed = await completeMailbox({ ...item, failure: { code: "task_failed", message: "Read failed" } });
  validateWorkerStatus(failed, { expectedJobId: jobId, previous: item.status });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.failure, { code: "task_failed", message: "Read failed", retryable: false });
  await assert.rejects(() => stat(join(item.mailbox, "result.md")), { code: "ENOENT" });
});

test("external helper refuses mismatched identities, empty answers, and terminal resurrection", async () => {
  const item = await fixture();
  await assert.rejects(() => completeMailbox({ ...item, jobId: "wrk_aaaaaaaa-1234-4123-8123-123456789abc" }), /identity mismatch/);
  await writeFile(item.resultPath, "  \n");
  await assert.rejects(() => completeMailbox(item), /empty/);
  const cancelled = { ...item.status, state: "cancelled", failure: { code: "worker_cancelled", message: "Stop", retryable: false } };
  await writeFile(join(item.mailbox, "status.json"), JSON.stringify(cancelled));
  await assert.rejects(() => completeMailbox(item), /cancelled/);
  assert.deepEqual(JSON.parse(await readFile(join(item.mailbox, "status.json"), "utf8")), cancelled);
});
