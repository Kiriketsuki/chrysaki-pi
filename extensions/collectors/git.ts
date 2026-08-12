import type { Clock } from "../runtime/clock.ts";
import { systemClock } from "../runtime/clock.ts";
import type { ProcessRunner } from "../runtime/process.ts";
import { EMPTY_GIT, type GitCommit, type GitFile, type GitSnapshot } from "../runtime/types.ts";

export interface CollectorContext { cwd: string; }

function parseStatus(output: string): GitFile[] {
  return output.split("\0").filter(Boolean).map((entry) => {
    const code = entry.slice(0, 2);
    const path = entry.slice(3).replace(/^.* -> /, "");
    return { path, indexStatus: code[0] ?? " ", worktreeStatus: code[1] ?? " ", added: 0, deleted: 0 };
  });
}

function applyNumstat(files: GitFile[], output: string): GitFile[] {
  const stats = new Map(output.trim().split("\n").filter(Boolean).map((line) => {
    const [added, deleted, ...path] = line.split("\t");
    return [path.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0 }];
  }));
  return files.map((file) => ({ ...file, ...(stats.get(file.path) ?? {}) }));
}

function parseGraph(output: string): GitCommit[] {
  return output.trim().split("\n").filter(Boolean).slice(0, 12).map((line) => {
    const [hash = "", refs = "", ...subject] = line.split("\t");
    return { hash, refs, subject: subject.join("\t") };
  });
}

export class GitCollector {
  private context?: CollectorContext;
  private controller?: AbortController;
  private disposed = false;
  private inFlight?: Promise<GitSnapshot>;
  private lastFailure = 0;
  private failureCount = 0;
  private snapshot: GitSnapshot = EMPTY_GIT;

  constructor(private run: ProcessRunner, private clock: Clock = systemClock) {}

  start(context: CollectorContext): void { this.context = context; this.disposed = false; }

  refresh(_reason: string): Promise<GitSnapshot> {
    if (this.disposed || !this.context) return Promise.resolve(this.snapshot);
    const backoff = Math.min(60_000, 1_000 * (2 ** Math.max(0, this.failureCount - 1)));
    if (this.failureCount > 0 && this.clock.now() - this.lastFailure < backoff) return Promise.resolve(this.snapshot);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async collect(): Promise<GitSnapshot> {
    const cwd = this.context!.cwd;
    this.controller = new AbortController();
    const options = { cwd, timeoutMs: 3_000, maxBytes: 128_000, signal: this.controller.signal };
    try {
      const root = await this.run("git", ["rev-parse", "--show-toplevel"], options);
      if (root.code !== 0) throw new Error(root.stderr.trim() || "not a Git repository");
      const [branchResult, commitResult, status, numstat, graph, counts] = await Promise.all([
        this.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], options),
        this.run("git", ["rev-parse", "--short", "HEAD"], options),
        this.run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], options),
        this.run("git", ["diff", "--numstat", "HEAD"], options),
        this.run("git", ["log", "-12", "--pretty=format:%h%x09%D%x09%s"], options),
        this.run("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], options).catch(() => ({ stdout: "0\t0", stderr: "", code: 1, killed: false, truncated: false })),
      ]);
      for (const required of [branchResult, commitResult, status, numstat, graph]) {
        if (required.code !== 0 || required.killed) throw new Error(required.stderr.trim() || "Git collection failed");
      }
      const branch = branchResult.stdout.trim() || "HEAD";
      const commit = commitResult.stdout.trim();
      const [behind = 0, ahead = 0] = counts.stdout.trim().split(/\s+/).map(Number);
      this.snapshot = Object.freeze({
        available: true,
        root: root.stdout.trim(), branch, commit, ahead: ahead || 0, behind: behind || 0,
        files: Object.freeze(applyNumstat(parseStatus(status.stdout), numstat.stdout).slice(0, 100)),
        graph: Object.freeze(parseGraph(graph.stdout)),
        collectedAt: this.clock.now(),
      });
      this.failureCount = 0;
      return this.snapshot;
    } catch (error) {
      this.lastFailure = this.clock.now();
      this.failureCount++;
      if (this.snapshot.available) return this.snapshot;
      this.snapshot = Object.freeze({ ...EMPTY_GIT, error: error instanceof Error ? error.message : String(error), collectedAt: this.clock.now() });
      return this.snapshot;
    } finally { this.controller = undefined; }
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.controller?.abort(); this.controller = undefined; }
  get current(): GitSnapshot { return this.snapshot; }
}
