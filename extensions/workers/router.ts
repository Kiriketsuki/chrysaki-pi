import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { validateWorkerJob, WorkerValidationError } from "./jobs.ts";
import type { SandboxPreflight } from "./sandbox.ts";
import type { AdapterProbeResult, ResolvedWorkerPolicy, WorkerAdapter, WorkerAdapterId, WorkerConfig, WorkerJob, WorkerRequest } from "./types.ts";

export interface ConfinementPreflight { preflight(): Promise<SandboxPreflight>; }
export interface WorkerRouterOptions {
  readonly config: WorkerConfig;
  readonly adapters: readonly WorkerAdapter[];
  readonly sandbox: ConfinementPreflight;
  readonly path?: string;
}

export interface RouteAttempt { readonly adapterId: WorkerAdapterId; readonly eligible: boolean; readonly reason?: string; readonly executablePath?: string; }
export interface AdapterSelection {
  readonly adapterId: WorkerAdapterId;
  readonly adapter: WorkerAdapter;
  readonly executablePath: string;
  readonly probe: AdapterProbeResult;
  readonly attempts: readonly RouteAttempt[];
  readonly selectedAt: string;
}

export class WorkerRoutingError extends Error {
  constructor(message: string, readonly attempts: readonly RouteAttempt[] = []) { super(message); this.name = "WorkerRoutingError"; }
}

export async function resolveExecutable(executable: string, pathValue = process.env.PATH ?? ""): Promise<string | undefined> {
  if (!executable || executable.includes("\0")) return undefined;
  const candidates = isAbsolute(executable)
    ? [executable]
    : executable.includes("/") || executable.includes("\\") ? [] : pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return undefined;
}

export class WorkerRouter {
  private readonly config: WorkerConfig;
  private readonly adapters = new Map<WorkerAdapterId, WorkerAdapter>();
  private readonly sandbox: ConfinementPreflight;
  private readonly pathValue: string;
  private confinementProbe?: Promise<SandboxPreflight>;

  constructor(options: WorkerRouterOptions) {
    this.config = options.config; this.sandbox = options.sandbox; this.pathValue = options.path ?? process.env.PATH ?? "";
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.id)) throw new WorkerRoutingError(`Duplicate worker adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  refreshPreflight(): void { this.confinementProbe = undefined; }

  private async requireConfinement(): Promise<SandboxPreflight> {
    this.confinementProbe ??= this.sandbox.preflight();
    const result = await this.confinementProbe;
    if (!result.available || !result.usable) throw new WorkerRoutingError(`Worker confinement unavailable: ${result.reason ?? "Bubblewrap preflight failed"}`);
    return result;
  }

  async route(request: WorkerRequest, policy: ResolvedWorkerPolicy, signal?: AbortSignal): Promise<AdapterSelection> {
    signal?.throwIfAborted(); await this.requireConfinement(); signal?.throwIfAborted();
    const attempts: RouteAttempt[] = [];
    const ordered = policy.routingOrder;
    const candidates = request.allowFallback && policy.allowFallback ? ordered : ordered.slice(0, 1);
    for (const adapterId of candidates) {
      signal?.throwIfAborted();
      const adapter = this.adapters.get(adapterId); const settings = this.config.adapters[adapterId];
      if (!settings?.enabled) { attempts.push(Object.freeze({ adapterId, eligible: false, reason: "disabled by configuration" })); continue; }
      if (!adapter) { attempts.push(Object.freeze({ adapterId, eligible: false, reason: "adapter is not registered" })); continue; }
      const executablePath = await resolveExecutable(adapter.executable, this.pathValue);
      if (!executablePath) { attempts.push(Object.freeze({ adapterId, eligible: false, reason: `executable not found: ${adapter.executable}` })); continue; }
      let probe: AdapterProbeResult;
      try { probe = await adapter.probe(request, signal); }
      catch (error) { attempts.push(Object.freeze({ adapterId, eligible: false, executablePath, reason: `probe failed: ${error instanceof Error ? error.message : String(error)}` })); continue; }
      const missingCapabilities = request.capabilities.filter((capability) => !probe.capabilities.includes(capability));
      const reason = !probe.available ? probe.reason ?? "provider unavailable"
        : !probe.authenticated ? probe.reason ?? "provider is not authenticated"
        : !probe.sandboxSupported ? probe.reason ?? "provider does not support the required sandbox"
        : missingCapabilities.length ? `missing capabilities: ${missingCapabilities.join(", ")}` : undefined;
      if (reason) { attempts.push(Object.freeze({ adapterId, eligible: false, executablePath, reason })); continue; }
      attempts.push(Object.freeze({ adapterId, eligible: true, executablePath }));
      return Object.freeze({ adapterId, adapter, executablePath, probe: Object.freeze({ ...probe, capabilities: Object.freeze([...probe.capabilities]) }), attempts: Object.freeze([...attempts]), selectedAt: new Date().toISOString() });
    }
    throw new WorkerRoutingError(`No eligible interactive worker adapter (${attempts.map((attempt) => `${attempt.adapterId}: ${attempt.reason}`).join("; ") || "routing order is empty"})`, Object.freeze(attempts));
  }

  async routeForJob(jobInput: WorkerJob, policy: ResolvedWorkerPolicy, signal?: AbortSignal): Promise<{ readonly job: WorkerJob; readonly selection: AdapterSelection }> {
    const job = validateWorkerJob(jobInput);
    if (job.selectedAdapter) throw new WorkerRoutingError(`Worker ${job.id} already selected immutable adapter ${job.selectedAdapter}`);
    if (job.state !== "queued" && job.state !== "starting") throw new WorkerRoutingError(`Cannot select an adapter after worker ${job.id} reached ${job.state}`);
    const selection = await this.route(job.request, policy, signal);
    return Object.freeze({ job: bindAdapterSelection(job, selection.adapterId), selection });
  }
}

export function bindAdapterSelection(job: WorkerJob, adapterId: WorkerAdapterId): WorkerJob {
  if (job.selectedAdapter && job.selectedAdapter !== adapterId) throw new WorkerValidationError(`Worker adapter selection is immutable: ${job.selectedAdapter} -> ${adapterId}`);
  if (job.selectedAdapter === adapterId) return job;
  if (job.state !== "queued" && job.state !== "starting") throw new WorkerValidationError(`Worker adapter must be selected before ${job.state}`);
  return Object.freeze({ ...job, selectedAdapter: adapterId, updatedAt: new Date().toISOString() });
}
