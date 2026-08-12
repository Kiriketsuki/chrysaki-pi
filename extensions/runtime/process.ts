import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult { stdout: string; stderr: string; code: number | null; killed: boolean; truncated: boolean; }
export interface ProcessOptions { cwd?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; input?: string; }
export type ProcessRunner = (command: string, args: readonly string[], options?: ProcessOptions) => Promise<ProcessResult>;

export class BoundedProcessRunner {
  private children = new Set<ChildProcess>();
  private disposed = false;

  run: ProcessRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
    if (this.disposed) return reject(new Error("process runner disposed"));
    const maxBytes = options.maxBytes ?? 256_000;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) <= maxBytes) return next;
      truncated = true;
      return Buffer.from(next).subarray(0, maxBytes).toString("utf8");
    };
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (!child.pid) return;
      try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(terminate, options.timeoutMs ?? 4_000);
    timeout.unref?.();
    const finish = (error?: Error, code: number | null = null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      this.children.delete(child);
      if (error) reject(error);
      else resolve({ stdout, stderr, code, killed: signal !== null || options.signal?.aborted === true, truncated });
    };
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(undefined, code, signal));
  });

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children) {
      if (!child.pid) continue;
      try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }
    this.children.clear();
  }

  get activeCount(): number { return this.children.size; }
}
