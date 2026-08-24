import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Type from "typebox";
import { Check, Errors } from "typebox/value";
import { atomicWriteJson } from "./mailbox.ts";
import { WORKER_ADAPTERS, WORKER_SCHEMA_VERSION, type ResolvedWorkerPolicy, type WorkerAdapterConfig, type WorkerAdapterId, type WorkerConfig, type WorkerInvocationOverrides, type WorkerWorkflowConfig } from "./types.ts";
import { WorkerValidationError } from "./jobs.ts";

const AdapterIdSchema = Type.Union(WORKER_ADAPTERS.map((id) => Type.Literal(id)));
const RoutingOrderSchema = Type.Array(AdapterIdSchema, { minItems: 1, maxItems: WORKER_ADAPTERS.length, uniqueItems: true });
const ConcurrencySchema = Type.Integer({ minimum: 1, maximum: 32 });
const TimeoutSchema = Type.Integer({ minimum: 1_000, maximum: 86_400_000 });
const RetentionSchema = Type.Integer({ minimum: 0, maximum: 604_800_000 });
const StringMapSchema = Type.Record(Type.String(), Type.String());

export const WorkerWorkflowConfigSchema = Type.Object({
  concurrency: Type.Optional(ConcurrencySchema),
  timeoutMs: Type.Optional(TimeoutSchema),
  retentionMs: Type.Optional(RetentionSchema),
  routingOrder: Type.Optional(RoutingOrderSchema),
  allowFallback: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const WorkerAdapterConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String({ minLength: 1 })),
  interactiveArgs: Type.Optional(Type.Array(Type.String())),
  environment: Type.Optional(StringMapSchema),
  recognizedResponses: Type.Optional(StringMapSchema),
}, { additionalProperties: false });

