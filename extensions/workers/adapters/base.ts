import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";

import { assertInteractiveModelArgv } from "../enforcement.ts";
import type { AdapterAuthBinding, AdapterLaunchContext, AdapterProbeResult, AdapterPromptContext, AdapterRuntimeContext, ScreenRecognition, WorkerAdapter, WorkerAdapterId, WorkerRequest } from "../types.ts";

export interface InteractiveAdapterOptions {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly recognizedResponses?: Readonly<Record<string, string>>;
  readonly interrupt?: (session: string, signal?: AbortSignal) => Promise<void>;
}

export interface ScreenPattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly response?: string;
}

export interface AdapterDefinition {
  readonly id: WorkerAdapterId;
  readonly executable: string;
  readonly environmentKeys: readonly string[];
  readonly credentialBindings: (home: string) => readonly AdapterAuthBinding[];
  readonly capabilities: readonly string[];
  readonly readyPatterns: readonly RegExp[];
  readonly runningPatterns: readonly RegExp[];
  readonly blockedPatterns: readonly ScreenPattern[];
  readonly fatalPatterns: readonly RegExp[];
  readonly completionHelper: "pi-extension" | "mailbox-instructions";
}

export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

async function credentialFileHasData(path: string): Promise<boolean> {
  try {
    const info = await stat(path); if (!info.isFile() || info.size === 0) return false;
    const content = (await readFile(path, "utf8")).trim(); if (!content) return false;
    try {
      const parsed = JSON.parse(content);
      return Boolean(parsed && typeof parsed === "object" && Object.keys(parsed as object).length > 0);
    } catch { return true; }
  } catch { return false; }
}

export function externalMailboxInstructions(context: AdapterPromptContext): string {
  return [
    context.task,
    "",
    "---",
    "MANDATORY WORKER COMPLETION CONTRACT",
    `Job ID: ${context.jobId}`,
    `Mailbox: ${context.mailboxPath}`,
    "The pane is diagnostic only. Before ending, you MUST make the mailbox authoritative:",
    `1. Write your complete final answer as plain text to ${context.mailboxPath}/answer.txt.`,
    `2. Run: node ${context.mailboxPath}/complete.mjs ${context.mailboxPath}/answer.txt`,
    `3. If the task fails, run: node ${context.mailboxPath}/complete.mjs --fail task_failed 'a clear explanation'`,
    "The helper atomically writes result.md and strict status.json. Do not invent status JSON or timestamps yourself.",
    "Do not use pane output as the result channel. Do not finish until the helper succeeds.",
  ].join("\n");
}

export abstract class InteractiveAdapter implements WorkerAdapter {
  readonly id: WorkerAdapterId;
  readonly executable: string;
  readonly completionHelper: "pi-extension" | "mailbox-instructions";
  readonly runtimeReadOnlyPaths?: readonly string[];
  protected readonly definition: AdapterDefinition;
  protected readonly environment: Readonly<Record<string, string | undefined>>;
  protected readonly homeDirectory: string;
  protected readonly responses: Readonly<Record<string, string>>;
  private readonly interruptHandler?: (session: string, signal?: AbortSignal) => Promise<void>;

  constructor(definition: AdapterDefinition, options: InteractiveAdapterOptions = {}, runtimeReadOnlyPaths?: readonly string[]) {
    this.definition = definition; this.id = definition.id; this.executable = options.executable ?? definition.executable;
    this.completionHelper = definition.completionHelper; this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir(); this.responses = Object.freeze({ ...(options.recognizedResponses ?? {}) });
    this.interruptHandler = options.interrupt; this.runtimeReadOnlyPaths = runtimeReadOnlyPaths ? Object.freeze([...runtimeReadOnlyPaths]) : undefined;
  }

  authBindings(): readonly AdapterAuthBinding[] { return Object.freeze(this.definition.credentialBindings(this.homeDirectory).filter((binding) => existsSync(binding.hostPath))); }

  sandboxEnvironment(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.definition.environmentKeys.flatMap((key) => this.environment[key]?.trim() ? [[key, this.environment[key]!.trim()]] : [])));
  }

  async probe(_request: WorkerRequest, signal?: AbortSignal): Promise<AdapterProbeResult> {
    signal?.throwIfAborted();
    const environmentAuth = this.definition.environmentKeys.some((key) => Boolean(this.environment[key]?.trim()));
    let fileAuth = false;
    for (const binding of this.authBindings()) {
      signal?.throwIfAborted();
      if (await credentialFileHasData(binding.hostPath)) { fileAuth = true; break; }
    }
    const authenticated = environmentAuth || fileAuth;
    return Object.freeze({ available: true, authenticated, sandboxSupported: true, capabilities: this.definition.capabilities, ...(authenticated ? {} : { reason: `${this.id} authentication was not found in configured environment or credential files` }) });
  }

  abstract buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]];

  protected validateArgv(argv: readonly [string, ...string[]], resolvedExecutable?: string): readonly [string, ...string[]] {
    assertInteractiveModelArgv(argv, this.id, resolvedExecutable); return Object.freeze([...argv]) as readonly [string, ...string[]];
  }

  buildPrompt(context: AdapterPromptContext): string {
    return this.completionHelper === "mailbox-instructions" ? externalMailboxInstructions(context) : context.task;
  }

  recognizeScreen(screen: string): ScreenRecognition {
    const clean = stripTerminalControl(screen);
    const fatal = this.definition.fatalPatterns.find((pattern) => pattern.test(clean));
    if (fatal) return Object.freeze({ state: "blocked", detail: "Provider reported an authentication, startup, or sandbox error" });
    for (const prompt of this.definition.blockedPatterns) {
      if (prompt.pattern.test(clean)) return Object.freeze({ state: "blocked", promptId: prompt.id, detail: `Recognized ${this.id} prompt: ${prompt.id}` });
    }
    if (/(?:\?|confirm|proceed).*?(?:\[y\/n\]|\(y\/n\)|yes\/no)|Press Enter to continue|select (?:an?|the) option/i.test(clean))
      return Object.freeze({ state: "blocked", detail: `Unrecognized ${this.id} interactive prompt; refusing to guess a response` });
    if (this.definition.readyPatterns.some((pattern) => pattern.test(clean))) return Object.freeze({ state: "ready" });
    if (this.definition.runningPatterns.some((pattern) => pattern.test(clean))) return Object.freeze({ state: "running" });
    return Object.freeze({ state: "starting" });
  }

  answerPrompt(recognition: ScreenRecognition, context: { readonly confinementActive: boolean }): string | undefined {
    if (context.confinementActive !== true || recognition.state !== "blocked" || !recognition.promptId) return undefined;
    if (Object.hasOwn(this.responses, recognition.promptId)) return this.responses[recognition.promptId];
    return this.definition.blockedPatterns.find((prompt) => prompt.id === recognition.promptId)?.response;
  }

  async interrupt(context: AdapterRuntimeContext): Promise<void> {
    context.signal?.throwIfAborted();
    if (!this.interruptHandler) throw new Error(`${this.id} adapter interrupt transport is not configured`);
    await this.interruptHandler(context.tmuxSession, context.signal);
  }
}
