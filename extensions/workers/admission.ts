import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteJson } from "./mailbox.ts";
import type { WorkerConfig, WorkerState } from "./types.ts";
import { isTerminalWorkerState } from "./types.ts";

interface AdmissionClaim {
  readonly jobId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly childIndex: number;
  readonly createdAt: string;
  committed: boolean;
  active: boolean;
}

interface AdmissionLedger {
  readonly version: 1;
  claims: Record<string, AdmissionClaim>;
}

export interface AdmissionIdentity {
  readonly jobId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly childIndex: number;
}

export interface AdmissionSnapshot {
  readonly active: number;
  readonly sessionSpawns: number;
  readonly runSpawns: number;
  readonly limits: {
    readonly maxActiveWorkers: number;
    readonly maxSpawnsPerRun: number;
    readonly maxSpawnsPerSession: number;
  };
}

export class WorkerAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = "WorkerAdmissionError"; }
}

export class WorkerAdmissionController {
  private ledger: AdmissionLedger = { version: 1, claims: {} };
  private initialized = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly config: WorkerConfig) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.chain;
    this.chain = new Promise<void>((resolveLock) => { release = resolveLock; });
    await predecessor;
    try { return await operation(); } finally { release(); }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as AdmissionLedger;
      if (parsed?.version !== 1 || !parsed.claims || typeof parsed.claims !== "object") throw new WorkerAdmissionError("Invalid worker admission ledger");
      this.ledger = { version: 1, claims: { ...parsed.claims } };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.ledger = { version: 1, claims: {} };
    }
    this.initialized = true;
  }

  private async persist(): Promise<void> { await atomicWriteJson(this.path, this.ledger); }

  private counts(sessionId: string, runId: string) {
    const claims = Object.values(this.ledger.claims);
    return {
      active: claims.filter((claim) => claim.active).length,
      session: claims.filter((claim) => claim.sessionId === sessionId).length,
      run: claims.filter((claim) => claim.runId === runId).length,
    };
  }

  async claimBatch(identities: readonly AdmissionIdentity[]): Promise<void> {
    if (!identities.length) throw new WorkerAdmissionError("Admission requires at least one worker");
    const { runId, sessionId } = identities[0];
    if (identities.some((identity) => identity.runId !== runId || identity.sessionId !== sessionId)) throw new WorkerAdmissionError("One batch must share run and session identity");
    if (new Set(identities.map((identity) => identity.jobId)).size !== identities.length) throw new WorkerAdmissionError("Admission job identities must be unique");
    await this.exclusive(async () => {
      await this.initialize();
      const counts = this.counts(sessionId, runId); const requested = identities.length;
      if (counts.active + requested > this.config.maxActiveWorkers) throw new WorkerAdmissionError(`Worker active limit exceeded: ${counts.active} + ${requested} > ${this.config.maxActiveWorkers}`);
      if (counts.run + requested > this.config.maxSpawnsPerRun) throw new WorkerAdmissionError(`Worker run spawn budget exceeded: ${counts.run} + ${requested} > ${this.config.maxSpawnsPerRun}`);
      if (counts.session + requested > this.config.maxSpawnsPerSession) throw new WorkerAdmissionError(`Worker session spawn budget exceeded: ${counts.session} + ${requested} > ${this.config.maxSpawnsPerSession}`);
      const createdAt = new Date().toISOString();
      for (const identity of identities) {
        if (this.ledger.claims[identity.jobId]) throw new WorkerAdmissionError(`Worker admission already exists: ${identity.jobId}`);
        this.ledger.claims[identity.jobId] = { ...identity, createdAt, committed: false, active: true };
      }
      await this.persist();
    });
  }

  async commitJob(jobId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize(); const claim = this.ledger.claims[jobId];
      if (!claim) throw new WorkerAdmissionError(`Missing admission claim: ${jobId}`);
      claim.committed = true; await this.persist();
    });
  }

  async rollbackUncommitted(jobIds: readonly string[]): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize(); let changed = false;
      for (const id of jobIds) { const claim = this.ledger.claims[id]; if (claim && !claim.committed) { delete this.ledger.claims[id]; changed = true; } }
      if (changed) await this.persist();
    });
  }

  async releaseExecution(jobId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize(); const claim = this.ledger.claims[jobId];
      if (claim?.active) { claim.active = false; await this.persist(); }
    });
  }

  async reconcile(jobs: readonly { readonly id: string; readonly state: WorkerState }[]): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize(); const states = new Map(jobs.map((job) => [job.id, job.state])); let changed = false;
      for (const [id, claim] of Object.entries(this.ledger.claims)) {
        if (!claim.committed) { delete this.ledger.claims[id]; changed = true; continue; }
        const state = states.get(id);
        if (state && isTerminalWorkerState(state) && claim.active) { claim.active = false; changed = true; }
      }
      if (changed) await this.persist();
    });
  }

  async snapshot(sessionId: string, runId: string): Promise<AdmissionSnapshot> {
    return this.exclusive(async () => {
      await this.initialize(); const counts = this.counts(sessionId, runId);
      return Object.freeze({ active: counts.active, sessionSpawns: counts.session, runSpawns: counts.run, limits: Object.freeze({ maxActiveWorkers: this.config.maxActiveWorkers, maxSpawnsPerRun: this.config.maxSpawnsPerRun, maxSpawnsPerSession: this.config.maxSpawnsPerSession }) });
    });
  }
}

export function defaultAdmissionPath(jobsRoot: string): string { return resolve(dirname(jobsRoot), "admission.json"); }
