import { fileURLToPath } from "node:url";
import type { Clock } from "../runtime/clock.ts";
import { systemClock } from "../runtime/clock.ts";
import type { ProcessRunner } from "../runtime/process.ts";
import type { RateLimitSnapshot } from "../runtime/types.ts";

const helper = fileURLToPath(new URL("../../scripts/codex-rate-limits.mjs", import.meta.url));

export class RateLimitCollector {
  private snapshot: RateLimitSnapshot = Object.freeze({ available: false, collectedAt: 0 });
  private inFlight?: Promise<RateLimitSnapshot>;
  private disposed = false;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private controller?: AbortController;

  constructor(private run: ProcessRunner, private clock: Clock = systemClock) {}

  refresh(provider: string, force = false): Promise<RateLimitSnapshot> {
    if (this.disposed || provider !== "openai-codex") return Promise.resolve(this.snapshot);
    if (!force && this.clock.now() - this.lastAttempt < 5 * 60_000) return Promise.resolve(this.snapshot);
    if (this.inFlight) return this.inFlight;
    this.lastAttempt = this.clock.now();
    this.inFlight = this.collect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async collect(): Promise<RateLimitSnapshot> {
    this.controller = new AbortController();
    try {
      const result = await this.run(process.execPath, [helper], { timeoutMs: 15_000, maxBytes: 16_000, signal: this.controller.signal });
      if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "rate limits unavailable");
      const parsed = JSON.parse(result.stdout) as Omit<RateLimitSnapshot, "available" | "collectedAt">;
      this.snapshot = Object.freeze({ ...parsed, available: !!(parsed.fiveHour || parsed.sevenDay), collectedAt: this.clock.now() });
    } catch (error) {
      if (!this.snapshot.available) this.snapshot = Object.freeze({ available: false, collectedAt: this.clock.now(), error: error instanceof Error ? error.message : String(error) });
    } finally { this.controller = undefined; }
    return this.snapshot;
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.controller?.abort(); this.controller = undefined; }
  get current(): RateLimitSnapshot { return this.snapshot; }
}
