import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

interface ExtensionAPI {
  on(event: string, handler: (event: any, context: any) => unknown): void;
}

interface ExtensionContext {
  readonly sessionManager: { getBranch(): readonly any[] };
}

export interface PiMailboxEnvironment {
  readonly CHRYSAKI_WORKER_JOB_ID?: string;
  readonly CHRYSAKI_MAILBOX?: string;
  readonly CHRYSAKI_CONFINED?: string;
}

interface AssistantResult { readonly text?: string; readonly stopReason?: string; readonly error?: string; }
interface WorkerStatus {
  readonly schemaVersion: number;
  readonly jobId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly resultPath?: string;
  readonly progress?: string;
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

const JOB_ID_PATTERN = /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_STATES = new Set(["completed", "failed", "timed_out", "cancelled"]);

export function extractFinalAssistant(ctx: Pick<ExtensionContext, "sessionManager">): AssistantResult {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry: any = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const message = entry.message;
    const text = Array.isArray(message.content)
      ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n")
      : "";
    return Object.freeze({ ...(text ? { text } : {}), ...(message.stopReason ? { stopReason: message.stopReason } : {}), ...(message.errorMessage ? { error: message.errorMessage } : {}) });
  }
  return Object.freeze({ error: "No assistant response was recorded" });
}

function workspaceContains(cwd: string): boolean {
  const workspace = "/workspace"; const rel = relative(workspace, resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateStatus(input: unknown, jobId: string): WorkerStatus {
  const value = input as Partial<WorkerStatus> | null;
  if (!value || typeof value !== "object" || value.jobId !== jobId || typeof value.schemaVersion !== "number" || typeof value.state !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Pi mailbox contains an invalid worker status");
  }
  return value as WorkerStatus;
}

async function readStatus(path: string, jobId: string): Promise<WorkerStatus> {
  return validateStatus(JSON.parse(await readFile(path, "utf8")), jobId);
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function terminalStatus(previous: WorkerStatus, state: "completed" | "failed", details: { readonly message?: string } = {}): WorkerStatus {
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: previous.schemaVersion,
    jobId: previous.jobId,
    state,
    createdAt: previous.createdAt,
    updatedAt: completedAt,
    ...(previous.startedAt ? { startedAt: previous.startedAt } : {}),
    completedAt,
    ...(state === "completed" ? { resultPath: "result.md", progress: "Pi worker response captured" } : {
      progress: "Pi worker failed before authoritative completion",
      failure: { code: "pi_worker_completion_failed", message: details.message ?? "Pi worker did not produce a complete response", retryable: false },
    }),
  };
}

export function installPiMailboxExtension(pi: ExtensionAPI, environment: PiMailboxEnvironment = process.env): void {
  const jobId = environment.CHRYSAKI_WORKER_JOB_ID; const mailbox = environment.CHRYSAKI_MAILBOX;
  if (!jobId || !mailbox || !isAbsolute(mailbox)) throw new Error("Pi mailbox extension requires an absolute CHRYSAKI_MAILBOX and CHRYSAKI_WORKER_JOB_ID");
  if (!JOB_ID_PATTERN.test(jobId) || resolve(mailbox).split("/").at(-1) !== jobId) throw new Error("Pi mailbox extension job ID does not match its mailbox path");
  const statusPath = resolve(mailbox, "status.json"); const resultPath = resolve(mailbox, "result.md");
  let terminalWritten = false;

  pi.on("project_trust", (event: { readonly cwd: string }) => {
    if (environment.CHRYSAKI_CONFINED === "1" && workspaceContains(event.cwd)) return { trusted: "yes" as const, remember: false };
    return { trusted: "undecided" as const };
  });

  pi.on("agent_settled", async (_event: unknown, ctx: ExtensionContext) => {
    if (terminalWritten) return;
    const previous = await readStatus(statusPath, jobId);
    if (TERMINAL_STATES.has(previous.state)) { terminalWritten = true; return; }
    const response = extractFinalAssistant(ctx);
    if (response.stopReason === "stop" && response.text) {
      await atomicWrite(resultPath, response.text, 0o600);
      await atomicWrite(statusPath, `${JSON.stringify(terminalStatus(previous, "completed"), null, 2)}\n`, 0o600);
      terminalWritten = true; return;
    }
    const reason = response.error ?? (response.stopReason ? `Assistant stopped with ${response.stopReason}` : "Assistant response was empty");
    await atomicWrite(statusPath, `${JSON.stringify(terminalStatus(previous, "failed", { message: reason }), null, 2)}\n`, 0o600);
    terminalWritten = true;
  });
}

export default function piMailboxExtension(pi: ExtensionAPI): void { installPiMailboxExtension(pi); }
