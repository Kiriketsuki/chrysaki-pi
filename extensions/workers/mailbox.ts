import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { validateWorkerRequest, validateWorkerStatus, WorkerValidationError, type StatusValidationOptions } from "./jobs.ts";
import type { JsonValue, WorkerRequest, WorkerStatusFile } from "./types.ts";

export const MAILBOX_FILES = Object.freeze({
  request: "request.json",
  prompt: "prompt.md",
  status: "status.json",
  result: "result.md",
  pane: "pane.log",
  metadata: "metadata.json",
});

export interface WorkerMailboxPaths {
  readonly directory: string;
  readonly request: string;
  readonly prompt: string;
  readonly status: string;
  readonly result: string;
  readonly pane: string;
  readonly metadata: string;
}

const JOB_ID_PATTERN = /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function workerJobsRoot(agentDirectory = getAgentDir()): string { return join(agentDirectory, "workers", "jobs"); }

export function workerMailboxPaths(jobsRoot: string, jobId: string): WorkerMailboxPaths {
  if (!JOB_ID_PATTERN.test(jobId)) throw new WorkerValidationError("Invalid worker job ID for mailbox path");
  const root = resolve(jobsRoot); const directory = resolve(root, jobId);
  if (!directory.startsWith(`${root}${sep}`)) throw new WorkerValidationError("Mailbox path escapes jobs root");
  return Object.freeze({ directory, ...Object.fromEntries(Object.entries(MAILBOX_FILES).map(([key, file]) => [key, join(directory, file)])) }) as unknown as WorkerMailboxPaths;
}

export async function atomicWriteFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  const directory = dirname(resolve(path));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function initializeMailbox(paths: WorkerMailboxPaths, requestInput: unknown, metadata: Readonly<Record<string, JsonValue>> = {}): Promise<WorkerRequest> {
  const request = validateWorkerRequest(requestInput);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await Promise.all([
    atomicWriteJson(paths.request, request),
    atomicWriteFile(paths.prompt, request.task),
    atomicWriteJson(paths.metadata, metadata),
    atomicWriteFile(paths.pane, ""),
  ]);
  return request;
}

export async function writeWorkerStatus(paths: WorkerMailboxPaths, status: unknown, previous?: WorkerStatusFile): Promise<WorkerStatusFile> {
  const validated = validateWorkerStatus(status, { expectedJobId: basename(paths.directory), previous });
  if (validated.resultPath && validated.resultPath !== MAILBOX_FILES.result) throw new WorkerValidationError("Status resultPath must name the mailbox result.md file");
  await atomicWriteJson(paths.status, validated);
  return validated;
}

export async function readWorkerStatus(paths: WorkerMailboxPaths, options?: Omit<StatusValidationOptions, "expectedJobId">): Promise<WorkerStatusFile> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(paths.status, "utf8")); }
  catch (error) { throw new WorkerValidationError(`Unable to read valid status.json: ${error instanceof Error ? error.message : String(error)}`); }
  const status = validateWorkerStatus(parsed, { expectedJobId: basename(paths.directory), previous: options?.previous });
  if (status.resultPath && status.resultPath !== MAILBOX_FILES.result) throw new WorkerValidationError("Status resultPath must name the mailbox result.md file");
  return status;
}

export async function writeCompletedResult(paths: WorkerMailboxPaths, result: string, status: WorkerStatusFile, previous?: WorkerStatusFile): Promise<void> {
  if (status.state !== "completed") throw new WorkerValidationError("writeCompletedResult requires completed status");
  await atomicWriteFile(paths.result, result);
  await writeWorkerStatus(paths, status, previous);
}

export interface BoundedResult { readonly text: string; readonly truncated: boolean; readonly fullPath: string; readonly bytes: number; readonly lines: number; }

export async function readAuthoritativeResult(paths: WorkerMailboxPaths, maxBytes = 50 * 1024, maxLines = 2_000): Promise<BoundedResult> {
  const statusFile = await readWorkerStatus(paths);
  if (statusFile.state !== "completed" || statusFile.resultPath !== MAILBOX_FILES.result) throw new WorkerValidationError("Mailbox does not contain an authoritative completed result");
  await access(paths.result, constants.R_OK);
  const info = await stat(paths.result);
  const full = await readFile(paths.result, "utf8");
  const sourceLines = full.split("\n");
  let text = sourceLines.slice(0, maxLines).join("\n");
  let truncated = sourceLines.length > maxLines;
  if (Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
    while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
    truncated = true;
  }
  return Object.freeze({ text, truncated, fullPath: paths.result, bytes: info.size, lines: sourceLines.length });
}
