import type { WorkerState } from "./types.ts";

export interface WorkerCompletionNotice { readonly jobId: string; readonly state: WorkerState; readonly progress?: string; readonly elapsedMs: number; }
export interface CompletionBatchConfig { readonly enabled: boolean; readonly debounceMs: number; readonly maxWaitMs: number; }

const IMMEDIATE = new Set<WorkerState>(["blocked", "failed", "timed_out", "cancelled"]);

export class WorkerCompletionBatcher {
  private readonly pending = new Map<string, WorkerCompletionNotice>();
  private debounce?: NodeJS.Timeout;
  private maxWait?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly config: CompletionBatchConfig, private readonly deliver: (notices: readonly WorkerCompletionNotice[]) => void | Promise<void>) {}

  push(notice: WorkerCompletionNotice): void {
    if (this.disposed) return;
    if (IMMEDIATE.has(notice.state)) { void this.flush().then(() => this.deliver(Object.freeze([notice]))); return; }
    if (notice.state !== "completed") return;
    if (!this.config.enabled) { void this.deliver(Object.freeze([notice])); return; }
    this.pending.set(notice.jobId, notice);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), this.config.debounceMs); this.debounce.unref?.();
    if (!this.maxWait) { this.maxWait = setTimeout(() => void this.flush(), this.config.maxWaitMs); this.maxWait.unref?.(); }
  }

  async flush(): Promise<void> {
    if (!this.pending.size) return;
    if (this.debounce) clearTimeout(this.debounce); if (this.maxWait) clearTimeout(this.maxWait);
    this.debounce = undefined; this.maxWait = undefined;
    const notices = Object.freeze([...this.pending.values()]); this.pending.clear(); await this.deliver(notices);
  }

  async dispose(): Promise<void> { if (this.disposed) return; await this.flush(); this.disposed = true; }
}
