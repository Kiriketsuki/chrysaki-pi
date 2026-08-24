import { randomUUID } from "node:crypto";
import * as Type from "typebox";

export const WORKER_SCHEMA_VERSION = 1 as const;
export const WORKER_STATES = ["queued", "starting", "ready", "running", "blocked", "completed", "failed", "timed_out", "cancelled"] as const;
export const TERMINAL_WORKER_STATES = ["completed", "failed", "timed_out", "cancelled"] as const;
export const WORKER_ADAPTERS = ["pi", "claude", "codex"] as const;
export const ACCESS_MODES = ["read", "write"] as const;

export type WorkerState = (typeof WORKER_STATES)[number];
export type TerminalWorkerState = (typeof TERMINAL_WORKER_STATES)[number];
export type WorkerAdapterId = (typeof WORKER_ADAPTERS)[number];
export type WorkerAccessMode = (typeof ACCESS_MODES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema = Type.Unknown();
const TimestampSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" });
const JobIdSchema = Type.String({ pattern: "^wrk_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" });
const NonEmptyString = Type.String({ minLength: 1 });
const RunIdSchema = Type.String({ pattern: "^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" });
const StringMapSchema = Type.Record(Type.String(), Type.String());

export const WorkerRequestSchema = Type.Object({
  task: NonEmptyString,
  role: Type.Optional(NonEmptyString),
  capabilities: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
  access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  preferredCli: Type.Optional(Type.Union(WORKER_ADAPTERS.map((id) => Type.Literal(id)))),
  allowFallback: Type.Optional(Type.Boolean()),
  cwd: NonEmptyString,
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
  retentionMs: Type.Optional(Type.Integer({ minimum: 0 })),
  workflow: Type.Optional(NonEmptyString),
  metadata: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
}, { additionalProperties: false });
export interface WorkerRequest {
  readonly task: string;
  readonly role?: string;
  readonly capabilities: readonly string[];
  readonly access: WorkerAccessMode;
  readonly preferredCli?: WorkerAdapterId;
  readonly allowFallback: boolean;
  readonly cwd: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly retentionMs?: number;
  readonly workflow?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export const WorkerFailureSchema = Type.Object({
  code: NonEmptyString,
  message: NonEmptyString,
  retryable: Type.Boolean(),
  details: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
}, { additionalProperties: false });
export interface WorkerFailure { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: Readonly<Record<string, JsonValue>>; }

export const WorkerStatusFileSchema = Type.Object({
  schemaVersion: Type.Literal(WORKER_SCHEMA_VERSION),
  jobId: JobIdSchema,
  state: Type.Union(WORKER_STATES.map((state) => Type.Literal(state))),
  progress: Type.Optional(Type.String({ maxLength: 4_096 })),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: Type.Optional(TimestampSchema),
  completedAt: Type.Optional(TimestampSchema),
  resultPath: Type.Optional(NonEmptyString),
  failure: Type.Optional(WorkerFailureSchema),
}, { additionalProperties: false });
export interface WorkerStatusFile {
  readonly schemaVersion: typeof WORKER_SCHEMA_VERSION;
  readonly jobId: string;
  readonly state: WorkerState;
  readonly progress?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly resultPath?: string;
  readonly failure?: WorkerFailure;
}

export const WorkspaceLeaseSchema = Type.Object({
  mode: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  sourcePath: NonEmptyString,
  workspacePath: NonEmptyString,
  owningJobId: JobIdSchema,
  kind: Type.Union([Type.Literal("readonly-bind"), Type.Literal("git-worktree"), Type.Literal("copy")]),
  dirty: Type.Boolean(),
  cleanupEligible: Type.Boolean(),
  baseRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
  createdAt: TimestampSchema,
}, { additionalProperties: false });
export interface WorkspaceLease {
  readonly mode: WorkerAccessMode;
  readonly sourcePath: string;
  readonly workspacePath: string;
  readonly owningJobId: string;
  readonly kind: "readonly-bind" | "git-worktree" | "copy";
  readonly dirty: boolean;
  readonly cleanupEligible: boolean;
  readonly baseRevision?: string;
  readonly createdAt: string;
}

export const WorkerJobSchema = Type.Object({
  schemaVersion: Type.Literal(WORKER_SCHEMA_VERSION),
  id: JobIdSchema,
  request: WorkerRequestSchema,
  state: Type.Union(WORKER_STATES.map((state) => Type.Literal(state))),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: Type.Optional(TimestampSchema),
  completedAt: Type.Optional(TimestampSchema),
  selectedAdapter: Type.Optional(Type.Union(WORKER_ADAPTERS.map((id) => Type.Literal(id)))),
  tmuxSession: Type.Optional(NonEmptyString),
  workspace: Type.Optional(WorkspaceLeaseSchema),
  mailboxPath: NonEmptyString,
  ownerId: NonEmptyString,
  runId: Type.Optional(RunIdSchema),
  parentSessionId: Type.Optional(NonEmptyString),
  parentRunId: Type.Optional(RunIdSchema),
  childIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
  launchContractDigest: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  failure: Type.Optional(WorkerFailureSchema),
  cleanupDeadline: Type.Optional(TimestampSchema),
}, { additionalProperties: false });
export interface WorkerJob {
  readonly schemaVersion: typeof WORKER_SCHEMA_VERSION;
  readonly id: string;
  readonly request: WorkerRequest;
  readonly state: WorkerState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly selectedAdapter?: WorkerAdapterId;
  readonly tmuxSession?: string;
  readonly workspace?: WorkspaceLease;
  readonly mailboxPath: string;
  readonly ownerId: string;
  readonly runId?: string;
  readonly parentSessionId?: string;
  readonly parentRunId?: string;
  readonly childIndex?: number;
  readonly depth?: number;
  readonly launchContractDigest?: string;
  readonly failure?: WorkerFailure;
  readonly cleanupDeadline?: string;
}

export interface AdapterProbeResult {
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly sandboxSupported: boolean;
  readonly capabilities: readonly string[];
  readonly reason?: string;
}

export interface ScreenRecognition {
  readonly state: "starting" | "ready" | "running" | "blocked" | "terminal";
  readonly promptId?: string;
  readonly detail?: string;
}

export interface AdapterPromptContext {
  readonly jobId: string;
  readonly task: string;
  readonly mailboxPath: string;
}

export interface AdapterAuthBinding { readonly hostPath: string; readonly guestPath: string; }

export interface WorkerAdapter {
  readonly id: WorkerAdapterId;
  readonly executable: string;
  probe(request: WorkerRequest, signal?: AbortSignal): Promise<AdapterProbeResult>;
  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]];
  buildPrompt(context: AdapterPromptContext): string;
  recognizeScreen(screen: string): ScreenRecognition;
  answerPrompt(recognition: ScreenRecognition, context: { readonly confinementActive: boolean }): string | undefined;
  interrupt(context: AdapterRuntimeContext): Promise<void>;
  readonly completionHelper?: "pi-extension" | "mailbox-instructions";
  readonly runtimeReadOnlyPaths?: readonly string[];
  authBindings?(): readonly AdapterAuthBinding[];
  sandboxEnvironment?(): Readonly<Record<string, string>>;
}

