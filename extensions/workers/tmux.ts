import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { BoundedProcessRunner, type ProcessResult, type ProcessRunner } from "../runtime/process.ts";
import { atomicWriteFile } from "./mailbox.ts";

const SESSION_PATTERN = /^chrysaki-wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOB_ID_PATTERN = /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUFFER_PATTERN = /^chrysaki-paste-[0-9a-f-]+$/;

export interface TmuxTransportOptions {
  readonly binary?: string;
  readonly runner?: ProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly commandTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface TmuxLaunchRequest {
  readonly jobId: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly argv: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface TmuxSession {
  readonly name: string;
  readonly jobId: string;
  readonly ownerId: string;
}

export interface RevealResult {
  readonly mode: "split" | "attach-command";
  readonly paneId?: string;
  readonly argv: readonly string[];
  readonly command: string;
}

export class TmuxTransportError extends Error {
  constructor(message: string, readonly args: readonly string[] = [], readonly result?: ProcessResult) {
    super(message); this.name = "TmuxTransportError";
  }
}

export function tmuxSessionName(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new TmuxTransportError("Invalid job ID for tmux session");
  return `chrysaki-${jobId}`;
}

function validateSessionName(session: string): void {
  if (!SESSION_PATTERN.test(session)) throw new TmuxTransportError("Invalid Chrysaki tmux session name");
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export class TmuxTransport {
  readonly binary: string;
  private readonly runner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly ownedRunner?: BoundedProcessRunner;

  constructor(options: TmuxTransportOptions = {}) {
    this.binary = options.binary ?? "tmux";
    if (!this.binary || this.binary.includes("\0")) throw new TmuxTransportError("Invalid tmux executable");
    if (options.runner) this.runner = options.runner;
    else { this.ownedRunner = new BoundedProcessRunner(); this.runner = this.ownedRunner.run; }
    this.env = { ...process.env, ...options.env };
    this.timeoutMs = options.commandTimeoutMs ?? 5_000;
    this.maxBytes = options.maxOutputBytes ?? 256_000;
  }

  private async execute(args: readonly string[], input?: string, allowFailure = false): Promise<ProcessResult> {
    const result = await this.runner(this.binary, args, { input, env: this.env, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
    if (!allowFailure && result.code !== 0) throw new TmuxTransportError(`tmux ${args[0] ?? "command"} failed: ${result.stderr.trim() || `exit ${result.code}`}`, args, result);
    return result;
  }

  async preflight(): Promise<{ readonly available: boolean; readonly version?: string; readonly reason?: string }> {
    const result = await this.execute(["-V"], undefined, true);
    if (result.code !== 0) return Object.freeze({ available: false, reason: result.stderr.trim() || `tmux exited ${result.code}` });
    return Object.freeze({ available: true, version: result.stdout.trim() || undefined });
  }

  async launch(request: TmuxLaunchRequest): Promise<TmuxSession> {
    const name = tmuxSessionName(request.jobId);
    if (!request.ownerId.trim()) throw new TmuxTransportError("Tmux owner ID is required");
    if (!isAbsolute(request.cwd)) throw new TmuxTransportError("Tmux worker cwd must be absolute");
    if (!request.argv.length || request.argv.some((part) => part.includes("\0"))) throw new TmuxTransportError("Worker argv must be a non-empty NUL-free array");
    const envArgs = Object.entries(request.environment ?? {}).flatMap(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new TmuxTransportError(`Invalid worker environment entry: ${key}`);
      return ["-e", `${key}=${value}`];
    });
    // tmux 3.x accepts command and arguments separately after `--`; no shell command is constructed.
    await this.execute(["new-session", "-d", "-s", name, "-c", request.cwd, ...envArgs, "--", ...request.argv]);
    try {
      await this.execute(["set-option", "-t", name, "@chrysaki-job-id", request.jobId]);
      await this.execute(["set-option", "-t", name, "@chrysaki-owner-id", request.ownerId]);
    } catch (error) {
      await this.execute(["kill-session", "-t", name], undefined, true);
      throw error;
    }
    return Object.freeze({ name, jobId: request.jobId, ownerId: request.ownerId });
  }

  async hasSession(session: string): Promise<boolean> {
    validateSessionName(session);
    return (await this.execute(["has-session", "-t", session], undefined, true)).code === 0;
  }

  async verifyOwnership(session: string, jobId: string, ownerId: string): Promise<boolean> {
    validateSessionName(session);
    if (!JOB_ID_PATTERN.test(jobId) || !ownerId.trim()) return false;
    if (!(await this.hasSession(session))) return true;
    const [job, owner] = await Promise.all([
      this.execute(["show-options", "-v", "-t", session, "@chrysaki-job-id"], undefined, true),
      this.execute(["show-options", "-v", "-t", session, "@chrysaki-owner-id"], undefined, true),
    ]);
    return job.code === 0 && owner.code === 0 && job.stdout.trim() === jobId && owner.stdout.trim() === ownerId;
  }

  async terminateOwned(session: string, jobId: string, ownerId: string): Promise<boolean> {
    if (!(await this.verifyOwnership(session, jobId, ownerId))) return false;
    if (await this.hasSession(session)) await this.kill(session);
    return !(await this.hasSession(session));
  }

  async paste(session: string, text: string, submit = true): Promise<void> {
    validateSessionName(session);
    if (text.includes("\0")) throw new TmuxTransportError("Tmux paste content cannot contain NUL bytes");
    const buffer = `chrysaki-paste-${randomUUID()}`;
    if (!BUFFER_PATTERN.test(buffer)) throw new TmuxTransportError("Invalid private tmux buffer name");
    await this.execute(["load-buffer", "-b", buffer, "-"], `${text}${submit ? "\n" : ""}`);
    try {
      // -d deletes the private buffer only after a successful paste.
      await this.execute(["paste-buffer", "-d", "-b", buffer, "-t", session]);
    } catch (error) {
      await this.execute(["delete-buffer", "-b", buffer], undefined, true);
      throw error;
    }
  }

  async capturePane(session: string, historyLines = 2_000): Promise<string> {
    validateSessionName(session);
    if (!Number.isInteger(historyLines) || historyLines < 1 || historyLines > 100_000) throw new TmuxTransportError("Invalid pane history line count");
    return (await this.execute(["capture-pane", "-p", "-e", "-S", `-${historyLines}`, "-t", session])).stdout;
  }

  async archivePane(session: string, paneLogPath: string, historyLines = 2_000): Promise<string> {
    const capture = await this.capturePane(session, historyLines);
    await atomicWriteFile(paneLogPath, capture);
    return capture;
  }

  async interrupt(session: string): Promise<void> {
    validateSessionName(session);
    await this.execute(["send-keys", "-t", session, "C-c"]);
  }

  async kill(session: string): Promise<boolean> {
    validateSessionName(session);
    const result = await this.execute(["kill-session", "-t", session], undefined, true);
    if (result.code === 0) return true;
    if (/no server running|can't find session|no sessions/i.test(result.stderr)) return false;
    throw new TmuxTransportError(`tmux kill-session failed: ${result.stderr.trim() || `exit ${result.code}`}`, ["kill-session", "-t", session], result);
  }

  async reveal(session: string, parentTmux = process.env.TMUX): Promise<RevealResult> {
    validateSessionName(session);
    const attachArgv = Object.freeze([this.binary, "attach-session", "-t", session]);
    const attachCommand = attachArgv.map(shellQuote).join(" ");
    if (!parentTmux) return Object.freeze({ mode: "attach-command", argv: attachArgv, command: attachCommand });
    const socketPath = parentTmux.split(",", 1)[0];
    if (!isAbsolute(socketPath)) throw new TmuxTransportError("Unable to determine the parent tmux socket for reveal");
    const nestedAttachArgv = [this.binary, "-S", socketPath, "attach-session", "-t", session];
    const splitArgv = ["split-window", "-h", "-P", "-F", "#{pane_id}", "--", "env", "-u", "TMUX", ...nestedAttachArgv];
    const result = await this.execute(splitArgv);
    return Object.freeze({ mode: "split", paneId: result.stdout.trim(), argv: Object.freeze(splitArgv), command: attachCommand });
  }

  dispose(): void { this.ownedRunner?.dispose(); }
}
