import { isAbsolute } from "node:path";
import { Check, Errors } from "typebox/value";
import { WorkerJobSchema, WorkerRequestSchema, WorkerStatusFileSchema, WorkspaceLeaseSchema, type WorkerJob, type WorkerRequest, type WorkerState, type WorkerStatusFile, type WorkspaceLease } from "./types.ts";

export class WorkerValidationError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message); this.name = "WorkerValidationError";
  }
}

function assertSchema<T>(schema: object, value: unknown, label: string): asserts value is T {
  if (Check(schema as never, value)) return;
  const issues = [...Errors(schema as never, value)].slice(0, 8).map((error) => `${"path" in error ? String(error.path) : "/"}: ${error.message}`);
  throw new WorkerValidationError(`Invalid ${label}`, issues);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function validateWorkerRequest(value: unknown): WorkerRequest {
  assertSchema<Partial<WorkerRequest> & Pick<WorkerRequest, "task" | "access" | "cwd">>(WorkerRequestSchema, value, "worker request");
  if (!isAbsolute(value.cwd)) throw new WorkerValidationError("Worker cwd must be an absolute path");
  const metadata = value.metadata ?? {};
  if (!isJsonValue(metadata)) throw new WorkerValidationError("Worker metadata must contain only finite, acyclic JSON values");
  return Object.freeze({ ...value, capabilities: Object.freeze([...(value.capabilities ?? [])]), allowFallback: value.allowFallback ?? true, metadata: Object.freeze({ ...metadata }) });
}

export function validateWorkerJob(value: unknown): WorkerJob {
  assertSchema<WorkerJob>(WorkerJobSchema, value, "worker job");
  validateWorkerRequest(value.request);
  if (value.workspace) validateWorkspaceLease(value.workspace);
  return value;
}

export function validateWorkspaceLease(value: unknown): WorkspaceLease {
  assertSchema<WorkspaceLease>(WorkspaceLeaseSchema, value, "workspace lease");
  if (value.mode === "read" && value.kind !== "readonly-bind") throw new WorkerValidationError("Read leases must use readonly-bind isolation");
  if (value.mode === "write" && value.kind === "readonly-bind") throw new WorkerValidationError("Write leases require a worktree or opted-in copy");
  if (value.kind === "git-worktree" && !value.baseRevision) throw new WorkerValidationError("Git worktree leases require their base revision");
  if (value.kind !== "git-worktree" && value.baseRevision) throw new WorkerValidationError("Only Git worktree leases may record a base revision");
  if (value.dirty && value.cleanupEligible) throw new WorkerValidationError("Dirty workspaces cannot be cleanup eligible");
  return value;
}

const TRANSITIONS: Readonly<Record<WorkerState, readonly WorkerState[]>> = Object.freeze({
  queued: ["starting", "failed", "cancelled"],
  starting: ["ready", "blocked", "failed", "timed_out", "cancelled"],
  ready: ["running", "blocked", "failed", "timed_out", "cancelled"],
  running: ["blocked", "completed", "failed", "timed_out", "cancelled"],
  blocked: ["ready", "running", "failed", "timed_out", "cancelled"],
  completed: [], failed: [], timed_out: [], cancelled: [],
});

export function canTransitionWorkerState(from: WorkerState, to: WorkerState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertWorkerStateTransition(from: WorkerState, to: WorkerState): void {
  if (!canTransitionWorkerState(from, to)) throw new WorkerValidationError(`Invalid worker state transition: ${from} -> ${to}`);
}

export interface StatusValidationOptions { readonly expectedJobId: string; readonly previous?: WorkerStatusFile; }

export function validateWorkerStatus(value: unknown, options: StatusValidationOptions): WorkerStatusFile {
  assertSchema<WorkerStatusFile>(WorkerStatusFileSchema, value, "worker status");
  if (value.jobId !== options.expectedJobId) throw new WorkerValidationError(`Status job ID mismatch: expected ${options.expectedJobId}`);
  const createdAt = Date.parse(value.createdAt); const updatedAt = Date.parse(value.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new WorkerValidationError("Status contains an invalid timestamp");
  if (updatedAt < createdAt) throw new WorkerValidationError("Status updatedAt precedes createdAt");
  if (options.previous) {
    assertWorkerStateTransition(options.previous.state, value.state);
    if (value.createdAt !== options.previous.createdAt) throw new WorkerValidationError("Status createdAt is immutable");
    if (Date.parse(value.updatedAt) < Date.parse(options.previous.updatedAt)) throw new WorkerValidationError("Status timestamps cannot move backwards");
  }
  if (value.state === "completed") {
    if (!value.resultPath) throw new WorkerValidationError("Completed status requires resultPath");
    if (!value.completedAt) throw new WorkerValidationError("Completed status requires completedAt");
    if (value.failure) throw new WorkerValidationError("Completed status cannot contain failure details");
  }
  if (["failed", "timed_out", "cancelled"].includes(value.state) && !value.failure) throw new WorkerValidationError(`${value.state} status requires failure details`);
  if (!["failed", "timed_out", "cancelled"].includes(value.state) && value.failure) throw new WorkerValidationError(`${value.state} status cannot contain failure details`);
  return value;
}
