import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { WorkerBroker } from "./broker.ts";
import { loadWorkerConfig } from "./config.ts";
import type { WorkerConfig } from "./types.ts";
import { PiWorkerAdapter, ClaudeWorkerAdapter, CodexWorkerAdapter } from "./adapters/index.ts";
import { WorkerRouter } from "./router.ts";
import { SandboxManager } from "./sandbox.ts";
import { TmuxTransport } from "./tmux.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { parseInheritedWorkerContext } from "./capability-ceiling.ts";

export interface ChrysakiWorkerRuntimeOptions {
  readonly config?: WorkerConfig;
  readonly agentDirectory?: string;
}

export class ChrysakiWorkerRuntime {
  readonly broker: WorkerBroker;
  private disposed = false;
  constructor(
    broker: WorkerBroker,
    private readonly tmux: TmuxTransport,
    private readonly sandbox: SandboxManager,
    private readonly workspaces: WorkspaceManager,
  ) { this.broker = broker; }

  async start() { return this.broker.reconcile(); }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.broker.dispose(); this.tmux.dispose(); this.sandbox.dispose(); this.workspaces.dispose();
  }
}

export async function createChrysakiWorkerRuntime(options: ChrysakiWorkerRuntimeOptions = {}): Promise<ChrysakiWorkerRuntime> {
  const config = options.config ?? await loadWorkerConfig(); const agentDirectory = options.agentDirectory ?? getAgentDir();
  const tmux = new TmuxTransport();
  const sandbox = new SandboxManager();
  const workspaces = new WorkspaceManager({ root: join(agentDirectory, "workers", "workspaces"), allowCopiedNonGitWrites: config.sandbox.allowCopiedNonGitWrites });
  const adapterOptions = (id: "pi" | "claude" | "codex") => ({
    environment: { ...process.env, ...config.adapters[id].environment },
    recognizedResponses: config.adapters[id].recognizedResponses,
    interrupt: (session: string, signal?: AbortSignal) => signal?.aborted ? Promise.reject(signal.reason) : tmux.interrupt(session),
  });
  const adapters = [new PiWorkerAdapter(adapterOptions("pi")), new ClaudeWorkerAdapter(adapterOptions("claude")), new CodexWorkerAdapter(adapterOptions("codex"))];
  const router = new WorkerRouter({ config, adapters, sandbox });
  const inherited = parseInheritedWorkerContext();
  const broker = new WorkerBroker({ config, router, workspaces, sandbox, tmux, jobsRoot: join(agentDirectory, "workers", "jobs"), archiveRoot: join(agentDirectory, "workers", "archive"), inheritedCeiling: inherited.ceiling });
  return new ChrysakiWorkerRuntime(broker, tmux, sandbox, workspaces);
}
