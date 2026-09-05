import { createHash } from "node:crypto";
import type { RouteAttempt } from "./router.ts";
import type { ResolvedWorkerPolicy, WorkerAdapterId, WorkerCapabilityCeiling, WorkerJob, WorkerRequest, WorkspaceLease } from "./types.ts";

export interface WorkerLaunchContract {
  readonly version: 1;
  readonly digest: string;
  readonly taskDigest: string;
  readonly identity: { readonly jobId: string; readonly runId?: string; readonly parentSessionId?: string; readonly parentRunId?: string; readonly childIndex?: number; readonly depth?: number };
  readonly adapter: { readonly id: WorkerAdapterId; readonly executablePath: string; readonly model?: string };
  readonly authority: { readonly access: "read" | "write"; readonly capabilities: readonly string[]; readonly ceiling: WorkerCapabilityCeiling };
  readonly workspace: { readonly kind: WorkspaceLease["kind"]; readonly sourcePath: string; readonly workspacePath: string; readonly baseRevision?: string };
  readonly sandbox: { readonly active: true; readonly binary: string; readonly guestCwd: string };
  readonly timing: { readonly timeoutMs: number; readonly retentionMs: number };
  readonly routing: { readonly attempts: readonly RouteAttempt[]; readonly policySources: ResolvedWorkerPolicy["source"] };
}

export interface WorkerPreflightItem {
  readonly childIndex: number;
  readonly taskDigest: string;
  readonly adapter: WorkerAdapterId;
  readonly executablePath: string;
  readonly model?: string;
  readonly routingAttempts: readonly RouteAttempt[];
}

export interface WorkerPreflightResult {
  readonly ok: true;
  readonly sideEffectFree: true;
  readonly runId: string;
  readonly parentSessionId: string;
  readonly requested: number;
  readonly concurrency: number;
  readonly ceiling: WorkerCapabilityCeiling;
  readonly admission: { readonly active: number; readonly sessionSpawns: number; readonly runSpawns: number };
  readonly items: readonly WorkerPreflightItem[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)); }
export function digestValue(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex"); }
export function taskDigest(request: Pick<WorkerRequest, "task">): string { return digestValue(request.task); }

export function createWorkerLaunchContract(input: {
  readonly job: WorkerJob;
  readonly adapterId: WorkerAdapterId;
  readonly executablePath: string;
  readonly model?: string;
  readonly ceiling: WorkerCapabilityCeiling;
  readonly workspace: WorkspaceLease;
  readonly sandbox: { readonly active: true; readonly binary: string; readonly guestCwd: string };
  readonly timeoutMs: number;
  readonly retentionMs: number;
  readonly attempts: readonly RouteAttempt[];
  readonly policySources: ResolvedWorkerPolicy["source"];
}): WorkerLaunchContract {
  const payload = {
    version: 1 as const,
    taskDigest: taskDigest(input.job.request),
    identity: { jobId: input.job.id, ...(input.job.runId ? { runId: input.job.runId } : {}), ...(input.job.parentSessionId ? { parentSessionId: input.job.parentSessionId } : {}), ...(input.job.parentRunId ? { parentRunId: input.job.parentRunId } : {}), ...(input.job.childIndex !== undefined ? { childIndex: input.job.childIndex } : {}), ...(input.job.depth !== undefined ? { depth: input.job.depth } : {}) },
    adapter: { id: input.adapterId, executablePath: input.executablePath, ...(input.model ? { model: input.model } : {}) },
    authority: { access: input.job.request.access, capabilities: Object.freeze([...input.job.request.capabilities]), ceiling: input.ceiling },
    workspace: { kind: input.workspace.kind, sourcePath: input.workspace.sourcePath, workspacePath: input.workspace.workspacePath, ...(input.workspace.baseRevision ? { baseRevision: input.workspace.baseRevision } : {}) },
    sandbox: { active: true as const, binary: input.sandbox.binary, guestCwd: input.sandbox.guestCwd },
    timing: { timeoutMs: input.timeoutMs, retentionMs: input.retentionMs },
    routing: { attempts: Object.freeze([...input.attempts]), policySources: input.policySources },
  };
  return Object.freeze({ ...payload, digest: digestValue(payload) });
}
