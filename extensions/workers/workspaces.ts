import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cp } from "node:fs/promises";
import { BoundedProcessRunner, type ProcessResult, type ProcessRunner } from "../runtime/process.ts";
import { atomicWriteJson } from "./mailbox.ts";
import { validateWorkspaceLease, WorkerValidationError } from "./jobs.ts";
import { createWorkerId, type WorkerAccessMode, type WorkspaceLease } from "./types.ts";

export interface WorkspaceManagerOptions {
  readonly root: string;
  readonly gitBinary?: string;
  readonly runner?: ProcessRunner;
  readonly allowCopiedNonGitWrites?: boolean;
}

export interface WorkspaceLeaseRequest {
  readonly jobId: string;
  readonly sourcePath: string;
  readonly mode: WorkerAccessMode;
}

export interface WorkspaceCleanupResult {
  readonly removed: boolean;
  readonly retained: boolean;
  readonly dirty: boolean;
  readonly reason?: string;
}

export class WorkspaceError extends Error {
  constructor(message: string, readonly result?: ProcessResult) { super(message); this.name = "WorkspaceError"; }
}

const JOB_ID_PATTERN = /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate); return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

export class WorkspaceManager {
  readonly root: string;
  private readonly gitBinary: string;
  private readonly runner: ProcessRunner;
  private readonly allowCopies: boolean;
  private readonly ownedRunner?: BoundedProcessRunner;