export interface AdapterLaunchContext {
  readonly confinementActive: true;
  readonly executablePath: string;
  readonly job: WorkerJob;
  readonly workspacePath: string;
  readonly mailboxPath: string;
  readonly homePath: string;
  readonly model?: string;
  readonly interactiveArgs: readonly string[];
}

export interface AdapterRuntimeContext {
  readonly jobId: string;
  readonly tmuxSession: string;
  readonly signal?: AbortSignal;
}

export interface WorkerAdapterConfig {
  readonly enabled: boolean;
  readonly model?: string;
  readonly interactiveArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly recognizedResponses: Readonly<Record<string, string>>;
}

export interface WorkerCapabilityCeiling {
  readonly allowedAdapters: readonly WorkerAdapterId[];
  readonly maxAccess: WorkerAccessMode;
  readonly allowedCapabilities: readonly string[];
  readonly maxDepth: number;
  readonly maxActiveWorkers: number;
  readonly maxSpawnsPerRun: number;
  readonly maxSpawnsPerSession: number;
}

export interface WorkerWorkflowConfig {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly retentionMs?: number;
  readonly routingOrder?: readonly WorkerAdapterId[];
  readonly allowFallback?: boolean;
  readonly capabilityCeiling?: Partial<WorkerCapabilityCeiling>;
}

export interface WorkerConfig {
  readonly schemaVersion: typeof WORKER_SCHEMA_VERSION;
  readonly routingOrder: readonly WorkerAdapterId[];
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly retentionMs: number;
  readonly allowFallback: boolean;
  readonly maxModelOutputBytes: number;
  readonly maxModelOutputLines: number;
  readonly maxActiveWorkers: number;
  readonly maxSpawnsPerRun: number;
  readonly maxSpawnsPerSession: number;
  readonly adapters: Readonly<Record<WorkerAdapterId, WorkerAdapterConfig>>;
  readonly workflows: Readonly<Record<string, WorkerWorkflowConfig>>;
  readonly capabilityCeiling: WorkerCapabilityCeiling;
  readonly sandbox: {
    readonly requireBubblewrap: boolean;
    readonly allowCopiedNonGitWrites: boolean;
    readonly authReadOnlyPaths: readonly string[];
  };
}

export interface WorkerInvocationOverrides extends WorkerWorkflowConfig {
  readonly preferredCli?: WorkerAdapterId;
}

export interface ResolvedWorkerPolicy {
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly retentionMs: number;
  readonly routingOrder: readonly WorkerAdapterId[];
  readonly allowFallback: boolean;
  readonly source: Readonly<Record<"concurrency" | "timeoutMs" | "retentionMs" | "routingOrder" | "allowFallback", "invocation" | "workflow" | "global">>;
}

export function createWorkerId(): string { return `wrk_${randomUUID()}`; }
export function createWorkerRunId(): string { return `run_${randomUUID()}`; }
export function isTerminalWorkerState(state: WorkerState): state is TerminalWorkerState {
  return (TERMINAL_WORKER_STATES as readonly string[]).includes(state);
}
