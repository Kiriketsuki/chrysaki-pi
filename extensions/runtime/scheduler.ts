import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

export type RefreshTask = (reasons: readonly string[]) => void | Promise<void>;

export class RefreshScheduler {
  private reasons = new Set<string>();
  private timer: unknown;
  private running = false;
  private disposed = false;

  constructor(private task: RefreshTask, private delayMs = 50, private clock: Clock = systemClock) {}

  request(reason: string): void {
    if (this.disposed) return;
    this.reasons.add(reason);
    if (this.running || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.disposed || this.running || this.reasons.size === 0) return;
    this.running = true;
    const reasons = [...this.reasons];
    this.reasons.clear();
    try {
      await this.task(reasons);
    } finally {
      this.running = false;
      if (this.reasons.size > 0 && !this.disposed) this.request("coalesced");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.reasons.clear();
  }
}