  constructor(options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.root)) throw new WorkspaceError("Workspace root must be absolute");
    this.root = resolve(options.root); this.gitBinary = options.gitBinary ?? "git";
    this.allowCopies = options.allowCopiedNonGitWrites ?? false;
    if (options.runner) this.runner = options.runner;
    else { this.ownedRunner = new BoundedProcessRunner(); this.runner = this.ownedRunner.run; }
  }

  private paths(jobId: string) {
    if (!JOB_ID_PATTERN.test(jobId)) throw new WorkspaceError("Invalid worker job ID for workspace");
    const ownerDirectory = join(this.root, jobId); const checkout = join(ownerDirectory, "checkout");
    if (!contained(this.root, ownerDirectory)) throw new WorkspaceError("Workspace path escapes managed root");
    return { ownerDirectory, checkout, record: join(ownerDirectory, "lease.json") };
  }

  private async git(args: readonly string[], allowFailure = false): Promise<ProcessResult> {
    const result = await this.runner(this.gitBinary, args, { timeoutMs: 30_000, maxBytes: 256_000 });
    if (!allowFailure && result.code !== 0) throw new WorkspaceError(`git ${args[0] ?? "command"} failed: ${result.stderr.trim() || `exit ${result.code}`}`, result);
    return result;
  }

  private async gitRoot(sourcePath: string): Promise<string | undefined> {
    const result = await this.git(["-C", sourcePath, "rev-parse", "--show-toplevel"], true);
    if (result.code !== 0) return undefined;
    const root = result.stdout.trim();
    return root && isAbsolute(root) ? realpath(root) : undefined;
  }

  async create(request: WorkspaceLeaseRequest): Promise<WorkspaceLease> {
    const paths = this.paths(request.jobId); const source = await realpath(request.sourcePath);
    if (!(await stat(source)).isDirectory()) throw new WorkspaceError("Workspace source must be a directory");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { await mkdir(paths.ownerDirectory, { mode: 0o700 }); }
    catch (error: any) { if (error?.code === "EEXIST") throw new WorkspaceError(`Workspace already exists for ${request.jobId}`); throw error; }
    let repository: string | undefined; let worktreeCreated = false;
    try {
      repository = await this.gitRoot(source); const createdAt = new Date().toISOString();
      let lease: WorkspaceLease;
      if (request.mode === "read") {
        lease = { mode: "read", sourcePath: repository ?? source, workspacePath: repository ?? source, owningJobId: request.jobId, kind: "readonly-bind", dirty: false, cleanupEligible: true, createdAt };
      } else if (repository) {
        const baseRevision = (await this.git(["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
        await this.git(["-C", repository, "worktree", "add", "--detach", paths.checkout, baseRevision]); worktreeCreated = true;
        lease = { mode: "write", sourcePath: repository, workspacePath: paths.checkout, owningJobId: request.jobId, kind: "git-worktree", dirty: false, cleanupEligible: true, baseRevision, createdAt };
      } else {
        if (!this.allowCopies) throw new WorkspaceError("Write workers require a Git repository unless copied non-Git workspaces are explicitly enabled");
        await cp(source, paths.checkout, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        // A copied workspace has no reliable baseline/index. Retain it by default so automatic cleanup cannot lose edits.
        lease = { mode: "write", sourcePath: source, workspacePath: paths.checkout, owningJobId: request.jobId, kind: "copy", dirty: true, cleanupEligible: false, createdAt };
      }
      validateWorkspaceLease(lease);
      await atomicWriteJson(paths.record, lease);
      return Object.freeze(lease);
    } catch (error) {
      if (worktreeCreated && repository) await this.git(["-C", repository, "worktree", "remove", "--force", paths.checkout], true).catch(() => undefined);
      await rm(paths.ownerDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async load(jobId: string): Promise<WorkspaceLease> {
    const paths = this.paths(jobId); let parsed: unknown;
    try { parsed = JSON.parse(await readFile(paths.record, "utf8")); }
    catch (error) { throw new WorkspaceError(`Unable to load workspace ownership record: ${error instanceof Error ? error.message : String(error)}`); }
    let lease: WorkspaceLease;
    try { lease = validateWorkspaceLease(parsed); }
    catch (error) { throw new WorkspaceError(`Invalid workspace ownership record: ${error instanceof Error ? error.message : String(error)}`); }
    if (lease.owningJobId !== jobId) throw new WorkspaceError("Workspace ownership record does not match job");
    if (lease.kind !== "readonly-bind" && resolve(lease.workspacePath) !== paths.checkout) throw new WorkspaceError("Workspace ownership path does not match managed checkout");
    return lease;
  }

  async inspectDirty(leaseInput: WorkspaceLease): Promise<WorkspaceLease> {
    const lease = validateWorkspaceLease(leaseInput);
    if (lease.kind === "readonly-bind") return Object.freeze({ ...lease, dirty: false, cleanupEligible: true });
    if (lease.kind === "copy") return Object.freeze({ ...lease, dirty: true, cleanupEligible: false });
    const [statusResult, headResult] = await Promise.all([
      this.git(["-C", lease.workspacePath, "status", "--porcelain=v1", "--untracked-files=all"], true),
      this.git(["-C", lease.workspacePath, "rev-parse", "HEAD"], true),
    ]);
    if (statusResult.code !== 0) throw new WorkspaceError("Unable to inspect worker worktree dirtiness", statusResult);
    if (headResult.code !== 0) throw new WorkspaceError("Unable to inspect worker worktree revision", headResult);
    const dirty = statusResult.stdout.length > 0 || headResult.stdout.trim() !== lease.baseRevision;
    return Object.freeze({ ...lease, dirty, cleanupEligible: !dirty });
  }

  async cleanup(jobId: string, options: { readonly force?: boolean } = {}): Promise<WorkspaceCleanupResult> {
    const paths = this.paths(jobId); const loaded = await this.load(jobId); const lease = await this.inspectDirty(loaded);
    if (lease.dirty && !options.force) {
      await atomicWriteJson(paths.record, lease);
      return Object.freeze({ removed: false, retained: true, dirty: true, reason: "Workspace contains unintegrated changes" });
    }
    const ownerInfo = await lstat(paths.ownerDirectory);
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isDirectory()) throw new WorkspaceError("Refusing to clean an unsafe workspace owner path");
    if (lease.kind === "git-worktree") {
      await this.git(["-C", lease.sourcePath, "worktree", "remove", "--force", lease.workspacePath]);
      await this.git(["-C", lease.sourcePath, "worktree", "prune"], true);
    }
    await rm(paths.ownerDirectory, { recursive: true, force: true });
    return Object.freeze({ removed: true, retained: false, dirty: lease.dirty });
  }

  async abandonFailedCreate(jobId: string): Promise<void> {
    const paths = this.paths(jobId);
    // This only removes a record directory before a validated lease is returned; never use it for completed jobs.
    const info = await lstat(paths.ownerDirectory).catch(() => undefined);
    if (info && !info.isSymbolicLink() && info.isDirectory()) await rm(paths.ownerDirectory, { recursive: true, force: true });
  }

  dispose(): void { this.ownedRunner?.dispose(); }
}

export function createWorkspaceJobId(): string { return createWorkerId(); }