export const WorkerConfigFileSchema = Type.Object({
  schemaVersion: Type.Optional(Type.Literal(WORKER_SCHEMA_VERSION)),
  routingOrder: Type.Optional(RoutingOrderSchema),
  concurrency: Type.Optional(ConcurrencySchema),
  timeoutMs: Type.Optional(TimeoutSchema),
  retentionMs: Type.Optional(RetentionSchema),
  allowFallback: Type.Optional(Type.Boolean()),
  maxModelOutputBytes: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 1_048_576 })),
  maxModelOutputLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  maxActiveWorkers: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
  maxSpawnsPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  maxSpawnsPerSession: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  adapters: Type.Optional(Type.Object({
    pi: Type.Optional(WorkerAdapterConfigSchema),
    claude: Type.Optional(WorkerAdapterConfigSchema),
    codex: Type.Optional(WorkerAdapterConfigSchema),
  }, { additionalProperties: false })),
  workflows: Type.Optional(Type.Record(Type.String({ minLength: 1 }), WorkerWorkflowConfigSchema)),
  sandbox: Type.Optional(Type.Object({
    requireBubblewrap: Type.Optional(Type.Boolean()),
    allowCopiedNonGitWrites: Type.Optional(Type.Boolean()),
    authReadOnlyPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const WorkerInvocationOverridesSchema = Type.Object({
  concurrency: Type.Optional(ConcurrencySchema),
  timeoutMs: Type.Optional(TimeoutSchema),
  retentionMs: Type.Optional(RetentionSchema),
  routingOrder: Type.Optional(RoutingOrderSchema),
  allowFallback: Type.Optional(Type.Boolean()),
  preferredCli: Type.Optional(AdapterIdSchema),
}, { additionalProperties: false });

const DEFAULT_ADAPTER: WorkerAdapterConfig = Object.freeze({ enabled: true, interactiveArgs: Object.freeze([]), environment: Object.freeze({}), recognizedResponses: Object.freeze({}) });
export const DEFAULT_WORKER_CONFIG: WorkerConfig = Object.freeze({
  schemaVersion: WORKER_SCHEMA_VERSION,
  routingOrder: Object.freeze(["pi", "claude", "codex"] as WorkerAdapterId[]),
  concurrency: 2,
  timeoutMs: 30 * 60_000,
  retentionMs: 15 * 60_000,
  allowFallback: true,
  maxModelOutputBytes: 50 * 1024,
  maxModelOutputLines: 2_000,
  maxActiveWorkers: 32,
  maxSpawnsPerRun: 64,
  maxSpawnsPerSession: 100,
  adapters: Object.freeze({ pi: DEFAULT_ADAPTER, claude: DEFAULT_ADAPTER, codex: DEFAULT_ADAPTER }),
  workflows: Object.freeze({}),
  sandbox: Object.freeze({ requireBubblewrap: true, allowCopiedNonGitWrites: false, authReadOnlyPaths: Object.freeze([]) }),
});

function assertValid(schema: object, input: unknown, label: string): void {
  if (Check(schema as never, input)) return;
  const issues = [...Errors(schema as never, input)].slice(0, 8).map((error) => `${"path" in error ? String(error.path) : "/"}: ${error.message}`);
  throw new WorkerValidationError(`Invalid ${label}`, issues);
}

function adapterConfig(raw: Partial<WorkerAdapterConfig> | undefined): WorkerAdapterConfig {
  return Object.freeze({
    enabled: raw?.enabled ?? DEFAULT_ADAPTER.enabled,
    ...(raw?.model ? { model: raw.model } : {}),
    interactiveArgs: Object.freeze([...(raw?.interactiveArgs ?? [])]),
    environment: Object.freeze({ ...(raw?.environment ?? {}) }),
    recognizedResponses: Object.freeze({ ...(raw?.recognizedResponses ?? {}) }),
  });
}

export function validateWorkerConfig(input: unknown): WorkerConfig {
  const raw = input ?? {};
  assertValid(WorkerConfigFileSchema, raw, "worker configuration");
  const value = raw as any;
  const workflows = Object.fromEntries(Object.entries(value.workflows ?? {}).map(([id, config]) => [id, Object.freeze({ ...(config as object), ...((config as any).routingOrder ? { routingOrder: Object.freeze([...(config as any).routingOrder]) } : {}) })]));
  return Object.freeze({
    schemaVersion: WORKER_SCHEMA_VERSION,
    routingOrder: Object.freeze([...(value.routingOrder ?? DEFAULT_WORKER_CONFIG.routingOrder)]),
    concurrency: value.concurrency ?? DEFAULT_WORKER_CONFIG.concurrency,
    timeoutMs: value.timeoutMs ?? DEFAULT_WORKER_CONFIG.timeoutMs,
    retentionMs: value.retentionMs ?? DEFAULT_WORKER_CONFIG.retentionMs,
    allowFallback: value.allowFallback ?? DEFAULT_WORKER_CONFIG.allowFallback,
    maxModelOutputBytes: value.maxModelOutputBytes ?? DEFAULT_WORKER_CONFIG.maxModelOutputBytes,
    maxModelOutputLines: value.maxModelOutputLines ?? DEFAULT_WORKER_CONFIG.maxModelOutputLines,
    maxActiveWorkers: value.maxActiveWorkers ?? DEFAULT_WORKER_CONFIG.maxActiveWorkers,
    maxSpawnsPerRun: value.maxSpawnsPerRun ?? DEFAULT_WORKER_CONFIG.maxSpawnsPerRun,
    maxSpawnsPerSession: value.maxSpawnsPerSession ?? DEFAULT_WORKER_CONFIG.maxSpawnsPerSession,
    adapters: Object.freeze({ pi: adapterConfig(value.adapters?.pi), claude: adapterConfig(value.adapters?.claude), codex: adapterConfig(value.adapters?.codex) }),
    workflows: Object.freeze(workflows),
    sandbox: Object.freeze({
      requireBubblewrap: value.sandbox?.requireBubblewrap ?? true,
      allowCopiedNonGitWrites: value.sandbox?.allowCopiedNonGitWrites ?? false,
      authReadOnlyPaths: Object.freeze([...(value.sandbox?.authReadOnlyPaths ?? [])]),
    }),
  });
}

export function workersConfigPath(): string { return join(getAgentDir(), "chrysaki-workers.json"); }

export async function loadWorkerConfig(path = workersConfigPath()): Promise<WorkerConfig> {
  try { return validateWorkerConfig(JSON.parse(await readFile(path, "utf8"))); }
  catch (error: any) {
    if (error?.code === "ENOENT") return validateWorkerConfig({});
    if (error instanceof WorkerValidationError) throw error;
    throw new WorkerValidationError(`Unable to load worker configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveWorkerConfig(config: WorkerConfig, path = workersConfigPath()): Promise<void> {
  const validated = validateWorkerConfig(config);
  await atomicWriteJson(path, validated);
}

export function validateInvocationOverrides(input: unknown): WorkerInvocationOverrides {
  const raw = input ?? {};
  assertValid(WorkerInvocationOverridesSchema, raw, "worker invocation overrides");
  return Object.freeze({ ...(raw as WorkerInvocationOverrides) });
}

export function resolveWorkerPolicy(config: WorkerConfig, workflowId?: string, invocationInput: unknown = {}): ResolvedWorkerPolicy {
  const invocation = validateInvocationOverrides(invocationInput);
  const workflow: WorkerWorkflowConfig | undefined = workflowId ? config.workflows[workflowId] : undefined;
  const pick = <K extends "concurrency" | "timeoutMs" | "retentionMs" | "allowFallback">(key: K, globalValue: NonNullable<WorkerWorkflowConfig[K]>) => {
    if (invocation[key] !== undefined) return { value: invocation[key] as NonNullable<WorkerWorkflowConfig[K]>, source: "invocation" as const };
    if (workflow?.[key] !== undefined) return { value: workflow[key] as NonNullable<WorkerWorkflowConfig[K]>, source: "workflow" as const };
    return { value: globalValue, source: "global" as const };
  };
  const concurrency = pick("concurrency", config.concurrency); const timeoutMs = pick("timeoutMs", config.timeoutMs);
  const retentionMs = pick("retentionMs", config.retentionMs); const allowFallback = pick("allowFallback", config.allowFallback);
  let routingOrder: readonly WorkerAdapterId[]; let routingSource: "invocation" | "workflow" | "global";
  if (invocation.preferredCli) {
    const base = invocation.routingOrder ?? workflow?.routingOrder ?? config.routingOrder;
    routingOrder = Object.freeze([invocation.preferredCli, ...base.filter((id) => id !== invocation.preferredCli)]); routingSource = "invocation";
  } else if (invocation.routingOrder) { routingOrder = invocation.routingOrder; routingSource = "invocation"; }
  else if (workflow?.routingOrder) { routingOrder = workflow.routingOrder; routingSource = "workflow"; }
  else { routingOrder = config.routingOrder; routingSource = "global"; }
  return Object.freeze({ concurrency: concurrency.value, timeoutMs: timeoutMs.value, retentionMs: retentionMs.value, routingOrder: Object.freeze([...routingOrder]), allowFallback: allowFallback.value, source: Object.freeze({ concurrency: concurrency.source, timeoutMs: timeoutMs.source, retentionMs: retentionMs.source, routingOrder: routingSource, allowFallback: allowFallback.source }) });
}
