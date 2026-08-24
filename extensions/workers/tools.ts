import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Type from "typebox";
import type { WorkerBatchResult, WorkerBroker, WorkerJobResult } from "./broker.ts";
import { renderWorkerCall, renderWorkerResult, summarizeWorker, type WorkerToolDetails } from "./render.ts";
import { WORKER_ADAPTERS, WORKER_STATES } from "./types.ts";
import { parseInheritedWorkerContext } from "./capability-ceiling.ts";

const AccessSchema = StringEnum(["read", "write"] as const);
const AdapterSchema = StringEnum(WORKER_ADAPTERS);
const CompletionSchema = StringEnum(["all", "any"] as const);
const StateSchema = StringEnum(WORKER_STATES);
const JobIdsSchema = Type.Array(Type.String({ pattern: "^wrk_[0-9a-f-]+$" }), { minItems: 1, maxItems: 32, uniqueItems: true });

const DispatchSchema = Type.Object({
  task: Type.Optional(Type.String({ minLength: 1 })),
  tasks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
  access: AccessSchema,
  capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  preferredCli: Type.Optional(AdapterSchema),
  allowFallback: Type.Optional(Type.Boolean()),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })),
  retentionMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800_000 })),
  workflow: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

function bounded(value: string, maxBytes = 50 * 1024, maxLines = 2_000): string {
  const notice = "\n[Model-visible worker output truncated; full artifacts remain in the mailbox.]";
  const lines = value.split("\n"); let truncated = lines.length > maxLines;
  let output = lines.slice(0, truncated ? Math.max(1, maxLines - 1) : maxLines).join("\n");
  const contentLimit = maxBytes - Buffer.byteLength(notice);
  if (Buffer.byteLength(output) > contentLimit) {
    output = Buffer.from(output).subarray(0, contentLimit).toString("utf8");
    while (Buffer.byteLength(output) > contentLimit) output = output.slice(0, -1);
    truncated = true;
  }
  return truncated ? `${output}${notice}` : output;
}

function jobText(operation: string, jobs: readonly WorkerJobResult[]): string {
  const sections = jobs.map((entry) => {
    const heading = `${entry.job.id} · ${entry.status.state}${entry.job.selectedAdapter ? ` · ${entry.job.selectedAdapter}` : ""}`;
    const body = entry.result ?? entry.status.progress ?? entry.status.failure?.message ?? "No authoritative result yet.";
    const artifact = entry.resultTruncated && entry.resultPath ? `\n[Full result: ${entry.resultPath}]` : "";
    return `${heading}\n${body}${artifact}`;
  });
  return bounded(`${operation}: ${jobs.length} worker${jobs.length === 1 ? "" : "s"}\n\n${sections.join("\n\n")}`);
}

function details(operation: string, jobs: readonly WorkerJobResult[], concurrency?: number): WorkerToolDetails {
  return Object.freeze({ operation, summaries: Object.freeze(jobs.map((job) => summarizeWorker(job))), ...(concurrency !== undefined ? { concurrency } : {}) });
}

function toolResult(operation: string, jobs: readonly WorkerJobResult[], concurrency?: number) {
  return { content: [{ type: "text" as const, text: jobText(operation, jobs) }], details: details(operation, jobs, concurrency) };
}

function renderer(name: string) {
  return {
    renderCall(args: Record<string, unknown>, theme: any, context: any) { return renderWorkerCall(name, args, theme, context.lastComponent); },
    renderResult(result: any, options: any, theme: any, context: any) { return renderWorkerResult(result, options, theme, context.lastComponent); },
  };
}

