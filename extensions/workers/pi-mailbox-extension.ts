import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTerminalWorkerState, type WorkerStatusFile } from "./types.ts";
import { readWorkerStatus, workerMailboxPaths, writeCompletedResult, writeWorkerStatus } from "./mailbox.ts";

export interface PiMailboxEnvironment {
  readonly CHRYSAKI_WORKER_JOB_ID?: string;
  readonly CHRYSAKI_MAILBOX?: string;
  readonly CHRYSAKI_CONFINED?: string;
}

interface AssistantResult { readonly text?: string; readonly stopReason?: string; readonly error?: string; }

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

function terminalStatus(previous: WorkerStatusFile, state: "completed" | "failed", details: { readonly message?: string } = {}): WorkerStatusFile {
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
  const paths = workerMailboxPaths(dirname(mailbox), jobId);
  if (resolve(paths.directory) !== resolve(mailbox)) throw new Error("Pi mailbox extension job ID does not match its mailbox path");
  let terminalWritten = false;

  pi.on("project_trust", (event) => {
    if (environment.CHRYSAKI_CONFINED === "1" && workspaceContains(event.cwd)) return { trusted: "yes" as const, remember: false };
    return { trusted: "undecided" as const };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (terminalWritten) return;
    const previous = await readWorkerStatus(paths);
    if (isTerminalWorkerState(previous.state)) { terminalWritten = true; return; }
    const response = extractFinalAssistant(ctx);
    if (response.stopReason === "stop" && response.text) {
      await writeCompletedResult(paths, response.text, terminalStatus(previous, "completed"), previous);
      terminalWritten = true; return;
    }
    const reason = response.error ?? (response.stopReason ? `Assistant stopped with ${response.stopReason}` : "Assistant response was empty");
    await writeWorkerStatus(paths, terminalStatus(previous, "failed", { message: reason }), previous);
    terminalWritten = true;
  });
}

export default function piMailboxExtension(pi: ExtensionAPI): void { installPiMailboxExtension(pi); }
