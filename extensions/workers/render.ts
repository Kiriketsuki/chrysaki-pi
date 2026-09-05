import { Text } from "@earendil-works/pi-tui";
import type { WorkerJobResult } from "./broker.ts";

export interface WorkerSummary {
  readonly id: string;
  readonly state: string;
  readonly adapter?: string;
  readonly elapsedMs: number;
  readonly workspace?: string;
  readonly cleanupDeadline?: string;
  readonly resultTruncated?: boolean;
  readonly resultPath?: string;
  readonly progress?: string;
}

export interface WorkerToolDetails {
  readonly operation: string;
  readonly summaries: readonly WorkerSummary[];
  readonly concurrency?: number;
  readonly reveal?: { readonly mode: string; readonly command: string; readonly paneId?: string };
  readonly cleanup?: readonly { readonly jobId: string; readonly cleaned: boolean; readonly retained: boolean; readonly dirty: boolean; readonly reason?: string; readonly archivePath?: string }[];
}

function elapsed(job: WorkerJobResult, now = Date.now()): number {
  const start = Date.parse(job.status.startedAt ?? job.status.createdAt);
  const end = Date.parse(job.status.completedAt ?? job.status.updatedAt);
  return Math.max(0, (job.status.completedAt ? end : now) - start);
}

export function summarizeWorker(job: WorkerJobResult, now = Date.now()): WorkerSummary {
  return Object.freeze({
    id: job.job.id,
    state: job.status.state,
    ...(job.job.selectedAdapter ? { adapter: job.job.selectedAdapter } : {}),
    elapsedMs: elapsed(job, now),
    ...(job.job.workspace ? { workspace: job.job.workspace.workspacePath } : {}),
    ...(job.job.cleanupDeadline ? { cleanupDeadline: job.job.cleanupDeadline } : {}),
    ...(job.resultTruncated !== undefined ? { resultTruncated: job.resultTruncated } : {}),
    ...(job.resultPath ? { resultPath: job.resultPath } : {}),
    ...(job.status.progress ? { progress: job.status.progress } : {}),
  });
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

export function workerCallLabel(name: string, args: Record<string, unknown>): string {
  const count = Array.isArray(args.tasks) ? args.tasks.length : Array.isArray(args.jobIds) ? args.jobIds.length : 1;
  const target = typeof args.jobId === "string" ? ` ${args.jobId}` : count > 1 ? ` ×${count}` : "";
  const cli = typeof args.preferredCli === "string" ? ` · ${args.preferredCli}` : "";
  return `${name}${target}${cli}`;
}

export function renderWorkerCall(name: string, args: Record<string, unknown>, theme: any, lastComponent?: unknown): Text {
  const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  component.setText(theme.fg("toolTitle", theme.bold("Chrysaki Workers")) + theme.fg("muted", `  ${workerCallLabel(name, args)}`));
  return component;
}

export function renderWorkerResult(result: any, options: { readonly expanded: boolean; readonly isPartial: boolean }, theme: any, lastComponent?: unknown): Text {
  const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  if (options.isPartial) { component.setText(theme.fg("warning", "◆ worker orchestration in progress")); return component; }
  const details = result.details as WorkerToolDetails | undefined;
  if (!details) { component.setText(theme.fg("muted", "Worker result unavailable")); return component; }
  const lines: string[] = [];
  for (const item of details.summaries ?? []) {
    const color = item.state === "completed" ? "success" : ["failed", "timed_out", "cancelled"].includes(item.state) ? "error" : "accent";
    lines.push(`${theme.fg(color, item.state === "completed" ? "✓" : item.state === "running" ? "◆" : "•")} ${theme.fg("text", item.id)} ${theme.fg("muted", `${item.state}${item.adapter ? ` · ${item.adapter}` : ""} · ${duration(item.elapsedMs)}`)}`);
    if (options.expanded && item.progress) lines.push(theme.fg("dim", `  ${item.progress}`));
    if (options.expanded && item.workspace) lines.push(theme.fg("dim", `  workspace ${item.workspace}`));
  }
  if (details.reveal) lines.push(theme.fg("accent", details.reveal.mode === "split" ? `Revealed ${details.reveal.paneId ?? "worker pane"}` : details.reveal.command));
  for (const item of details.cleanup ?? []) lines.push(theme.fg(item.retained ? "warning" : "success", `${item.jobId} ${item.retained ? `retained: ${item.reason ?? "manual action required"}` : "cleaned"}`));
  component.setText(lines.join("\n") || theme.fg("muted", "No workers")); return component;
}
