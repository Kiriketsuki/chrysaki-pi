import { access, chmod, cp, lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { BoundedProcessRunner, type ProcessResult, type ProcessRunner } from "../runtime/process.ts";
import { validateWorkspaceLease } from "./jobs.ts";
import type { AdapterAuthBinding, WorkspaceLease } from "./types.ts";

export interface SandboxManagerOptions {
  readonly binary?: string;
  readonly runner?: ProcessRunner;
  readonly runtimeReadOnlyPaths?: readonly string[];
}

export interface SandboxRequest {
  readonly jobId: string;
  readonly lease: WorkspaceLease;
  readonly mailboxPath: string;
  readonly cwd: string;
  readonly authReadOnlyPaths?: readonly (string | AdapterAuthBinding)[];
  readonly runtimeReadOnlyPaths?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface SandboxMount { readonly hostPath: string; readonly guestPath: string; readonly writable: boolean; }
export interface SandboxProfile {
  readonly active: true;
  readonly jobId: string;
  readonly binary: string;
  readonly homePath: string;
  readonly guestCwd: string;
  readonly mounts: readonly SandboxMount[];
  readonly baseArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly authPaths: readonly SandboxMount[];
}

export interface SandboxPreflight { readonly available: boolean; readonly usable: boolean; readonly version?: string; readonly reason?: string; }

export class SandboxError extends Error {
  constructor(message: string, readonly result?: ProcessResult) { super(message); this.name = "SandboxError"; }
}

const JOB_ID_PATTERN = /^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STANDARD_RUNTIME_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"] as const;

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch { return false; } }

async function gitCommonDirectory(worktree: string): Promise<string | undefined> {
  const dotGit = join(worktree, ".git");
  let info;
  try { info = await lstat(dotGit); } catch { return undefined; }
  if (info.isDirectory()) return realpath(dotGit);
  if (!info.isFile()) return undefined;
  const match = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(dotGit, "utf8"));
  if (!match) return undefined;
  const gitDirectory = resolve(worktree, match[1]);
  try {
    const common = (await readFile(join(gitDirectory, "commondir"), "utf8")).trim();
    return realpath(resolve(gitDirectory, common));
  } catch { return realpath(gitDirectory); }
}

function validateEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new SandboxError(`Invalid sandbox environment entry: ${key}`);
  }
}

export class SandboxManager {
  readonly binary: string;
  private readonly runner: ProcessRunner;
  private readonly defaultRuntimePaths: readonly string[];
  private readonly ownedRunner?: BoundedProcessRunner;

  constructor(options: SandboxManagerOptions = {}) {
    this.binary = options.binary ?? "bwrap"; this.defaultRuntimePaths = Object.freeze([...(options.runtimeReadOnlyPaths ?? [])]);
    if (!this.binary || this.binary.includes("\0")) throw new SandboxError("Invalid Bubblewrap executable");
    if (options.runner) this.runner = options.runner;
    else { this.ownedRunner = new BoundedProcessRunner(); this.runner = this.ownedRunner.run; }
  }

  async preflight(): Promise<SandboxPreflight> {
    let version: ProcessResult;
    try { version = await this.runner(this.binary, ["--version"], { timeoutMs: 3_000, maxBytes: 8_192 }); }
    catch (error) { return Object.freeze({ available: false, usable: false, reason: error instanceof Error ? error.message : String(error) }); }
    if (version.code !== 0) return Object.freeze({ available: false, usable: false, reason: version.stderr.trim() || `exit ${version.code}` });
    // The probe launches only /bin/true; the broad read-only bind checks kernel/user-namespace support, not the worker mount policy.
    const probe = await this.runner(this.binary, ["--unshare-all", "--share-net", "--ro-bind", "/", "/", "--", "/bin/true"], { timeoutMs: 5_000, maxBytes: 8_192 });
    if (probe.code !== 0) return Object.freeze({ available: true, usable: false, version: version.stdout.trim(), reason: probe.stderr.trim() || `exit ${probe.code}` });
    return Object.freeze({ available: true, usable: true, version: version.stdout.trim() });
  }

  private async copyAuthState(homePath: string, paths: readonly (string | AdapterAuthBinding)[]): Promise<readonly SandboxMount[]> {
    const authRoot = join(homePath, ".chrysaki-auth"); await mkdir(authRoot, { recursive: true, mode: 0o700 });
    const mounts: SandboxMount[] = [];
    for (let index = 0; index < paths.length; index++) {
      const binding = typeof paths[index] === "string" ? undefined : paths[index] as AdapterAuthBinding;
      const requestedSource = typeof paths[index] === "string" ? paths[index] as string : binding!.hostPath;
      const source = await realpath(requestedSource); const info = await lstat(source);
      if (!info.isFile() && !info.isDirectory()) throw new SandboxError(`Unsupported authentication path: ${requestedSource}`);
      const target = join(authRoot, `${index}-${basename(source)}`);
      await cp(source, target, { recursive: info.isDirectory(), preserveTimestamps: true, dereference: false, errorOnExist: true, force: false });
      if (info.isFile()) await chmod(target, 0o600);
      const guestPath = binding?.guestPath ?? `/home/worker/auth/${index}-${basename(source)}`;
      if (guestPath !== "/home/worker" && !guestPath.startsWith("/home/worker/")) throw new SandboxError(`Authentication mount must stay inside the ephemeral worker home: ${guestPath}`);
      const guestRelative = relative("/home/worker", guestPath);
      const guestBackingPath = join(homePath, ...guestRelative.split("/"));
      await mkdir(info.isDirectory() ? guestBackingPath : dirname(guestBackingPath), { recursive: true, mode: 0o700 });
      if (info.isFile() && !(await exists(guestBackingPath))) await writeFile(guestBackingPath, "", { mode: 0o600 });
      mounts.push(Object.freeze({ hostPath: target, guestPath, writable: false }));
    }
    return Object.freeze(mounts);
  }