export function registerWorkerTools(pi: ExtensionAPI | any, getBroker: () => WorkerBroker): void {
  const dispatch = (params: any, cwd: string) => ({ ...params, cwd });
  const inherited = parseInheritedWorkerContext();
  const ownership = (toolCallId: string, ctx: any) => ({ ownerId: toolCallId, parentSessionId: ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getSessionId?.() ?? `ephemeral:${ctx.cwd}`, depth: inherited.depth, ...(inherited.parentRunId ? { parentRunId: inherited.parentRunId } : {}), ...(inherited.ceiling ? { capabilityCeiling: inherited.ceiling } : {}) });
  pi.registerTool({
    name: "worker_preflight", label: "Chrysaki Worker Preflight", description: "Resolve worker admission, capability ceiling, confinement, routing, model, and task digests without launching workers or creating artifacts.",
    parameters: DispatchSchema, ...renderer("preflight"),
    async execute(id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const result = await getBroker().preflight(dispatch(params, ctx.cwd), { signal, ...ownership(id, ctx) });
      return { content: [{ type: "text" as const, text: bounded(`worker_preflight: ${result.requested} task${result.requested === 1 ? "" : "s"}\n${JSON.stringify(result, null, 2)}`) }], details: { operation: "preflight", summaries: [] } };
    },
  });
  pi.registerTool({
    name: "worker_run", label: "Chrysaki Worker Run", description: "Run one or more model tasks in sandboxed interactive tmux workers and wait for authoritative mailbox results. Output is bounded; full artifacts remain on disk.",
    promptSnippet: "Run delegated model work in interactive sandboxed tmux workers",
    promptGuidelines: ["Use worker_run instead of invoking Pi, Claude, Codex, or another model CLI through bash."],
    parameters: DispatchSchema, ...renderer("run"),
    async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      onUpdate?.({ content: [{ type: "text", text: "Starting interactive Chrysaki workers…" }], details: { operation: "run", summaries: [] } });
      const result: WorkerBatchResult = await getBroker().run(dispatch(params, ctx.cwd), { signal, ...ownership(id, ctx) }); return toolResult("worker_run", result.jobs, result.concurrency);
    },
  });
  pi.registerTool({
    name: "worker_spawn", label: "Chrysaki Worker Spawn", description: "Start one or more sandboxed interactive tmux model workers and return after startup.", parameters: DispatchSchema, ...renderer("spawn"),
    async execute(id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { const result = await getBroker().spawn(dispatch(params, ctx.cwd), { signal, ...ownership(id, ctx) }); return toolResult("worker_spawn", result.jobs, result.concurrency); },
  });
  pi.registerTool({
    name: "worker_wait", label: "Chrysaki Worker Wait", description: "Wait for authoritative terminal mailbox states for worker jobs.",
    parameters: Type.Object({ jobIds: JobIdsSchema, completion: Type.Optional(CompletionSchema), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })) }, { additionalProperties: false }), ...renderer("wait"),
    async execute(_id: string, params: any, signal: AbortSignal | undefined) { if (params.count !== undefined && params.completion !== undefined) throw new Error("worker_wait accepts completion or count, not both"); const jobs = await getBroker().wait({ jobIds: params.jobIds, completion: params.count ?? params.completion ?? "all", timeoutMs: params.timeoutMs, signal }); return toolResult("worker_wait", jobs); },
  });
  pi.registerTool({
    name: "worker_status", label: "Chrysaki Worker Status", description: "Read persisted worker states without scraping tmux panes.",
    parameters: Type.Object({ jobIds: Type.Optional(JobIdsSchema), states: Type.Optional(Type.Array(StateSchema, { uniqueItems: true })) }, { additionalProperties: false }), ...renderer("status"),
    async execute(_id: string, params: any) { let jobs = await getBroker().status(params.jobIds); if (params.states?.length) { const states = new Set(params.states); jobs = jobs.filter((job) => states.has(job.status.state)); } return toolResult("worker_status", jobs); },
  });
  pi.registerTool({
    name: "worker_send", label: "Chrysaki Worker Send", description: "Send a follow-up prompt through a private tmux paste buffer.",
    parameters: Type.Object({ jobId: Type.String({ pattern: "^wrk_[0-9a-f-]+$" }), prompt: Type.String({ minLength: 1 }) }, { additionalProperties: false }), ...renderer("send"),
    async execute(_id: string, params: any) { await getBroker().send(params.jobId, params.prompt); const jobs = await getBroker().status([params.jobId]); return toolResult("worker_send", jobs); },
  });
  pi.registerTool({
    name: "worker_reveal", label: "Chrysaki Worker Reveal", description: "Reveal a retained worker in a tmux split or return an exact safe attach command.",
    parameters: Type.Object({ jobId: Type.String({ pattern: "^wrk_[0-9a-f-]+$" }) }, { additionalProperties: false }), ...renderer("reveal"),
    async execute(_id: string, params: any) { const reveal = await getBroker().reveal(params.jobId); const jobs = await getBroker().status([params.jobId]); const value: WorkerToolDetails = { ...details("worker_reveal", jobs), reveal: { mode: reveal.mode, command: reveal.command, ...(reveal.paneId ? { paneId: reveal.paneId } : {}) } }; return { content: [{ type: "text", text: reveal.mode === "split" ? `Revealed ${params.jobId} in ${reveal.paneId ?? "a tmux split"}.` : reveal.command }], details: value }; },
  });
  pi.registerTool({
    name: "worker_cancel", label: "Chrysaki Worker Cancel", description: "Interrupt workers and persist cancellation before grace retention.",
    parameters: Type.Object({ jobIds: JobIdsSchema, reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })) }, { additionalProperties: false }), ...renderer("cancel"),
    async execute(_id: string, params: any) { const jobs = await getBroker().cancel(params.jobIds, params.reason); return toolResult("worker_cancel", jobs); },
  });
}
