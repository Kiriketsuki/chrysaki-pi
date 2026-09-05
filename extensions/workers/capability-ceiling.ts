import type { WorkerAdapterId, WorkerCapabilityCeiling, WorkerConfig, WorkerRequest } from "./types.ts";

export const WORKER_CEILING_ENV = "CHRYS_WORKER_CAPABILITY_CEILING";
export const WORKER_DEPTH_ENV = "CHRYS_WORKER_DEPTH";
export const WORKER_PARENT_RUN_ENV = "CHRYS_WORKER_RUN_ID";
const DEFAULT_CAPABILITIES = Object.freeze(["read", "write", "code", "tools", "reasoning", "images"]);

export class WorkerCapabilityError extends Error {
  constructor(message: string) { super(message); this.name = "WorkerCapabilityError"; }
}

function unique<T>(values: readonly T[]): readonly T[] { return Object.freeze([...new Set(values)]); }
function intersection<T>(left: readonly T[], right: readonly T[]): readonly T[] { const allowed = new Set(right); return Object.freeze(left.filter((value) => allowed.has(value))); }

export function rootWorkerCapabilityCeiling(config: Pick<WorkerConfig, "routingOrder" | "maxActiveWorkers" | "maxSpawnsPerRun" | "maxSpawnsPerSession">, input: Partial<WorkerCapabilityCeiling> = {}): WorkerCapabilityCeiling {
  return Object.freeze({
    allowedAdapters: unique(input.allowedAdapters ?? config.routingOrder),
    maxAccess: input.maxAccess ?? "write",
    allowedCapabilities: unique(input.allowedCapabilities ?? DEFAULT_CAPABILITIES),
    maxDepth: input.maxDepth ?? 1,
    maxActiveWorkers: Math.min(input.maxActiveWorkers ?? config.maxActiveWorkers, config.maxActiveWorkers),
    maxSpawnsPerRun: Math.min(input.maxSpawnsPerRun ?? config.maxSpawnsPerRun, config.maxSpawnsPerRun),
    maxSpawnsPerSession: Math.min(input.maxSpawnsPerSession ?? config.maxSpawnsPerSession, config.maxSpawnsPerSession),
  });
}

export function tightenWorkerCapabilityCeiling(parent: WorkerCapabilityCeiling, requested: Partial<WorkerCapabilityCeiling> = {}): WorkerCapabilityCeiling {
  return Object.freeze({
    allowedAdapters: requested.allowedAdapters ? intersection(parent.allowedAdapters, unique(requested.allowedAdapters)) : parent.allowedAdapters,
    maxAccess: parent.maxAccess === "read" || requested.maxAccess === "read" ? "read" : "write",
    allowedCapabilities: requested.allowedCapabilities ? intersection(parent.allowedCapabilities, unique(requested.allowedCapabilities)) : parent.allowedCapabilities,
    maxDepth: Math.min(parent.maxDepth, requested.maxDepth ?? parent.maxDepth),
    maxActiveWorkers: Math.min(parent.maxActiveWorkers, requested.maxActiveWorkers ?? parent.maxActiveWorkers),
    maxSpawnsPerRun: Math.min(parent.maxSpawnsPerRun, requested.maxSpawnsPerRun ?? parent.maxSpawnsPerRun),
    maxSpawnsPerSession: Math.min(parent.maxSpawnsPerSession, requested.maxSpawnsPerSession ?? parent.maxSpawnsPerSession),
  });
}

export function assertWorkerRequestWithinCeiling(request: WorkerRequest, ceiling: WorkerCapabilityCeiling, depth: number): void {
  if (depth >= ceiling.maxDepth) throw new WorkerCapabilityError(`Worker nesting depth ${depth + 1} exceeds ceiling ${ceiling.maxDepth}`);
  if (ceiling.maxAccess === "read" && request.access === "write") throw new WorkerCapabilityError("Worker write access exceeds inherited read-only ceiling");
  const missing = request.capabilities.filter((capability) => !ceiling.allowedCapabilities.includes(capability));
  if (missing.length) throw new WorkerCapabilityError(`Worker capabilities exceed ceiling: ${missing.join(", ")}`);
  if (request.preferredCli && !ceiling.allowedAdapters.includes(request.preferredCli)) throw new WorkerCapabilityError(`Worker adapter ${request.preferredCli} exceeds capability ceiling`);
}

export function filterRoutingByCeiling(routingOrder: readonly WorkerAdapterId[], ceiling: WorkerCapabilityCeiling): readonly WorkerAdapterId[] {
  const filtered = routingOrder.filter((adapter) => ceiling.allowedAdapters.includes(adapter));
  if (!filtered.length) throw new WorkerCapabilityError("Capability ceiling denies every configured worker adapter");
  return Object.freeze(filtered);
}

export function serializeWorkerCapabilityCeiling(ceiling: WorkerCapabilityCeiling): string { return JSON.stringify(ceiling); }

export function parseInheritedWorkerContext(environment: NodeJS.ProcessEnv = process.env): { readonly ceiling?: WorkerCapabilityCeiling; readonly depth: number; readonly parentRunId?: string } {
  let ceiling: WorkerCapabilityCeiling | undefined;
  if (environment[WORKER_CEILING_ENV]) {
    try {
      const value = JSON.parse(environment[WORKER_CEILING_ENV]!);
      if (!value || !Array.isArray(value.allowedAdapters) || !Array.isArray(value.allowedCapabilities) || !["read", "write"].includes(value.maxAccess)) throw new Error("invalid shape");
      for (const field of ["maxDepth", "maxActiveWorkers", "maxSpawnsPerRun", "maxSpawnsPerSession"] as const) if (!Number.isInteger(value[field]) || value[field] < 0) throw new Error(`invalid ${field}`);
      ceiling = Object.freeze({ ...value, allowedAdapters: unique(value.allowedAdapters), allowedCapabilities: unique(value.allowedCapabilities) }) as WorkerCapabilityCeiling;
    } catch (error) { throw new WorkerCapabilityError(`Invalid inherited worker capability ceiling: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const parsedDepth = Number(environment[WORKER_DEPTH_ENV] ?? 0); const depth = Number.isInteger(parsedDepth) && parsedDepth >= 0 ? parsedDepth : 0;
  const parentRunId = environment[WORKER_PARENT_RUN_ENV]?.trim() || undefined;
  return Object.freeze({ ...(ceiling ? { ceiling } : {}), depth, ...(parentRunId ? { parentRunId } : {}) });
}