  async createProfile(request: SandboxRequest): Promise<SandboxProfile> {
    if (!JOB_ID_PATTERN.test(request.jobId) || request.lease.owningJobId !== request.jobId) throw new SandboxError("Sandbox lease ownership does not match job");
    const lease = validateWorkspaceLease(request.lease);
    const mailbox = await realpath(request.mailboxPath); const workspace = await realpath(lease.workspacePath); const cwd = await realpath(request.cwd);
    if (basename(mailbox) !== request.jobId) throw new SandboxError("Sandbox mailbox does not match job ID");
    if (!isContained(await realpath(lease.sourcePath), cwd)) throw new SandboxError("Worker cwd is outside its source checkout");
    if (isContained(workspace, mailbox) || isContained(mailbox, workspace)) throw new SandboxError("Mailbox and workspace mounts must not overlap");
    const relativeCwd = relative(await realpath(lease.sourcePath), cwd);
    const guestCwd = relativeCwd ? posix.join("/workspace", ...relativeCwd.split(sep)) : "/workspace";
    const runtimeRoot = join(mailbox, "runtime"); const homePath = join(runtimeRoot, "home");
    await mkdir(homePath, { recursive: true, mode: 0o700 }); await chmod(runtimeRoot, 0o700); await chmod(homePath, 0o700);
    const authPaths = await this.copyAuthState(homePath, request.authReadOnlyPaths ?? []);
    const environment = Object.freeze({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TERM: process.env.TERM ?? "xterm-256color",
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: "/home/worker",
      XDG_CONFIG_HOME: "/home/worker/.config",
      XDG_CACHE_HOME: "/home/worker/.cache",
      CHRYSAKI_WORKSPACE: "/workspace",
      CHRYSAKI_MAILBOX: "/mailbox",
      CHRYSAKI_WORKER_JOB_ID: request.jobId,
      CHRYSAKI_CONFINED: "1",
      CHRYSAKI_AUTH_PATHS: JSON.stringify(authPaths.map((mount) => mount.guestPath)),
      ...(request.environment ?? {}),
    });
    validateEnvironment(environment);

    // Do not use Bubblewrap's --new-session here. Workers already run in a
    // dedicated tmux PTY; setsid() would detach that controlling terminal and
    // interactive model CLIs exit during startup when /dev/tty is unavailable.
    const args: string[] = ["--unshare-all", "--share-net", "--die-with-parent"];
    for (const path of STANDARD_RUNTIME_PATHS) {
      if (!(await exists(path))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) args.push("--symlink", await readlink(path), path);
      else args.push("--ro-bind", path, path);
    }
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/worker", "--bind", homePath, "/home/worker", "--dir", "/workspace");
    args.push(lease.mode === "read" ? "--ro-bind" : "--bind", workspace, "/workspace");
    args.push("--dir", "/mailbox", "--bind", mailbox, "/mailbox");

    const gitMetadata = lease.kind === "git-worktree" ? await gitCommonDirectory(workspace) : undefined;
    if (lease.kind === "git-worktree" && !gitMetadata) throw new SandboxError("Unable to expose read-only Git metadata for worker worktree");
    const runtimePaths = [...this.defaultRuntimePaths, ...(request.runtimeReadOnlyPaths ?? []), ...(gitMetadata ? [gitMetadata] : [])];
    const mountedRuntime = new Set<string>();
    for (const requestedPath of runtimePaths) {
      const hostPath = await realpath(requestedPath);
      if (mountedRuntime.has(hostPath) || STANDARD_RUNTIME_PATHS.some((root) => isContained(root, hostPath))) continue;
      mountedRuntime.add(hostPath);
      const parents: string[] = []; let parent = dirname(hostPath);
      while (parent !== "/" && !STANDARD_RUNTIME_PATHS.some((root) => isContained(root, parent))) { parents.push(parent); parent = dirname(parent); }
      for (const directory of parents.reverse()) args.push("--dir", directory);
      args.push("--ro-bind", hostPath, hostPath);
    }
    for (const auth of authPaths) {
      args.push("--ro-bind", auth.hostPath, auth.guestPath);
      // The home also appears beneath the writable mailbox mount; cover that alias with the same read-only bind.
      const homeRelative = relative("/home/worker", auth.guestPath).split(sep).join("/");
      args.push("--ro-bind", auth.hostPath, `/mailbox/runtime/home/${homeRelative}`);
    }
    args.push("--chdir", guestCwd, "--clearenv");
    for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
    const mounts: readonly SandboxMount[] = Object.freeze([
      Object.freeze({ hostPath: workspace, guestPath: "/workspace", writable: lease.mode === "write" }),
      Object.freeze({ hostPath: mailbox, guestPath: "/mailbox", writable: true }),
      Object.freeze({ hostPath: homePath, guestPath: "/home/worker", writable: true }),
      ...authPaths,
    ]);
    return Object.freeze({ active: true, jobId: request.jobId, binary: this.binary, homePath, guestCwd, mounts, baseArgs: Object.freeze(args), environment, authPaths });
  }

  buildArgv(profile: SandboxProfile, command: readonly [string, ...string[]]): readonly [string, ...string[]] {
    if (!profile.active || profile.binary !== this.binary || !command.length || command.some((part) => part.includes("\0"))) throw new SandboxError("Invalid confined launch request");
    return Object.freeze([this.binary, ...profile.baseArgs, "--", ...command]) as readonly [string, ...string[]];
  }

  dispose(): void { this.ownedRunner?.dispose(); }
}
