import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { WorkerAdmissionController, defaultAdmissionPath } from "./admission.ts";
import { dirname, join, parse, resolve } from "node:path";
import { resolveWorkerPolicy } from "./config.ts";
import { WorkerValidationError, validateWorkerJob, validateWorkerRequest, validateWorkerStatus } from "./jobs.ts";
import { atomicWriteJson, initializeMailbox, readAuthoritativeResult, readWorkerStatus, workerJobsRoot, workerMailboxPaths, writeWorkerStatus, type WorkerMailboxPaths } from "./mailbox.ts";
import type { AdapterSelection, WorkerRouter } from "./router.ts";
import type { SandboxManager, SandboxProfile } from "./sandbox.ts";
import type { RevealResult, TmuxSession, TmuxTransport } from "./tmux.ts";
import { createWorkerId, createWorkerRunId, WORKER_SCHEMA_VERSION, isTerminalWorkerState, type JsonValue, type ResolvedWorkerPolicy, type WorkerAdapter, type WorkerConfig, type WorkerFailure, type WorkerJob, type WorkerRequest, type WorkerState, type WorkerStatusFile } from "./types.ts";
import type { WorkspaceManager } from "./workspaces.ts";

export interface WorkerTaskInput { readonly task: string; readonly role?: string; readonly metadata?: Readonly<Record<string, JsonValue>>; }
export interface WorkerDispatchInput {
  readonly task?: string;
  readonly tasks?: readonly (string | WorkerTaskInput)[];
  readonly access: "read" | "write";
  readonly capabilities?: readonly string[];
  readonly preferredCli?: "pi" | "claude" | "codex";
  readonly allowFallback?: boolean;
  readonly cwd: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly retentionMs?: number;
  readonly workflow?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type WorkerWaitCompletion = "all" | "any" | number;
export interface WorkerWaitInput { readonly jobIds: readonly string[]; readonly completion?: WorkerWaitCompletion; readonly timeoutMs?: number; readonly signal?: AbortSignal; }
export interface WorkerJobResult {
  readonly job: WorkerJob;
  readonly status: WorkerStatusFile;
  readonly result?: string;
  readonly resultTruncated?: boolean;
  readonly resultPath?: string;
}
export interface WorkerBatchResult { readonly ownerId: string; readonly runId: string; readonly parentSessionId: string; readonly concurrency: number; readonly jobs: readonly WorkerJobResult[]; }
export interface WorkerUpdate { readonly jobId: string; readonly state: WorkerState; readonly progress?: string; readonly elapsedMs: number; }
export interface WorkerCleanupResult {
  readonly jobId: string;
  readonly cleaned: boolean;
  readonly retained: boolean;
  readonly dirty: boolean;
  readonly reason?: string;
  readonly archivePath?: string;
}
export interface WorkerReconcileResult { readonly recovered: number; readonly active: number; readonly terminal: number; readonly invalid: readonly string[]; readonly cleanup: readonly WorkerCleanupResult[]; }

export interface WorkerBrokerOptions {
  readonly config: WorkerConfig;
  readonly router: WorkerRouter;
  readonly workspaces: WorkspaceManager;
  readonly sandbox: SandboxManager;
  readonly tmux: TmuxTransport;
  readonly jobsRoot?: string;
  readonly archiveRoot?: string;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly onUpdate?: (update: WorkerUpdate) => void;
  readonly admission?: WorkerAdmissionController;
}

interface ManagedJob {
  job: WorkerJob;
  status: WorkerStatusFile;
  readonly paths: WorkerMailboxPaths;
  readonly ownerId: string;
  adapter?: WorkerAdapter;
  selection?: AdapterSelection;
  session?: TmuxSession;
  profile?: SandboxProfile;
  deadline?: number;
  lastMailboxError?: string;
  refreshPromise?: Promise<void>;
  policy?: ResolvedWorkerPolicy;
  routingAttempts?: readonly unknown[];
  retainedReason?: string;
}

export class WorkerBrokerError extends Error {
  constructor(message: string) { super(message); this.name = "WorkerBrokerError"; }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(done, milliseconds); timer.unref?.();
    function done() { signal?.removeEventListener("abort", aborted); resolveSleep(); }
    function aborted() { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function boundedText(value: string, maxCharacters = 4_096): string { return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 14)}… [truncated]`; }
function failure(code: string, message: string, retryable = false): WorkerFailure { return { code, message: boundedText(message, 8_192), retryable }; }

async function executableRuntimeRoot(executablePath: string): Promise<string> {
  const target = await realpath(executablePath); let current = dirname(target); const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    try { await readFile(join(current, "package.json"), "utf8"); return current; } catch { current = dirname(current); }
  }
  return dirname(target);
}

export class WorkerBroker {
  private readonly config: WorkerConfig;
  private readonly router: WorkerRouter;
  private readonly workspaces: WorkspaceManager;
  private readonly sandbox: SandboxManager;
  private readonly tmux: TmuxTransport;
  private readonly root: string;
  private readonly archiveRoot: string;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly onUpdate?: (update: WorkerUpdate) => void;
  private readonly admission: WorkerAdmissionController;
  private readonly jobs = new Map<string, ManagedJob>();
  private cleanupTimer?: NodeJS.Timeout;
  private monitorTimer?: NodeJS.Timeout;
  private monitoring = false;
  private disposed = false;
  private reconcilePromise?: Promise<WorkerReconcileResult>;
  private cleanupChain: Promise<void> = Promise.resolve();

  constructor(options: WorkerBrokerOptions) {
    this.config = options.config; this.router = options.router; this.workspaces = options.workspaces; this.sandbox = options.sandbox; this.tmux = options.tmux;
    this.root = resolve(options.jobsRoot ?? workerJobsRoot()); this.archiveRoot = resolve(options.archiveRoot ?? join(dirname(this.root), "archive")); this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200; this.now = options.now ?? Date.now; this.sleep = options.sleep ?? defaultSleep; this.onUpdate = options.onUpdate;
    this.admission = options.admission ?? new WorkerAdmissionController(defaultAdmissionPath(this.root), this.config);
  }

  private async persist(managed: ManagedJob): Promise<void> {
    await atomicWriteJson(managed.paths.metadata, {
      job: managed.job,
      status: managed.status,
      ...(managed.routingAttempts ? { routingAttempts: managed.routingAttempts } : {}),
      ...(managed.policy ? { policy: managed.policy } : {}),
      ...(managed.lastMailboxError ? { lastMailboxError: boundedText(managed.lastMailboxError, 8_192) } : {}),
      ...(managed.retainedReason ? { retainedReason: managed.retainedReason } : {}),
    });
  }

  private terminalDeadline(managed: ManagedJob): number | undefined {
    if (!isTerminalWorkerState(managed.status.state) || managed.retainedReason) return undefined;
    const completed = Date.parse(managed.status.completedAt ?? managed.job.completedAt ?? managed.status.updatedAt);
    return Number.isFinite(completed) ? completed + (managed.job.request.retentionMs ?? this.config.retentionMs) : this.now();
  }

  private scheduleMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = undefined;
    if (this.disposed || !this.monitoring || ![...this.jobs.values()].some((job) => !isTerminalWorkerState(job.status.state))) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = undefined;
      void Promise.all([...this.jobs.values()].filter((job) => !isTerminalWorkerState(job.status.state)).map((job) => this.refreshSerialized(job)))
        .finally(() => this.scheduleMonitor());
    }, this.pollIntervalMs);
    this.monitorTimer.unref?.();
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (this.disposed) return;
    const deadlines = [...this.jobs.values()].map((job) => this.terminalDeadline(job)).filter((value): value is number => value !== undefined);
    if (!deadlines.length) return;
    const delay = Math.max(0, Math.min(...deadlines) - this.now());
    this.cleanupTimer = setTimeout(() => { this.cleanupTimer = undefined; void this.cleanup(undefined, { overdueOnly: true }).finally(() => this.scheduleCleanup()); }, Math.min(delay, 2_147_483_647));
    this.cleanupTimer.unref?.();
  }

  private emit(managed: ManagedJob): void {
    this.onUpdate?.({ jobId: managed.job.id, state: managed.status.state, progress: managed.status.progress, elapsedMs: Math.max(0, this.now() - Date.parse(managed.status.createdAt)) });
  }

  private async transition(managed: ManagedJob, state: WorkerState, options: { readonly progress?: string; readonly failure?: WorkerFailure } = {}): Promise<void> {
    if (managed.status.state === state && managed.status.progress === options.progress) return;
    const timestamp = new Date(this.now()).toISOString();
    const terminal = isTerminalWorkerState(state);
    const next: WorkerStatusFile = {
      schemaVersion: WORKER_SCHEMA_VERSION, jobId: managed.job.id, state,
      createdAt: managed.status.createdAt, updatedAt: timestamp,
      ...(managed.status.startedAt ? { startedAt: managed.status.startedAt } : state === "running" ? { startedAt: timestamp } : {}),
      ...(terminal ? { completedAt: timestamp } : {}),
      ...(options.progress ? { progress: boundedText(options.progress) } : {}),
      ...(options.failure ? { failure: options.failure } : {}),
    };
    managed.status = await writeWorkerStatus(managed.paths, next, managed.status);
    const cleanupDeadline = terminal ? new Date(Date.parse(timestamp) + (managed.job.request.retentionMs ?? this.config.retentionMs)).toISOString() : undefined;
    managed.job = Object.freeze({ ...managed.job, state, updatedAt: timestamp, ...(next.startedAt ? { startedAt: next.startedAt } : {}), ...(terminal ? { completedAt: timestamp, cleanupDeadline } : {}), ...(options.failure ? { failure: options.failure } : {}) });
    await this.persist(managed); if (terminal) await this.admission.releaseExecution(managed.job.id); this.emit(managed); if (terminal) this.scheduleCleanup();
  }

  private async createManaged(request: WorkerRequest, ownerId: string, policy: ResolvedWorkerPolicy, identity: { readonly id: string; readonly runId: string; readonly parentSessionId: string; readonly parentRunId?: string; readonly childIndex: number; readonly depth: number }): Promise<ManagedJob> {
    const id = identity.id; const paths = workerMailboxPaths(this.root, id); const timestamp = new Date(this.now()).toISOString();
    await initializeMailbox(paths, request, { ownerId, concurrency: policy.concurrency, concurrencySource: policy.source.concurrency });
    const status: WorkerStatusFile = { schemaVersion: WORKER_SCHEMA_VERSION, jobId: id, state: "queued", createdAt: timestamp, updatedAt: timestamp, progress: "Queued for interactive startup" };
    await writeWorkerStatus(paths, status);
    const job: WorkerJob = Object.freeze({ schemaVersion: WORKER_SCHEMA_VERSION, id, request, state: "queued", createdAt: timestamp, updatedAt: timestamp, mailboxPath: paths.directory, ownerId, runId: identity.runId, parentSessionId: identity.parentSessionId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}), childIndex: identity.childIndex, depth: identity.depth });
    const managed: ManagedJob = { job, status, paths, ownerId, policy }; this.jobs.set(id, managed); await this.persist(managed); await this.admission.commitJob(id); this.emit(managed); return managed;
  }

  private async archiveDiagnostics(managed: ManagedJob): Promise<void> {
    if (!managed.session) return;
    await this.tmux.archivePane(managed.session.name, managed.paths.pane).catch(() => undefined);
  }

  private async failStartup(managed: ManagedJob, code: string, message: string): Promise<void> {
    if (isTerminalWorkerState(managed.status.state)) return;
    await this.transition(managed, "failed", { progress: message, failure: failure(code, message) });
    if (managed.adapter && managed.session) await managed.adapter.interrupt({ jobId: managed.job.id, tmuxSession: managed.session.name }).catch(() => this.tmux.interrupt(managed.session!.name).catch(() => undefined));
    await this.archiveDiagnostics(managed);
  }

  private async launch(managed: ManagedJob, policy: ResolvedWorkerPolicy, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      const routed = await this.router.routeForJob(managed.job, policy, signal); managed.job = routed.job; managed.selection = routed.selection; managed.adapter = routed.selection.adapter; managed.routingAttempts = routed.selection.attempts; managed.policy = policy; await this.persist(managed);
      await this.transition(managed, "starting", { progress: `Starting interactive ${managed.adapter.id} worker` });
      const lease = await this.workspaces.create({ jobId: managed.job.id, sourcePath: managed.job.request.cwd, mode: managed.job.request.access });
      managed.job = Object.freeze({ ...managed.job, workspace: lease, updatedAt: new Date(this.now()).toISOString() }); await this.persist(managed);
      const executablePath = await realpath(routed.selection.executablePath);
      const runtimeRoot = await executableRuntimeRoot(executablePath);
      managed.profile = await this.sandbox.createProfile({
        jobId: managed.job.id, lease, mailboxPath: managed.paths.directory, cwd: managed.job.request.cwd,
        authReadOnlyPaths: [...this.config.sandbox.authReadOnlyPaths, ...(managed.adapter.authBindings?.() ?? [])],
        runtimeReadOnlyPaths: [...(managed.adapter.runtimeReadOnlyPaths ?? []), runtimeRoot],
        environment: managed.adapter.sandboxEnvironment?.() ?? {},
      });
      const adapterArgv = managed.adapter.buildInteractiveArgv({ confinementActive: true, executablePath, job: managed.job, workspacePath: "/workspace", mailboxPath: "/mailbox", homePath: "/home/worker", model: this.config.adapters[managed.adapter.id].model, interactiveArgs: this.config.adapters[managed.adapter.id].interactiveArgs });
      const launchArgv = this.sandbox.buildArgv(managed.profile, adapterArgv);
      managed.session = await this.tmux.launch({ jobId: managed.job.id, ownerId: managed.ownerId, cwd: managed.job.request.cwd, argv: launchArgv });
      managed.job = Object.freeze({ ...managed.job, tmuxSession: managed.session.name, updatedAt: new Date(this.now()).toISOString() });
      await this.persist(managed);
      const startupDeadline = this.now() + Math.min(this.startupTimeoutMs, managed.job.request.timeoutMs ?? policy.timeoutMs);
      const answered = new Set<string>();
      while (this.now() < startupDeadline) {
        signal?.throwIfAborted();
        if (!(await this.tmux.hasSession(managed.session.name))) throw new WorkerBrokerError(`${managed.adapter.id} exited before becoming ready`);
        const recognition = managed.adapter.recognizeScreen(await this.tmux.capturePane(managed.session.name, 200));
        if (recognition.state === "ready") {
          await this.transition(managed, "ready", { progress: `${managed.adapter.id} is ready` });
          const prompt = managed.adapter.buildPrompt({ jobId: managed.job.id, task: managed.job.request.task, mailboxPath: "/mailbox" });
          await this.tmux.paste(managed.session.name, prompt);
          await this.transition(managed, "running", { progress: `Task delivered to ${managed.adapter.id}` });
          managed.deadline = this.now() + (managed.job.request.timeoutMs ?? policy.timeoutMs); this.scheduleMonitor(); return;
        }
        if (recognition.state === "blocked") {
          if (managed.status.state !== "blocked") await this.transition(managed, "blocked", { progress: recognition.detail ?? "Worker requires attention" });
          const response = managed.adapter.answerPrompt(recognition, { confinementActive: managed.profile?.active === true });
          if (response !== undefined && recognition.promptId && !answered.has(recognition.promptId)) {
            answered.add(recognition.promptId); await this.tmux.paste(managed.session.name, response);
          }
        }
        await this.sleep(this.pollIntervalMs, signal);
      }
      await this.transition(managed, "timed_out", { progress: "Interactive provider startup timed out", failure: failure("startup_timed_out", "Interactive provider did not become ready before its startup deadline", true) });
      await managed.adapter.interrupt({ jobId: managed.job.id, tmuxSession: managed.session.name }).catch(() => this.tmux.interrupt(managed.session!.name).catch(() => undefined));
      await this.archiveDiagnostics(managed);
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.failStartup(managed, "startup_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private expand(input: WorkerDispatchInput, policy: ResolvedWorkerPolicy): WorkerRequest[] {
    if (input.task && input.tasks?.length) throw new WorkerValidationError("Worker dispatch must provide task or tasks, not both");
    const items = input.tasks?.length ? input.tasks : input.task ? [input.task] : [];
    if (!items.length) throw new WorkerValidationError("Worker dispatch requires task or tasks");
    return items.map((item) => {
      const task = typeof item === "string" ? item : item.task; const role = typeof item === "string" ? undefined : item.role;
      const itemMetadata = typeof item === "string" ? {} : item.metadata ?? {};
      return validateWorkerRequest({ task, ...(role ? { role } : {}), capabilities: input.capabilities ?? [], access: input.access, ...(input.preferredCli ? { preferredCli: input.preferredCli } : {}), allowFallback: input.allowFallback ?? true, cwd: input.cwd, concurrency: policy.concurrency, timeoutMs: input.timeoutMs ?? policy.timeoutMs, retentionMs: input.retentionMs ?? policy.retentionMs, ...(input.workflow ? { workflow: input.workflow } : {}), metadata: { ...(input.metadata ?? {}), ...itemMetadata, scheduling: { concurrency: policy.concurrency, source: policy.source.concurrency } } });
    });
  }

  private async spawnOwned(input: WorkerDispatchInput, identity: { readonly ownerId: string; readonly runId: string; readonly parentSessionId: string; readonly parentRunId?: string; readonly depth: number }, signal?: AbortSignal): Promise<WorkerBatchResult> {
    const policy = resolveWorkerPolicy(this.config, input.workflow, { concurrency: input.concurrency, timeoutMs: input.timeoutMs, retentionMs: input.retentionMs, preferredCli: input.preferredCli, allowFallback: input.allowFallback });
    const requests = this.expand(input, policy); const managed: ManagedJob[] = new Array(requests.length); let next = 0;
    const identities = requests.map((_request, childIndex) => ({ jobId: createWorkerId(), runId: identity.runId, sessionId: identity.parentSessionId, childIndex }));
    await this.admission.claimBatch(identities);
    const workers = Array.from({ length: Math.min(policy.concurrency, requests.length) }, async () => {
      while (true) {
        const index = next++; if (index >= requests.length) return;
        const workerIdentity = identities[index];
        const job = await this.createManaged(requests[index], identity.ownerId, policy, { id: workerIdentity.jobId, runId: identity.runId, parentSessionId: identity.parentSessionId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}), childIndex: index, depth: identity.depth }); managed[index] = job; await this.launch(job, policy, signal);
      }
    });
    try { await Promise.all(workers); }
    catch (error) { await Promise.allSettled(workers); await this.admission.rollbackUncommitted(identities.map((item) => item.jobId)); await this.cancelOwner(identity.ownerId, "Parent dispatch aborted"); throw error; }
    return Object.freeze({ ownerId: identity.ownerId, runId: identity.runId, parentSessionId: identity.parentSessionId, concurrency: policy.concurrency, jobs: Object.freeze(await Promise.all(managed.map((job) => this.result(job)))) });
  }

  async spawn(input: WorkerDispatchInput, options: { readonly signal?: AbortSignal; readonly ownerId?: string; readonly runId?: string; readonly parentSessionId?: string; readonly parentRunId?: string; readonly depth?: number } = {}): Promise<WorkerBatchResult> {
    const runId = options.runId ?? createWorkerRunId(); const ownerId = options.ownerId ?? `owner-${randomUUID()}`; const parentSessionId = options.parentSessionId ?? ownerId;
    return this.spawnOwned(input, { ownerId, runId, parentSessionId, ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}), depth: options.depth ?? 0 }, options.signal);
  }

  async run(input: WorkerDispatchInput, options: { readonly signal?: AbortSignal; readonly ownerId?: string; readonly runId?: string; readonly parentSessionId?: string; readonly parentRunId?: string; readonly depth?: number } = {}): Promise<WorkerBatchResult> {
    const runId = options.runId ?? createWorkerRunId(); const ownerId = options.ownerId ?? `owner-${randomUUID()}`; const parentSessionId = options.parentSessionId ?? ownerId;
    try {
      const spawned = await this.spawnOwned(input, { ownerId, runId, parentSessionId, ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}), depth: options.depth ?? 0 }, options.signal);
      const waited = await this.wait({ jobIds: spawned.jobs.map((entry) => entry.job.id), completion: "all", signal: options.signal });
      return Object.freeze({ ownerId, runId, parentSessionId, concurrency: spawned.concurrency, jobs: waited });
    } catch (error) {
      if (options.signal?.aborted) await this.cancelOwner(ownerId, "Parent worker_run call aborted");
      throw error;
    }
  }

  private async refresh(managed: ManagedJob): Promise<void> {
    if (isTerminalWorkerState(managed.status.state)) return;
    try {
      const status = await readWorkerStatus(managed.paths, { previous: managed.status });
      if (status.state === "completed") await readAuthoritativeResult(managed.paths, this.config.maxModelOutputBytes, this.config.maxModelOutputLines);
      managed.lastMailboxError = undefined;
      if (status.updatedAt !== managed.status.updatedAt || status.state !== managed.status.state) {
        const cleanupDeadline = status.completedAt ? new Date(Date.parse(status.completedAt) + (managed.job.request.retentionMs ?? this.config.retentionMs)).toISOString() : undefined;
        managed.status = status; managed.job = Object.freeze({ ...managed.job, state: status.state, updatedAt: status.updatedAt, ...(status.completedAt ? { completedAt: status.completedAt, cleanupDeadline } : {}), ...(status.failure ? { failure: status.failure } : {}) }); await this.persist(managed); this.emit(managed);
      }
    } catch (error) {
      const mailboxError = error instanceof Error ? error.message : String(error);
      if (managed.lastMailboxError !== mailboxError) { managed.lastMailboxError = mailboxError; await this.persist(managed).catch(() => undefined); }
    }
    if (isTerminalWorkerState(managed.status.state)) { await this.admission.releaseExecution(managed.job.id); await this.archiveDiagnostics(managed); this.scheduleCleanup(); return; }
    if (managed.deadline !== undefined && this.now() >= managed.deadline) {
      const detail = managed.lastMailboxError ? `; last mailbox error: ${managed.lastMailboxError}` : "";
      await this.transition(managed, "timed_out", { progress: `Worker deadline expired${detail}`, failure: failure("worker_timed_out", `No authoritative terminal mailbox result before deadline${detail}`, true) });
      if (managed.adapter && managed.session) await managed.adapter.interrupt({ jobId: managed.job.id, tmuxSession: managed.session.name }).catch(() => this.tmux.interrupt(managed.session!.name).catch(() => undefined));
      await this.archiveDiagnostics(managed); return;
    }
    if (managed.session && !(await this.tmux.hasSession(managed.session.name))) {
      await this.transition(managed, "failed", { progress: "Interactive worker session exited without terminal mailbox state", failure: failure("worker_exited", "Tmux worker exited without an authoritative result") });
      await this.archiveDiagnostics(managed);
    }
  }

  private async refreshSerialized(managed: ManagedJob): Promise<void> {
    managed.refreshPromise ??= this.refresh(managed).finally(() => { managed.refreshPromise = undefined; }); await managed.refreshPromise;
  }

  private completionReached(jobs: readonly ManagedJob[], completion: WorkerWaitCompletion): boolean {
    const terminal = jobs.filter((job) => isTerminalWorkerState(job.status.state)).length;
    return completion === "all" ? terminal === jobs.length : completion === "any" ? terminal > 0 : terminal >= completion;
  }

  async wait(input: WorkerWaitInput): Promise<readonly WorkerJobResult[]> {
    if (!input.jobIds.length) throw new WorkerBrokerError("worker_wait requires at least one job ID");
    const managed = input.jobIds.map((id) => { const job = this.jobs.get(id); if (!job) throw new WorkerBrokerError(`Unknown worker job: ${id}`); return job; });
    const completion = input.completion ?? "all";
    if (typeof completion === "number" && (!Number.isInteger(completion) || completion < 1 || completion > managed.length)) throw new WorkerBrokerError("Invalid worker_wait completion count");
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0)) throw new WorkerBrokerError("worker_wait timeoutMs must be a non-negative integer");
    const waitDeadline = input.timeoutMs === undefined ? Number.POSITIVE_INFINITY : this.now() + input.timeoutMs;
    while (true) {
      input.signal?.throwIfAborted(); await Promise.all(managed.map((job) => this.refreshSerialized(job)));
      if (this.completionReached(managed, completion) || this.now() >= waitDeadline) return Object.freeze(await Promise.all(managed.map((job) => this.result(job))));
      await this.sleep(this.pollIntervalMs, input.signal);
    }
  }

  private async result(managed: ManagedJob): Promise<WorkerJobResult> {
    if (managed.status.state === "completed") {
      try {
        const result = await readAuthoritativeResult(managed.paths, this.config.maxModelOutputBytes, this.config.maxModelOutputLines);
        return Object.freeze({ job: managed.job, status: managed.status, result: result.text, resultTruncated: result.truncated, resultPath: result.fullPath });
      } catch { /* retain terminal status; malformed completion is surfaced by absent result */ }
    }
    return Object.freeze({ job: managed.job, status: managed.status });
  }

  async status(jobIds?: readonly string[]): Promise<readonly WorkerJobResult[]> {
    const managed = jobIds ? jobIds.map((id) => { const job = this.jobs.get(id); if (!job) throw new WorkerBrokerError(`Unknown worker job: ${id}`); return job; }) : [...this.jobs.values()];
    await Promise.all(managed.map((job) => this.refreshSerialized(job))); return Object.freeze(await Promise.all(managed.map((job) => this.result(job))));
  }

  async send(jobId: string, prompt: string): Promise<void> {
    const managed = this.jobs.get(jobId); if (!managed?.session) throw new WorkerBrokerError(`Worker ${jobId} has no interactive session`);
    if (isTerminalWorkerState(managed.status.state)) throw new WorkerBrokerError(`Worker ${jobId} is already ${managed.status.state}`);
    await this.tmux.paste(managed.session.name, prompt);
  }

  async cancel(jobIds: readonly string[], reason = "Cancelled by parent"): Promise<readonly WorkerJobResult[]> {
    const targets = jobIds.map((id) => { const job = this.jobs.get(id); if (!job) throw new WorkerBrokerError(`Unknown worker job: ${id}`); return job; });
    await Promise.all(targets.map(async (managed) => {
      await this.refreshSerialized(managed);
      if (isTerminalWorkerState(managed.status.state)) return;
      await this.transition(managed, "cancelled", { progress: reason, failure: failure("worker_cancelled", reason) });
      if (managed.adapter && managed.session) await managed.adapter.interrupt({ jobId: managed.job.id, tmuxSession: managed.session.name }).catch(() => this.tmux.interrupt(managed.session!.name).catch(() => undefined));
      await this.archiveDiagnostics(managed);
    }));
    return Object.freeze(await Promise.all(targets.map((job) => this.result(job))));
  }

  async cancelOwner(ownerId: string, reason = "Owner cancelled"): Promise<readonly WorkerJobResult[]> {
    return this.cancel([...this.jobs.values()].filter((job) => job.ownerId === ownerId && !isTerminalWorkerState(job.status.state)).map((job) => job.job.id), reason);
  }

  async reveal(jobId: string, parentTmux = process.env.TMUX): Promise<RevealResult> {
    const managed = this.jobs.get(jobId);
    if (!managed?.job.tmuxSession) throw new WorkerBrokerError(`Worker ${jobId} has no retained tmux session`);
    if (!(await this.tmux.hasSession(managed.job.tmuxSession))) throw new WorkerBrokerError(`Worker ${jobId} tmux session is no longer available`);
    return this.tmux.reveal(managed.job.tmuxSession, parentTmux);
  }

  private async archiveJob(managed: ManagedJob): Promise<string> {
    await this.archiveDiagnostics(managed);
    await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
    const target = join(this.archiveRoot, managed.job.id); const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await rm(temporary, { recursive: true, force: true }); await mkdir(temporary, { mode: 0o700 });
    try {
      for (const source of [managed.paths.request, managed.paths.status, managed.paths.result, managed.paths.pane, managed.paths.metadata]) {
        await cp(source, join(temporary, source.slice(source.lastIndexOf("/") + 1)), { force: false }).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
      }
      await rm(target, { recursive: true, force: true }); await rename(temporary, target); return target;
    } catch (error) { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); throw error; }
  }

  async cleanup(jobIds?: readonly string[], options: { readonly overdueOnly?: boolean } = {}): Promise<readonly WorkerCleanupResult[]> {
    let release!: () => void; const predecessor = this.cleanupChain;
    this.cleanupChain = new Promise<void>((resolveCleanup) => { release = resolveCleanup; });
    await predecessor;
    try { return await this.cleanupOnce(jobIds, options); } finally { release(); }
  }

  private async cleanupOnce(jobIds?: readonly string[], options: { readonly overdueOnly?: boolean } = {}): Promise<readonly WorkerCleanupResult[]> {
    const now = this.now();
    const targets = jobIds
      ? jobIds.map((id) => { const job = this.jobs.get(id); if (!job) throw new WorkerBrokerError(`Unknown worker job: ${id}`); return job; })
      : [...this.jobs.values()];
    const results: WorkerCleanupResult[] = [];
    for (const managed of targets) {
      if (!isTerminalWorkerState(managed.status.state)) {
        if (!options.overdueOnly) results.push(Object.freeze({ jobId: managed.job.id, cleaned: false, retained: true, dirty: false, reason: `Worker is ${managed.status.state}` }));
        continue;
      }
      const deadline = this.terminalDeadline(managed) ?? now;
      if (options.overdueOnly && deadline > now) continue;
      let archivePath: string | undefined;
      try { archivePath = await this.archiveJob(managed); }
      catch (error) {
        const reason = `Diagnostic archival failed: ${error instanceof Error ? error.message : String(error)}`;
        managed.retainedReason = reason; await this.persist(managed).catch(() => undefined);
        results.push(Object.freeze({ jobId: managed.job.id, cleaned: false, retained: true, dirty: false, reason })); continue;
      }
      if (managed.job.tmuxSession) await this.tmux.kill(managed.job.tmuxSession).catch(() => false);
      if (managed.job.workspace) {
        try {
          const workspace = await this.workspaces.cleanup(managed.job.id);
          if (workspace.retained) {
            managed.retainedReason = workspace.reason ?? "Workspace retained";
            managed.job = Object.freeze({ ...managed.job, workspace: Object.freeze({ ...managed.job.workspace, dirty: workspace.dirty, cleanupEligible: false }) });
            await this.persist(managed);
            results.push(Object.freeze({ jobId: managed.job.id, cleaned: false, retained: true, dirty: workspace.dirty, reason: managed.retainedReason, archivePath })); continue;
          }
        } catch (error) {
          const reason = `Workspace cleanup failed safely: ${error instanceof Error ? error.message : String(error)}`;
          managed.retainedReason = reason; await this.persist(managed).catch(() => undefined);
          results.push(Object.freeze({ jobId: managed.job.id, cleaned: false, retained: true, dirty: false, reason, archivePath })); continue;
        }
      }
      await rm(managed.paths.directory, { recursive: true, force: true }); this.jobs.delete(managed.job.id);
      results.push(Object.freeze({ jobId: managed.job.id, cleaned: true, retained: false, dirty: false, archivePath }));
    }
    this.scheduleCleanup(); return Object.freeze(results);
  }

  async reconcile(): Promise<WorkerReconcileResult> {
    this.reconcilePromise ??= this.reconcileOnce().finally(() => { this.reconcilePromise = undefined; });
    return this.reconcilePromise;
  }

  private async reconcileOnce(): Promise<WorkerReconcileResult> {
    if (this.disposed) throw new WorkerBrokerError("Worker broker is disposed"); this.monitoring = true;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true }); const invalid: string[] = []; let recovered = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || this.jobs.has(entry.name)) continue;
      let managed: ManagedJob | undefined;
      try {
        const paths = workerMailboxPaths(this.root, entry.name);
        const request = validateWorkerRequest(JSON.parse(await readFile(paths.request, "utf8")));
        const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as Record<string, unknown>;
        const job = validateWorkerJob(metadata.job);
        if (job.id !== entry.name || job.mailboxPath !== paths.directory || JSON.stringify(job.request) !== JSON.stringify(request)) throw new WorkerValidationError("Persisted worker identity does not match its mailbox");
        let status: WorkerStatusFile;
        let mailboxError: string | undefined;
        try { status = await readWorkerStatus(paths); }
        catch (error) {
          mailboxError = error instanceof Error ? error.message : String(error);
          status = validateWorkerStatus(metadata.status, { expectedJobId: entry.name });
        }
        const effectiveJob = status.updatedAt !== job.updatedAt || status.state !== job.state
          ? Object.freeze({ ...job, state: status.state, updatedAt: status.updatedAt, ...(status.startedAt ? { startedAt: status.startedAt } : {}), ...(status.completedAt ? { completedAt: status.completedAt, cleanupDeadline: new Date(Date.parse(status.completedAt) + (request.retentionMs ?? this.config.retentionMs)).toISOString() } : {}), ...(status.failure ? { failure: status.failure } : {}) })
          : job;
        managed = { job: effectiveJob, status, paths, ownerId: effectiveJob.ownerId, lastMailboxError: mailboxError, retainedReason: typeof metadata.retainedReason === "string" ? metadata.retainedReason : undefined };
        if (effectiveJob.tmuxSession) managed.session = Object.freeze({ name: effectiveJob.tmuxSession, jobId: effectiveJob.id, ownerId: effectiveJob.ownerId });
        if (!isTerminalWorkerState(status.state)) {
          const started = Date.parse(status.startedAt ?? effectiveJob.startedAt ?? status.createdAt);
          managed.deadline = started + (request.timeoutMs ?? this.config.timeoutMs);
        }
        this.jobs.set(entry.name, managed); recovered++; await this.persist(managed);
      } catch (error) { invalid.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`); continue; }
      await this.refreshSerialized(managed);
    }
    await this.admission.reconcile([...this.jobs.values()].map((entry) => ({ id: entry.job.id, state: entry.status.state })));
    const cleanup = await this.cleanup(undefined, { overdueOnly: true }); this.scheduleCleanup(); this.scheduleMonitor();
    const values = [...this.jobs.values()];
    return Object.freeze({ recovered, active: values.filter((job) => !isTerminalWorkerState(job.status.state)).length, terminal: values.filter((job) => isTerminalWorkerState(job.status.state)).length, invalid: Object.freeze(invalid), cleanup });
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer); this.cleanupTimer = undefined;
    if (this.monitorTimer) clearTimeout(this.monitorTimer); this.monitorTimer = undefined;
  }
}
