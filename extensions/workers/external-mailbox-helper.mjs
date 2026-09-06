// Dependency-free completion writer for confined interactive Claude/Codex workers.
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

export async function completeMailbox({ mailbox, jobId, resultPath, failure }) {
  if (!/^wrk_[0-9a-f-]{36}$/.test(jobId ?? "")) throw new Error("Missing worker job identity");
  const statusPath = join(mailbox, "status.json");
  const previous = JSON.parse(await readFile(statusPath, "utf8"));
  if (previous.jobId !== jobId || previous.schemaVersion !== 1) throw new Error("Mailbox identity mismatch");
  if (!["running", "blocked"].includes(previous.state)) throw new Error(`Cannot complete a ${previous.state} worker`);
  if (!failure) {
    const answer = await readFile(resultPath, "utf8");
    if (!answer.trim()) throw new Error("The worker result is empty");
    await atomicWrite(join(mailbox, "result.md"), answer);
  }
  // Never resurrect cancellation observed while reading/writing the answer.
  const current = JSON.parse(await readFile(statusPath, "utf8"));
  if (current.jobId !== jobId || !["running", "blocked"].includes(current.state)) throw new Error("Worker is no longer active");
  const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString();
  const status = {
    schemaVersion: 1, jobId, state: failure ? "failed" : "completed",
    createdAt: current.createdAt, updatedAt: now, completedAt: now,
    ...(current.startedAt ? { startedAt: current.startedAt } : {}),
    ...(failure ? { failure: { code: failure.code, message: failure.message, retryable: false } } : { resultPath: "result.md" }),
  };
  await atomicWrite(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.CHRYSAKI_CONFINED !== "1") throw new Error("Worker completion requires active confinement");
    const [pathOrFail, code, message] = process.argv.slice(2);
    if (!pathOrFail || (pathOrFail === "--fail" && (!code || !message))) throw new Error("Usage: node /mailbox/complete.mjs <answer-file> | --fail <code> <message>");
    const status = await completeMailbox({ mailbox: process.env.CHRYSAKI_MAILBOX ?? "/mailbox", jobId: process.env.CHRYSAKI_WORKER_JOB_ID, ...(pathOrFail === "--fail" ? { failure: { code, message } } : { resultPath: pathOrFail }) });
    console.log(`Mailbox ${status.state}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
